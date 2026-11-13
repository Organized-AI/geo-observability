/**
 * Outgoing email for sign-in links and receipts of signup.
 *
 * Order: Cloudflare Email Service (the `EMAIL` send_email binding, sending from EMAIL_FROM on a domain onboarded
 * to Email Service) → Resend (RESEND_API_KEY) → in development with EMAIL_MODE=outbox, the D1 email_outbox table.
 */
import type { Env } from "../env";
import { HttpError, newId } from "./util";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface SendEmailBinding {
  send(message: { to: string; from: string | { email: string; name?: string }; subject: string; text?: string; html?: string }): Promise<{ messageId: string }>;
}

export type MailerKind = "cloudflare" | "resend" | "outbox" | "none";

export function mailerKind(env: Env): MailerKind {
  if (env.ENVIRONMENT === "development" && env.EMAIL_MODE === "outbox") return "outbox";
  const from = parseFrom(env).email;
  const binding = env.EMAIL as unknown as SendEmailBinding | undefined;
  if (from && env.EMAIL_MODE !== "resend" && binding && typeof binding.send === "function") return "cloudflare";
  if (from && env.RESEND_API_KEY) return "resend";
  return "none";
}

/** EMAIL_FROM may be a bare address or "Name <address>"; Email Service wants the address and the name apart. */
export function parseFrom(env: Env): { email: string; name: string } {
  const raw = (env.EMAIL_FROM ?? "").trim().replace(/^["']+|["']+$/g, "");
  const m = raw.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  const email = (m ? m[2] : raw).trim().toLowerCase();
  const name = (m && m[1].trim().replace(/^["']+|["']+$/g, "")) || env.EMAIL_FROM_NAME || env.APP_NAME || "GEO Observability";
  return { email, name };
}

/** What to fix, in words, for each Email Service error code (and Resend's status codes). */
export function emailFailureReason(code: string, fromDomain: string): string {
  const d = fromDomain || "the EMAIL_FROM domain";
  switch (code) {
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return `${d} isn't onboarded to Cloudflare Email Service. Onboard it under Email Service > Email Sending.`;
    case "E_SENDER_NOT_VERIFIED":
      return `${d} is onboarded but not verified yet. Check its DNS records in Email Service > Email Sending.`;
    case "E_RECIPIENT_NOT_ALLOWED":
      return "The EMAIL binding is limited to certain recipients (allowed_destination_addresses).";
    case "E_RECIPIENT_SUPPRESSED":
      return "That address is on the Email Service suppression list.";
    case "E_ACCOUNT_SUSPENDED":
      return "Cloudflare has paused sending on this account.";
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return "The sending limit was reached. Try again later.";
    case "E_VALIDATION_ERROR":
    case "E_FIELD_MISSING":
      return "EMAIL_FROM isn't a valid address. Set it to something like signin@yourdomain.com.";
    case "E_DELIVERY_FAILED":
      return "The recipient's mail server refused the message.";
    case "resend_401":
    case "resend_403":
      return "Resend rejected the API key or the sending domain isn't verified in Resend.";
    case "resend_422":
      return "Resend rejected the message: the EMAIL_FROM domain must be verified in Resend.";
    default:
      return "The email provider refused the message.";
  }
}

async function logEmail(env: Env, row: { to: string; provider: MailerKind; status: "sent" | "failed"; code?: string | null; detail?: string | null; messageId?: string | null }) {
  try {
    await env.DB.prepare("INSERT INTO email_log (id, to_email, provider, status, code, detail, message_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(newId("eml"), row.to, row.provider, row.status, row.code ?? null, (row.detail ?? "").slice(0, 300) || null, row.messageId ?? null)
      .run();
  } catch (e) {
    console.error("email log", String((e as Error)?.message ?? e)); // table missing until migration 0005 runs
  }
}

function failed(env: Env, code: string, fromEmail: string): HttpError {
  const domain = fromEmail.split("@")[1] ?? "";
  return new HttpError(502, "email_failed", `We couldn't send the email: ${emailFailureReason(code, domain)} (${code || "unknown"})`);
}

export async function sendMail(env: Env, mail: Mail, fetcher?: typeof fetch): Promise<void> {
  const kind = mailerKind(env);
  const from = parseFrom(env);
  switch (kind) {
    case "outbox":
      await env.DB.prepare("INSERT INTO email_outbox (id, to_email, subject, text) VALUES (?1, ?2, ?3, ?4)").bind(newId("eml"), mail.to, mail.subject, mail.text).run();
      await logEmail(env, { to: mail.to, provider: kind, status: "sent" });
      return;
    case "cloudflare": {
      try {
        const r = await (env.EMAIL as unknown as SendEmailBinding).send({ to: mail.to, from, subject: mail.subject, text: mail.text, html: mail.html });
        console.log("email sent", "cloudflare", r?.messageId ?? "");
        await logEmail(env, { to: mail.to, provider: kind, status: "sent", messageId: r?.messageId ?? null });
      } catch (e) {
        const code = String((e as { code?: string })?.code ?? "");
        const detail = String((e as Error)?.message ?? e);
        console.error("email send failed", "cloudflare", code, detail);
        await logEmail(env, { to: mail.to, provider: kind, status: "failed", code, detail });
        throw failed(env, code, from.email);
      }
      return;
    }
    case "resend": {
      const send = fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
      let res: Response;
      try {
        res = await send("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        });
      } catch (e) {
        const detail = String((e as Error)?.message ?? e);
        console.error("email send failed", "resend", "network", detail);
        await logEmail(env, { to: mail.to, provider: kind, status: "failed", code: "network", detail });
        throw failed(env, "network", from.email);
      }
      const body = await res.text();
      if (!res.ok) {
        const code = `resend_${res.status}`;
        console.error("email send failed", "resend", res.status, body.slice(0, 300));
        await logEmail(env, { to: mail.to, provider: kind, status: "failed", code, detail: body });
        throw failed(env, code, from.email);
      }
      let id: string | null = null;
      try {
        id = (JSON.parse(body) as { id?: string }).id ?? null;
      } catch {
        /* not json */
      }
      await logEmail(env, { to: mail.to, provider: kind, status: "sent", messageId: id });
      return;
    }
    default:
      await logEmail(env, { to: mail.to, provider: kind, status: "failed", code: "email_off" });
      throw new HttpError(503, "email_off", "Email sign-in isn't set up on this site yet: set EMAIL_FROM (and onboard its domain to Cloudflare Email Service, or add RESEND_API_KEY).");
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function signInMail(appName: string, to: string, link: string, intro: string): Mail {
  const text = `${intro}\n\nSign in to ${appName}:\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<p>${esc(intro)}</p><p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#3a49d6;color:#fff;border-radius:8px;text-decoration:none">Sign in to ${esc(appName)}</a></p><p style="color:#666;font-size:13px">The link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>`;
  return { to, subject: `Your sign-in link for ${appName}`, text, html };
}
