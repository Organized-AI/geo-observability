// Lightweight checks that need no extra dependencies: syntax of browser JS, no secrets, no stray debug.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
let failed = 0;
const fail = (m) => { console.error(`✗ ${m}`); failed++; };

for (const f of walk("public").filter((f) => f.endsWith(".js") && !f.includes("/vendor/"))) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch { try { execFileSync(process.execPath, ["--input-type=module", "--check"], { input: readFileSync(f), stdio: "pipe" }); } catch (e) { fail(`${f}: ${String(e.stderr || e).split("\n")[0]}`); } }
}
const secret = /(sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const f of [...walk("src"), ...walk("public").filter((f) => !f.includes("/vendor/")), ...walk("scripts"), ...walk("edge/src")]) {
  const t = readFileSync(f, "utf8");
  if (secret.test(t)) fail(`${f}: looks like a secret`);
  if (f.startsWith("src") && /\bdebugger\b/.test(t)) fail(`${f}: debugger statement`);
}
if (failed) process.exit(1);
console.log("lint ok");
