// The same Worker bindings as deployment, with remote-only services removed for local verification.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writeLocalConfig(filename) {
  const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
  const cfg = JSON.parse(strip(readFileSync("wrangler.jsonc", "utf8")).replace(/,(\s*[}\]])/g, "$1"));
  delete cfg.ai;
  delete cfg.send_email;
  delete cfg.env;
  delete cfg.routes;
  delete cfg.route;
  delete cfg.$schema;
  // Generated configs live in .tmp, one directory below the project root.
  cfg.main = "../src/index.ts";
  cfg.assets.directory = "../public";
  for (const db of cfg.d1_databases) db.migrations_dir = "../migrations";
  cfg.vars = { ...cfg.vars, ENVIRONMENT: "development", APP_URL: "", DEMO_MODE: "true", EMAIL_MODE: "outbox" };
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(cfg, null, 2));
  return filename;
}
