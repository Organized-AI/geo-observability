// Local development without a Cloudflare login: same Worker, minus the Workers AI binding (always remote).
// The judge, onboarding drafts and briefs fall back to their rules/templates; engines without keys use the stub.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
const cfg = JSON.parse(strip(readFileSync("wrangler.jsonc", "utf8")).replace(/,(\s*[}\]])/g, "$1"));
delete cfg.ai;
delete cfg.env;
cfg.main = "../src/index.ts";
cfg.assets.directory = "../public";
cfg.d1_databases[0].migrations_dir = "../migrations";
cfg.vars = { ...cfg.vars, ENVIRONMENT: "development", DEMO_MODE: "true" };
delete cfg.$schema;
mkdirSync(".tmp", { recursive: true });
writeFileSync(".tmp/wrangler.offline.json", JSON.stringify(cfg, null, 2));
const args = ["wrangler", "dev", "-c", ".tmp/wrangler.offline.json", "--persist-to", ".wrangler/state", ...process.argv.slice(2)];
spawn("npx", args, { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
