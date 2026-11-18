// Local development without a Cloudflare login: omit remote AI and email bindings.
// The judge, onboarding drafts and briefs fall back to their rules/templates; engines without keys use the stub.
import { spawn } from "node:child_process";
import { writeLocalConfig } from "./local-config.mjs";

const config = writeLocalConfig(".tmp/wrangler.offline.json");
const args = ["wrangler", "dev", "-c", config, "--persist-to", ".wrangler/state", ...process.argv.slice(2)];
spawn("npx", args, { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
