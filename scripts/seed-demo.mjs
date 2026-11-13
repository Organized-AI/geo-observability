// Writes the demo workspace SQL to stdout. Usage: npm run seed:demo (remote) or npm run seed:demo:local.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

mkdirSync(".tmp", { recursive: true });
await build({ entryPoints: ["scripts/demo/generate.ts"], bundle: true, platform: "node", format: "esm", outfile: ".tmp/demo-generate.mjs", logLevel: "error" });
const { generate } = await import(pathToFileURL(".tmp/demo-generate.mjs").href);
process.stdout.write(generate(Number(process.env.DEMO_DAYS ?? 30)));
