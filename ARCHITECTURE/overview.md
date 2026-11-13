# Architecture

```
+------------------------------ CLIENT PORTAL (Worker Assets, Workers Paid) ----------------------------+
|  /app  dashboards . filters (engine, country, topic, tag, date) . chats . sources + gaps . prompts     |
|        competitors . My website (Pages table) . actions + briefs . insights . perception . setup       |
|  /     landing page (GSAP)        /docs  50-page user guide        /api/shared/:token  read-only view  |
|  auth: Cloudflare Access JWT -> users -> memberships (owner/editor/viewer); agency sees all tenants    |
+--------------------------------------------------+---------------------------------------------------+
                                                   |
        /api (portal)   /api/v1 (X-API-Key)   /mcp (Bearer key, JSON-RPC)   /ingest/* (ingest key)
                                                   |
+---------------------------------- CONTROL PLANE: D1 + KV ----------------------------------------------+
|  tenants . users . memberships . api_keys . projects . brand_profiles . brands(aliases, regex, domains) |
|  topics . personas . prompts(country, intent, branded, tags) . project_models . project_countries       |
+--------------------------------------------------+---------------------------------------------------+
                                                   |  Cron 06:00 UTC (daily; weekly on Mondays)
                                                   v  onboarding "finish" and "Run now" start a pass too
                    planPass: active prompts x enabled engines, within plan limits
                    -> runs rows (queued) -> RunProgress DO (live progress) -> Queue
                                                   |
                                                   v  consumer: one Workflow per prompt x engine x country x day
   +--------------------------- RunPromptWorkflow ------------------------------------+
   | preflight: tenant active . billing gate . monthly spend cap                       |
   | ask engine  ---->  AI GATEWAY (cf-aig-metadata: tenant, project, prompt, engine,  |
   |                    run; logs, cost, latency, spend limits, OTel)                  |
   |                    ChatGPT  Responses + web_search                                |
   |                    Claude   Messages + web_search tool                            |
   |                    Gemini   generateContent + google_search                       |
   |                    Perplexity Sonar                                               |
   |                    Alexa    unavailable (no public answer API)                    |
   |                    stub     when a provider key is missing (labelled)             |
   | store raw answer -> R2 tenants/{id}/runs/{day}/{run}.json                         |
   | score: deterministic mentions + rank  ->  Workers AI judge (sentiment, new brands,|
   |        attributes, objections, claims vs brand facts); rules fallback             |
   | persist: runs . mentions . citations(cited|used) . fanout_queries . claims        |
   |          domain_classes . usage_events (billing hook) . VIS_EVENTS (Analytics Eng)|
   +-----------------------------------------------------------------------------------+
                                                   |
            hourly cron: daily_brand_metrics rollups . usage_pushes aggregation . PRAGMA optimize
            09:00 cron:  InsightsWorkflow -> insights (3-5 sentences, evidence) + ranked actions
                                                   |
 ======================== OBSERVABILITY LAYER =============================================
   Client zone on Cloudflare        Any site                     Server-side conversions
   edge/ tap Worker (route)         tap.js beacon                sGTM . GA4 . Google Ads . Meta
   AI bots (training/search/user)   AI-referred page views       TikTok . Shopify  (event_id dedupe)
   + AI-referred arrivals                  |                              |
        |  /ingest/edge                    |  /ingest/hit                 |  /ingest/conversion
        v                                  v                              v
   crawl_daily . referral_daily . conversion_daily . TRAFFIC_EVENTS (Analytics Engine)
        |
        v   JOIN ON PATH + DAY with citations of the client's own domains
   Pages table: citations . citation rate . bot hits . retrievals . sessions . conversions . revenue
               . the prompts whose answers cited each page   -> insights (crawl drop, referral/conversion moves)
 =========================================================================================
   BILLING (hooks only): usage_events -> usage_pushes (identifier tenant:meter:hour) . billing_accounts.status gates runs
```

## Metric definitions
- **Visibility**: answers naming the brand ÷ answers in the filter.
- **Share of voice**: the brand's mentions ÷ mentions of all tracked brands in those answers.
- **Position**: average rank when named (1 = named first).
- **Sentiment**: 0–100 per mention (50 neutral), averaged.
- **Win rate**: in answers naming at least two tracked brands, the share where the brand is named first among them.
- **Cited rate**: answers citing one of the brand's domains ÷ answers.
