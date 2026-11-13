// Builds the demo workspace SQL. With a path argument it writes that file (creating its folder);
// without one it prints to stdout. Usage: npm run seed:demo (remote) or npm run seed:demo:local.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

mkdirSync(".tmp", { recursive: true });
await build({ entryPoints: ["scripts/demo/generate.ts"], bundle: true, platform: "node", format: "esm", outfile: ".tmp/demo-generate.mjs", logLevel: "error" });
const { generate } = await import(pathToFileURL(".tmp/demo-generate.mjs").href);
const sql = generate(Number(process.env.DEMO_DAYS ?? 30));
const out = process.argv[2];
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sql);
} else {
  process.stdout.write(sql);
}
