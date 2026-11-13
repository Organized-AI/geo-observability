# API contract

The portal (`public/app`) talks only to these endpoints. All bodies are JSON unless noted.
Dates are `YYYY-MM-DD` (UTC). Money is in **micros** (1 USD = 1,000,000 micros).

## Auth and tenant selection

- Portal calls (`/api/*` except `/api/v1/*` and `/api/shared/*`) are authenticated by Cloudflare Access
  (`Cf-Access-Jwt-Assertion`). With `DEMO_MODE=true`, unauthenticated visitors get the demo tenant **read-only**.
- Tenant: header `X-Tenant: <slug|id>` or query `?tenant=`. Default is the user's first tenant.
- Write calls by a viewer, or in demo mode, return `403 {"error":"read_only"}`.
- Errors: `{ "error": "<code>", "message": "<human text>" }` with a 4xx/5xx status.

## Common report filters (query string)

`from`, `to` (default last 14 days), `engine` (csv of `chatgpt,claude,gemini,perplexity,alexa`),
`country` (csv ISO-2), `topic` (csv topic ids), `tag` (csv tags). The previous period is the same
length immediately before `from`.

## Session

| Method | Path | Returns |
|---|---|---|
| GET | `/api/me` | `{ user:{email,name,is_agency}, tenants:[{id,name,slug,role}], tenant:{id,name,slug,role,plan,limits:{prompts,projects,models,countries}}, demo:bool, read_only:bool, billing:{provider,status,banner} }` |
| GET | `/api/engines` | `[{ id, label, vendor, available, channel:'api'|'stub'|'unavailable', note }]` |
| GET | `/api/usage` | `{ month, answers_run, llm_cost_micros, spend_cap_micros, by_engine:[{engine,answers,cost_micros}], billing:{provider:'none',status} }` |
| GET/POST | `/api/keys` | list `[{id,name,prefix,scope,created_at,last_used_at}]` / create `{name,scope:'read'|'ingest'}` → `{id, secret}` (secret shown once) |
| DELETE | `/api/keys/:id` | `{ok:true}` |

## Projects and setup

| Method | Path | Body / Returns |
|---|---|---|
| GET | `/api/projects` | `[{id,name,domain,schedule,onboarding_step,created_at}]` |
| POST | `/api/projects` | `{name,domain}` → project |
| GET | `/api/projects/:pid` | `{project, profile:{what_you_sell,buyers,markets:[{country,language}],facts:[]}, counts:{prompts,brands,topics,runs}}` |
| PATCH | `/api/projects/:pid` | `{name?, schedule?:'daily'|'weekly'|'paused', onboarding_step?}` |
| PUT | `/api/projects/:pid/profile` | `{what_you_sell,buyers,markets,facts}` |
| POST | `/api/projects/:pid/onboarding/profile` | drafts a profile from the domain → profile (not saved until PUT) |
| POST | `/api/projects/:pid/onboarding/topics` | → `{topics:[{id,name,status:'suggested'}]}` (saved as suggested) |
| POST | `/api/projects/:pid/onboarding/prompts` | `{count=10, branded_share=0.2, intent_mix:{informational:.25,commercial:.5,transactional:.25}, country='US', language='en', topic_ids?}` → `{prompts:[prompt]}` saved as `suggested` |
| POST | `/api/projects/:pid/onboarding/finish` | runs the first pass now → `{queued}` |
| GET | `/api/projects/:pid/progress` | `{total, done, failed, running}` for the latest pass |
| POST | `/api/projects/:pid/run` | queue a pass now → `{queued}` |
| GET/POST | `/api/projects/:pid/topics` | `[{id,name,status}]` / `{name}` |
| PATCH/DELETE | `/api/projects/:pid/topics/:id` | `{name?,status?}` |
| GET | `/api/projects/:pid/prompts?status=` | `[{id,text,country,language,intent,branded,volume,tags:[],status,topic_id,topic}]` |
| POST | `/api/projects/:pid/prompts` | `{text,country?,topic_id?,tags?,intent?,branded?}` |
| POST | `/api/projects/:pid/prompts/import` | body `text/csv`: `prompt,country,topic,tag1,tag2,...` → `{imported, errors:[{line,message}]}` |
| PATCH/DELETE | `/api/projects/:pid/prompts/:id` | `{status?,text?,tags?,topic_id?,intent?,branded?}` |
| GET | `/api/projects/:pid/brands` | `[{id,name,aliases:[],domains:[],socials:[],regex,is_own,status,color}]` (`status` = active|suggested|rejected) |
| POST | `/api/projects/:pid/brands` | `{name,aliases?,domains?,is_own?}` |
| PATCH/DELETE | `/api/projects/:pid/brands/:id` | any brand field |
| GET/PUT | `/api/projects/:pid/models` | `[{engine,label,enabled,available,channel,note}]` / `{engines:['chatgpt',...]}` |
| GET/PUT | `/api/projects/:pid/countries` | `{countries:['US',...]}` |

## Reports

| Method | Path | Returns |
|---|---|---|
| GET | `/api/projects/:pid/overview` | see shape below |
| GET | `/api/projects/:pid/chats?…&mentioned=own|not_own&limit=50&cursor=` | `{items:[{run_id,prompt_id,prompt,engine,model,country,run_date,channel,mentions:[{brand_id,brand_name,rank,sentiment}],citations_count,excerpt}], next_cursor}` |
| GET | `/api/projects/:pid/chats/:runId` | `{run, prompt, answer_text, mentions:[], citations:[{url,domain,title,kind,position}], fanout:[{query,kind}], claims:[{claim,verdict,kind}]}` |
| GET | `/api/projects/:pid/sources/domains?…&gap=1` | `{items:[{domain,type,citations,answers,share,mentions_own,competitors:[name]}]}`; `gap=1` keeps domains that appear in answers naming a competitor but not you |
| GET | `/api/projects/:pid/sources/urls?…&domain=` | `{items:[{url,domain,title,citations,answers,cited,used,first_seen,last_seen}]}` |
| GET | `/api/projects/:pid/prompts/performance?…` | `{items:[{prompt_id,text,topic,visibility,position,sentiment,answers,best_engine,worst_engine}]}` |
| GET | `/api/projects/:pid/website/pages?from&to` | `{items:[{path,bot_hits,training_hits,search_hits,retrievals,citations,cited_answers,citation_rate,sessions,conversions,revenue_micros,prompts:[{prompt_id,text,citations}]}], totals:{…same numeric keys}}` |
| GET | `/api/projects/:pid/website/crawlers?from&to` | `{by_bot:[{bot,operator,bot_type,hits}], trend:[{day,bot_type,hits}]}` |
| GET | `/api/projects/:pid/website/referrals?from&to` | `{by_assistant:[{assistant,sessions,conversions,revenue_micros}], trend:[{day,assistant,sessions}]}` |
| GET | `/api/projects/:pid/perception` | `{attributes:[{text,count}], objections:[{text,count}], facts:[{claim,verdict,count}]}` |
| GET | `/api/projects/:pid/insights?from&to` | `{items:[{id,day,kind,severity,text,evidence}]}` |
| GET | `/api/projects/:pid/actions?status=` | `{items:[{id,kind,title,detail,impact,status,evidence,created_at,done_at}]}` |
| PATCH | `/api/projects/:pid/actions/:id` | `{status}` |
| POST | `/api/projects/:pid/actions/:id/brief` | → `{brief}` Markdown content brief (generated once, then cached) |
| GET/POST | `/api/projects/:pid/views` | `[{id,name,filters,layout}]` / `{name,filters,layout}` |
| DELETE | `/api/projects/:pid/views/:id` | |
| POST | `/api/projects/:pid/views/:id/share` | `{days=30}` → `{url, expires_at}` |
| GET | `/api/shared/:token` | no auth: `{view, project:{name,domain}, overview}` |
| GET | `/api/projects/:pid/export/chats.csv?…` | CSV |
| GET | `/api/projects/:pid/export/metrics.csv?…` | CSV |
| GET | `/api/projects/:pid/tracking` | `{ingest_endpoint, tap_snippet, edge_worker:{repo_path,vars}, sgtm:{endpoint,headers}}` |

### Overview shape

```json
{
  "range": {"from":"2026-10-31","to":"2026-11-13","prev_from":"2026-10-17","prev_to":"2026-10-30"},
  "own_brand_id": "br_…",
  "kpis": {
    "visibility":     {"value":0.42,"prev":0.38},
    "share_of_voice": {"value":0.21,"prev":0.19},
    "position":       {"value":2.4,"prev":2.9},
    "sentiment":      {"value":68,"prev":66},
    "win_rate":       {"value":0.35,"prev":0.31},
    "cited_rate":     {"value":0.12,"prev":0.10},
    "answers":        {"value":560,"prev":540}
  },
  "trend": [{"day":"2026-11-01","brand_id":"br_…","visibility":0.4,"share_of_voice":0.2,"position":2.5,"sentiment":67}],
  "leaderboard": [{"brand_id":"…","name":"…","is_own":true,"color":"#…","visibility":0.42,"share_of_voice":0.21,"position":2.4,"sentiment":68,"win_rate":0.35}],
  "by_engine": [{"engine":"chatgpt","label":"ChatGPT","visibility":0.5,"answers":140}],
  "top_sources": [{"domain":"…","type":"editorial","citations":40,"answers":31,"share":0.06}],
  "recent_chats": [{"run_id":"…","prompt":"…","engine":"claude","country":"US","run_date":"…","mentioned":true,"rank":2,"excerpt":"…"}],
  "insights": [{"id":"…","kind":"visibility_move","severity":2,"text":"…","evidence":{}}],
  "actions": [{"id":"…","kind":"get_listed","title":"…","impact":3,"status":"open"}]
}
```

Rates are 0..1. Position is the average rank when named (lower is better). Sentiment is 0..100.

## Public API (X-API-Key, scope `read`)

`GET /api/v1/projects`, `GET /api/v1/prompts?project_id=`, `GET /api/v1/chats?project_id=&from&to`,
`POST /api/v1/reports/brands|domains|urls` with
`{project_id, start_date, end_date, dimensions:['date'|'engine'|'country'|'topic'|'prompt'], filters:[{field,operator:'in'|'not_in',values:[]}], order_by:[{field,direction:'asc'|'desc'}], limit, offset, compare_previous}`.
Rate limit: 120 requests per minute per key (KV token bucket).

## MCP

`POST /mcp` (JSON-RPC 2.0, streamable HTTP, `Authorization: Bearer <read key>`). Tools: `list_projects`,
`brand_report`, `list_chats`, `get_chat`, `top_sources`, `list_insights`, `list_actions`, `website_pages`.

## Ingest (observability layer)

Key: an API key with scope `ingest`, in `X-Ingest-Key` or `?k=`.

| Path | Body |
|---|---|
| `POST /ingest/edge` | `{project_id, events:[{ts,host,path,ua,referer,status,country,utm_source}]}` from the edge tap Worker |
| `POST /ingest/hit` | `text/plain` JSON from `tap.js`: `{k,p,url,ref,utm}` |
| `POST /ingest/conversion` | `{project_id, events:[{event_id,event_name,ts,landing_path,assistant?,referrer?,utm_source?,value?,currency?,source}]}` (sGTM, server pulls) |

## Additions after the first draft
- `POST /api/tenants` (agency staff only, before any workspace exists): `{name, slug?, email_domain?, plan?}`.
- `POST /api/projects/:pid/onboarding/competitors` → `{brands:[…status:'suggested']}`.
- `onboarding_step` accepts a step name or an index `0`–`6`; `7` or `done` means finished.
- `status: "rejected"` on a prompt deletes a suggestion (or archives a prompt with history); on a topic it deletes it.
- Public API responses: lists are `{data}`, reports are `{data, total}`.
