import type { RunProgress } from "./durable/progress";

export interface Env {
  // bindings
  ASSETS: Fetcher;
  AI: Ai;
  DB: D1Database;
  ANSWERS: R2Bucket;
  CONFIG: KVNamespace;
  RUNS: Queue<RunJob>;
  RUN_PROMPT: Workflow<RunJob>;
  INSIGHTS: Workflow<InsightsJob>;
  PROGRESS: DurableObjectNamespace<RunProgress>;
  EMAIL?: unknown; // Cloudflare Email Service send_email binding
  VIS_EVENTS?: AnalyticsEngineDataset;
  TRAFFIC_EVENTS?: AnalyticsEngineDataset;

  // vars
  ENVIRONMENT: string;
  APP_NAME: string;
  AI_GATEWAY_ID: string;
  DEMO_MODE?: string;
  DEMO_TENANT_SLUG?: string;
  JUDGE_MODEL: string;
  OPENAI_MODEL: string;
  ANTHROPIC_MODEL: string;
  GEMINI_MODEL: string;
  PERPLEXITY_MODEL: string;
  BILLING_GRACE_DAYS?: string;
  STRIPE_AUTOMATIC_TAX?: string; // "true" turns on Stripe Tax in Checkout; off by default
  STRIPE_LIVE_MODE?: string; // must be "true" before a live key is accepted
  APP_URL?: string; // public address (origin + optional base path) for links, Stripe returns and sign-in emails
  EMAIL_FROM?: string; // sender address on a domain onboarded to Cloudflare Email Service (or verified at Resend)
  EMAIL_FROM_NAME?: string;
  EMAIL_MODE?: string; // "resend" to skip the Cloudflare binding; "outbox" (development only) writes to D1 instead of sending

  // secrets (all optional: missing provider keys fall back to the labelled stub engine)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
  AIG_UNIFIED_BILLING?: string; // "true" when AI Gateway pays providers and no provider keys are set
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  SHARE_LINK_SECRET?: string;
  OTEL_EXPORTER_URL?: string;
  OTEL_EXPORTER_HEADERS?: string; // JSON object of extra headers, e.g. {"Authorization":"Basic ..."}
  STRIPE_SECRET_KEY?: string; // sk_test_… until live billing is approved
  STRIPE_WEBHOOK_SECRET?: string; // whsec_… for /webhooks/stripe
  STRIPE_BILLING_CONFIG?: string; // JSON from scripts/stripe-setup.mjs (price and meter ids)
  RESEND_API_KEY?: string; // fallback email provider when the Cloudflare binding isn't usable
  DEV_AUTH_EMAIL?: string; // local development only; ignored unless ENVIRONMENT is "development"
  AGENCY_EMAILS?: string; // comma-separated emails that see every tenant (agency staff)
}

/** One prompt × engine × country × day. The id doubles as the Workflow instance id, so re-queuing is idempotent. */
export interface RunJob {
  runId: string;
  tenantId: string;
  projectId: string;
  promptId: string;
  engine: string;
  country: string;
  runDate: string;
  passId: string;
}

export interface InsightsJob {
  tenantId: string;
  projectId: string;
  day: string;
}
