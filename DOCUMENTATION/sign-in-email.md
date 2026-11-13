# Sign-in email

Signup at `/signup/` is public. People sign in at `/login/` with a link we email them: single-use, 15 minutes, stored only as a SHA-256 hash. Using it sets an HttpOnly, Secure, SameSite=Lax session cookie for 30 days. Sign-in emails are rate-limited (5 per email and 20 per IP an hour; signups 10 per IP an hour).

## Sending through Cloudflare Email Service (default)

The Worker has a `send_email` binding named `EMAIL` (in `wrangler.jsonc`). Cloudflare Email Service sends only from a domain onboarded to it, and a `workers.dev` address can't be a sender.

1. Cloudflare dashboard → **Email** → **Email Service** (public beta) → onboard a domain you own, e.g. `organizedai.vip`, and add the DNS records it asks for.
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
