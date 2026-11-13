/**
 * Edge tap: deploy on a client's own Cloudflare zone route (e.g. example.com/*).
 * Every request passes through untouched. After the response is on its way, AI crawler hits and
 * AI-referred arrivals are batched to the GEO Observability ingest endpoint. No cookies, IPs or
 * query strings are sent: only path, user agent, referrer host, status, country and utm_source.
 */
import { classifyBot, classifyReferral } from "../../src/observability/classify";

interface Env {
  INGEST_URL: string; // https://<portal-host>/ingest/edge
  PROJECT_ID: string;
  INGEST_KEY: string; // secret: an API key with scope "ingest"
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await fetch(request);
    try {
      const ua = request.headers.get("user-agent");
      const referer = request.headers.get("referer");
      const url = new URL(request.url);
      const utm = url.searchParams.get("utm_source");
      const isPage = request.method === "GET" && !/\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|map|mp4|webm)$/i.test(url.pathname);
      const bot = classifyBot(ua);
      const assistant = !bot && isPage ? classifyReferral(referer, utm) : null;
      if ((bot || assistant) && env.INGEST_URL && env.INGEST_KEY) {
        let refHost = "";
        try {
          refHost = referer ? `https://${new URL(referer).hostname}/` : "";
        } catch {
          /* ignore */
        }
        const event = {
          ts: new Date().toISOString(),
          host: url.hostname,
          path: url.pathname,
          ua: bot ? ua : undefined,
          referer: refHost || undefined,
          status: response.status,
          country: (request as Request & { cf?: { country?: string } }).cf?.country,
          utm_source: utm ?? undefined,
        };
        ctx.waitUntil(
          fetch(env.INGEST_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-ingest-key": env.INGEST_KEY },
            body: JSON.stringify({ project_id: env.PROJECT_ID, events: [event] }),
          }).catch(() => undefined),
        );
      }
    } catch {
      /* the tap must never break the client's site */
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
