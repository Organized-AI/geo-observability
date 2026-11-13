#!/usr/bin/env node
/**
 * Deploy one environment the same way from CI and from a laptop.
 *
 *   node scripts/deploy.mjs staging                 (npm run deploy:staging)
 *   node scripts/deploy.mjs production              (npm run deploy:production; the release workflow runs this)
 *   node scripts/deploy.mjs staging --dry-run       checks and bundle only, nothing applied
 *   options: --url <base>   where to check /healthz afterwards (default: SMOKE_URL, else the environment's public_url)
 *
 * Steps: config checks (no placeholder ids, staging shares nothing with production) → version check → docs build →
 * D1 migrations → wrangler deploy, with the Worker version tagged (vX.Y.Z on a release tag, vX.Y.Z+<sha> otherwise) and
 * APP_VERSION / GIT_COMMIT set → /healthz must report that version and commit.
 *
 * Migrations run before the new code, so a migration must keep the running version working (add columns and tables,
 * don't rename or drop in the same release). Rolling back the Worker does not roll back D1.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const argv = process.argv.slice(2);
const target = argv[0];
const dryRun = argv.includes("--dry-run");
const urlArg = argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : undefined;

const environments = JSON.parse(readFileSync(join(ROOT, "infra/environments.json"), "utf8")).environments;
if (!environments[target]) fail(`usage: node scripts/deploy.mjs <${Object.keys(environments).join("|")}> [--dry-run] [--url <base>]`);
const wranglerEnv = environments[target].wrangler_env;
const envFlag = wranglerEnv ? ["--env", wranglerEnv] : [];

function fail(msg) {
  console.error(`\ndeploy stopped: ${msg}`);
  process.exit(1);
}

function run(cmd, args, { capture = false } = {}) {
  console.log(`\n$ ${[cmd.replace(ROOT + "/", ""), ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (r.status !== 0) fail(`${cmd.split("/").pop()} ${args[0] ?? ""} exited with ${r.status}`);
  if (capture) process.stdout.write(r.stdout);
  return r.stdout ?? "";
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
}

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const commit = (process.env.GITHUB_SHA || git(["rev-parse", "HEAD"]) || "unknown").slice(0, 7);
const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
const onTag = git(["tag", "--points-at", "HEAD"]).split("\n").includes(`v${version}`) || process.env.GITHUB_REF === `refs/tags/v${version}`;
const tag = onTag && !dirty ? `v${version}` : `v${version}+${commit}${dirty ? ".dirty" : ""}`;

if (target === "production" && !onTag) {
  console.log(`\nNote: HEAD is not tagged v${version}. This deploys an untagged build (${tag}). Releases normally ship from a tag (DOCUMENTATION/gitops.md).`);
}
if (target === "production" && dirty && !dryRun) fail("uncommitted changes; commit or stash them before deploying production");

run(process.execPath, ["scripts/infra.mjs", "check", "--strict", target]);
run(process.execPath, ["scripts/version.mjs", "check"]);
run("npm", ["run", "build:docs"]);

const message = `${tag} ${target} ${process.env.GITHUB_ACTIONS ? `by GitHub Actions run ${process.env.GITHUB_RUN_ID}` : "from a local checkout"}`.slice(0, 100);
const vars = ["--var", `APP_VERSION:${version}`, "--var", `GIT_COMMIT:${commit}`];

if (dryRun) {
  run(WRANGLER, ["deploy", ...envFlag, "--dry-run", "--outdir", `.tmp/dist-${target}`, ...vars]);
  summary(`Dry run for ${target} passed (${tag}). Nothing was migrated or deployed.`);
  process.exit(0);
}

const db = (await import("wrangler")).unstable_readConfig({ config: join(ROOT, "wrangler.jsonc"), env: wranglerEnv || undefined }, { hideWarnings: true }).d1_databases[0].database_name;
run(WRANGLER, ["d1", "migrations", "apply", db, "--remote", ...envFlag]);
const out = run(WRANGLER, ["deploy", ...envFlag, "--tag", tag, "--message", message, ...vars], { capture: true });
const versionId = out.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1] ?? "";
summary(`Deployed ${target}: ${tag}${versionId ? ` (Worker version ${versionId})` : ""}`);

const base = (urlArg || process.env.SMOKE_URL || environments[target].public_url || out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] || "").replace(/\/$/, "");
if (!base) {
  summary("Smoke test skipped: no URL (pass --url or set SMOKE_URL).");
  process.exit(0);
}
let last = "";
for (let i = 0; i < 12; i++) {
  try {
    const res = await fetch(`${base}/healthz`, { headers: { "cache-control": "no-cache" } });
    const body = res.ok ? await res.json() : null;
    last = body ? JSON.stringify(body) : `HTTP ${res.status}`;
    if (body?.ok && body.version === version && body.commit === commit) {
      summary(`Smoke test passed: ${base}/healthz reports ${version} (${commit}).`);
      process.exit(0);
    }
  } catch (err) {
    last = err.message;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
fail(`${base}/healthz did not report ${version} (${commit}) within a minute; last answer: ${last}. Roll back with: npx wrangler rollback ${envFlag.join(" ")}`.trim());
