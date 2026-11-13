# Sign-in email

Signup at `/signup/` is public. People sign in at `/login/` with a link we email them: single-use, 15 minutes, stored only as a SHA-256 hash. Using it sets an HttpOnly, Secure, SameSite=Lax session cookie for 30 days. Sign-in emails are rate-limited (5 per email and 20 per IP an hour; signups 10 per IP an hour).

## Sending through Cloudflare Email Service (default)

The Worker has a `send_email` binding named `EMAIL` (in `wrangler.jsonc`). Cloudflare Email Service sends only from a domain onboarded to it, and a `workers.dev` address can't be a sender.

1. Cloudflare dashboard → **Compute** → **Email Service** → **Email Sending** → **Onboard Domain**, and pick a domain you own, e.g. `organizedai.vip`. The domain must use Cloudflare DNS. Cloudflare adds the records itself (MX, SPF and DKIM on `cf-bounce`, DMARC on `_dmarc`); wait until the domain shows as verified.
2. Set the sender:
   ```bash
   npx wrangler secret put EMAIL_FROM          # e.g. sign-in@organizedai.vip
   npx wrangler secret put EMAIL_FROM_NAME     # optional, e.g. GEO Observability
   ```
3. Deploy. `/login/` now sends links.

## Fallback: Resend

If you'd rather not use Email Service, verify a sending domain at Resend and:
```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM          # an address on the domain you verified at Resend
npx wrangler secret put EMAIL_MODE          # type: resend
```

Without `EMAIL_FROM` and a working sender, `/auth/login` answers "Email sign-in isn't set up on this site yet", and signup still works (people come back signed in from Stripe) but can't sign in again on another device.

## When emails don't arrive

Every send is logged in the D1 `email_log` table with the provider's error code, and failures now show where they happen: the `/login/` form, the signup page, and a banner after Checkout. Owners also get a **Sign-in email** card on Usage & API with the last result and a **Send me a test email** button.

```bash
npx wrangler d1 execute geo-observability --remote --command "SELECT created_at, provider, status, code, detail FROM email_log ORDER BY created_at DESC LIMIT 5"
npx wrangler tail geo-observability     # shows "email send failed <code>" live
```

| Code | Fix |
|---|---|
| `E_SENDER_DOMAIN_NOT_AVAILABLE` | Onboard the EMAIL_FROM domain in Email Sending. |
| `E_SENDER_NOT_VERIFIED` | The domain's DNS records aren't verified yet. |
| `E_VALIDATION_ERROR` | EMAIL_FROM isn't a valid address (`Name <addr>` is fine too). |
| `E_RECIPIENT_SUPPRESSED` | The address bounced or complained before; remove it from the suppression list. |
| `resend_401` / `resend_403` / `resend_422` | Resend key or domain problem. |

If the log says `sent` but nothing arrives, check spam: a newly onboarded domain has no sending reputation yet.

## Local development

`EMAIL_MODE=outbox` in `.dev.vars` writes emails to the D1 `email_outbox` table instead of sending them (only when `ENVIRONMENT=development`):
```bash
npx wrangler d1 execute geo-observability --local --persist-to .wrangler/state --command "SELECT to_email, text FROM email_outbox ORDER BY created_at DESC LIMIT 1"
```

## How accounts are protected
- A sign-in link opens a page with a button; only the button (a POST) uses the link, so mail scanners can't burn it.
- Returning from Stripe Checkout opens a session only for a brand-new signup whose payment Stripe confirms, once per Checkout. That session is marked unconfirmed until the emailed link is used, and an unconfirmed session never joins workspaces by email domain.
- Signing up with an email that already has an account doesn't touch that account: we email it a sign-in link instead.
- Requests that change things and carry the session cookie must come from the site's own origin.
