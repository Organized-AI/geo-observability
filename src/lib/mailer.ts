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
  const from = (env.EMAIL_FROM ?? "").trim();
  const binding = env.EMAIL as unknown as SendEmailBinding | undefined;
  if (from && env.EMAIL_MODE !== "resend" && binding && typeof binding.send === "function") return "cloudflare";
  if (from && env.RESEND_API_KEY) return "resend";
  return "none";
}

export async function sendMail(env: Env, mail: Mail, fetcher: typeof fetch = fetch): Promise<void> {
  const kind = mailerKind(env);
  const from = { email: (env.EMAIL_FROM ?? "").trim(), name: env.EMAIL_FROM_NAME || env.APP_NAME || "GEO Observability" };
  switch (kind) {
    case "outbox":
      await env.DB.prepare("INSERT INTO email_outbox (id, to_email, subject, text) VALUES (?1, ?2, ?3, ?4)").bind(newId("eml"), mail.to, mail.subject, mail.text).run();
      return;
    case "cloudflare":
      try {
        await (env.EMAIL as unknown as SendEmailBinding).send({ to: mail.to, from, subject: mail.subject, text: mail.text, html: mail.html });
      } catch (e) {
        const code = (e as { code?: string })?.code ?? "";
        console.error("email send failed", code, String((e as Error)?.message ?? e));
        throw new HttpError(502, "email_failed", "We couldn't send the email just now. Try again in a minute.");
      }
      return;
    case "resend": {
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      });
      if (!res.ok) {
        console.error("resend failed", res.status, (await res.text()).slice(0, 300));
        throw new HttpError(502, "email_failed", "We couldn't send the email just now. Try again in a minute.");
      }
      return;
    }
    default:
      throw new HttpError(503, "email_off", "Email sign-in isn't set up on this site yet.");
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function signInMail(appName: string, to: string, link: string, intro: string): Mail {
  const text = `${intro}\n\nSign in to ${appName}:\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<p>${esc(intro)}</p><p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#3a49d6;color:#fff;border-radius:8px;text-decoration:none">Sign in to ${esc(appName)}</a></p><p style="color:#666;font-size:13px">The link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>`;
  return { to, subject: `Your sign-in link for ${appName}`, text, html };
}
