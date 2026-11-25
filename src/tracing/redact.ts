/**
 * Removes things that look like secrets from captured text. The same rules run in geo-trace.mjs before a turn leaves
 * the machine; running them again here covers other senders. Keep the two lists in step (a test checks they match).
 */
export const SECRET_RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer", /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ["url-password", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi],
  ["assignment", /(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi],
];

export function redact(text: string): string {
  let out = text;
  for (const [name, re] of SECRET_RULES) {
    out = out.replace(re, (...m: string[]) => {
      // Rules with a kept prefix (and suffix) put them in groups 1 and 2.
      const g1 = typeof m[1] === "string" && m.length > 3 ? m[1] : "";
      const g2 = typeof m[2] === "string" && m.length > 4 ? m[2] : "";
      return `${g1}${g1 && name === "bearer" ? " " : ""}[redacted:${name}]${g2}`;
    });
  }
  return out;
}
