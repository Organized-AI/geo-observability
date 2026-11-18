// Read-only deployment gate. No provider calls, emails, signups or payments are created.
const origin = process.argv[2];
if (!origin || !/^https?:\/\//.test(origin)) throw new Error('Usage: node scripts/readiness.mjs https://your-app [--require-live-billing]');
const base = origin.replace(/\/$/, '');
const failures = [];
async function json(path) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
try {
  const health = await json('/healthz');
  if (health.ok !== true) failures.push('Health endpoint is not healthy');
  console.log(`Deployment: ${health.version ?? 'unknown'} (${health.commit ?? 'unknown'}), ${health.env}`);
  const engines = await json('/api/engines');
  for (const id of ['chatgpt', 'claude', 'gemini', 'perplexity']) {
    const e = engines.find(e => e.id === id);
    if (e?.channel !== 'api') failures.push(`${id}: ${e?.note ?? 'not configured'}`);
  }
  const signup = await json('/api/signup');
  if (!signup.open) failures.push(`Signup closed: ${signup.setup_problem}`);
  if (!signup.email_ready) failures.push('Sign-in email is not configured');
  console.log(`Billing: ${signup.billing_mode ?? 'unknown'}; delivery and checkout still require an end-to-end test`);
  if (process.argv.includes('--require-live-billing') && signup.billing_mode !== 'live') failures.push('Live billing is not enabled or cannot be verified');
  const pass = await fetch(base + '/pass/', { signal: AbortSignal.timeout(15000) });
  if (!pass.ok || !(await pass.text()).includes('/pass/pass.js')) failures.push('Agent-pass page is missing or serving a fallback');
} catch (e) { failures.push(e.message); }
for (const failure of failures) console.error(`FAIL: ${failure}`);
if (failures.length) process.exitCode = 1;
else console.log('Configuration checks passed. Verify a real provider run, email login and checkout before customer use.');
