// Visibility Pass onboarding. The pass is issued by POST /api/pass and kept in this browser.
const STORAGE = "geo-visibility-pass-v1";
const $ = (id) => document.getElementById(id);

const TEST_PROMPT = `Run a GEO Observability pass test with the geo-observability tools. Do not change anything.

1. Call list_projects and use the first project.
2. Call brand_report for the last 14 days with dimensions ["engine"].
3. Call top_sources for the same range.
4. Reply with one table: brand, visibility, share of voice, average position, sentiment.
   Then list the top three cited domains and say which engine names the own brand most often.

Stop after the table. Use only read tools.`;

const state = { pass: null, agent: "claude-desktop", code: "curl", busy: false };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) || "null");
  } catch {
    return null;
  }
}

function save(pass) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(pass));
  } catch {
    // storage blocked; the page still works for this visit
  }
}

function clear() {
  try {
    localStorage.removeItem(STORAGE);
  } catch {
    // ignore
  }
  state.pass = null;
}

async function api(path, options = {}) {
  const response = await fetch((window.__GEO_BASE__ || "") + path, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setStatus(text) {
  $("pass-sub").textContent = text;
}

function showError(message) {
  $("pass-error").hidden = false;
  $("pass-error").textContent = message;
  $("pass-body").hidden = true;
}

function clearError() {
  $("pass-error").hidden = true;
  $("pass-error").textContent = "";
  $("pass-body").hidden = false;
}

async function issue() {
  if (state.busy) return;
  state.busy = true;
  clearError();
  setStatus("Creating your pass…");
  $("api-key").textContent = "…";
  $("mcp-url").textContent = "…";
  try {
    const pass = await api("/api/pass", { method: "POST" });
    state.pass = pass;
    save(pass);
    render();
  } catch (error) {
    if (error.status === 404 || error.status === 503) {
      showError("Passes aren't open right now. You can still explore the read-only demo.");
      setStatus("Passes are closed");
      for (const id of ["connect", "test", "code"]) {
        const section = document.getElementById(id);
        if (section) section.hidden = true;
      }
    } else {
      showError(error.message || "Could not create a pass. Try again in a moment.");
      setStatus("Could not create a pass");
    }
  } finally {
    state.busy = false;
  }
}

async function refresh() {
  if (!state.pass?.api_key) return;
  try {
    const fresh = await api("/api/pass/me", { headers: { "x-api-key": state.pass.api_key } });
    if (fresh.days_left <= 0) {
      clear();
      await issue();
      return;
    }
    state.pass = { ...state.pass, ...fresh };
    save(state.pass);
    render();
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      clear();
      await issue();
    }
  }
}

async function newPass() {
  if (state.busy) return;
  state.busy = true;
  setStatus("Retiring the old pass…");
  try {
    if (state.pass?.api_key) {
      await api("/api/pass/revoke", { method: "POST", headers: { "x-api-key": state.pass.api_key } }).catch(() => null);
    }
  } finally {
    clear();
    state.busy = false;
    await issue();
  }
}

function block(id, text) {
  return `<div class="block"><pre id="${id}">${esc(text)}</pre><button type="button" class="copy" data-copy-target="${id}">Copy</button></div>`;
}

function tabs(container, items, active, onSelect) {
  container.innerHTML = items
    .map((item) => `<button type="button" class="tab" role="tab" aria-selected="${item.id === active}" data-tab="${item.id}">${esc(item.label)}</button>`)
    .join("");
  for (const button of container.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => onSelect(button.dataset.tab));
  }
}

const AGENTS = [
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
  { id: "grok", label: "Grok Bot" },
  { id: "dots", label: "Dots" },
  { id: "hermes", label: "Hermes" },
  { id: "any", label: "Any agent" },
];

function renderAgent() {
  const pass = state.pass;
  if (!pass) return;
  const panel = $("agent-panel");
  const id = `agent-${state.agent}`;
  if (state.agent === "claude-desktop") {
    panel.innerHTML =
      `<p>Open <strong>Customize → Connectors → Add custom connector</strong>. Name it <strong>GEO Observability</strong> and paste this as the server URL. If it asks how to sign in, choose <strong>No sign-in</strong>.</p>` +
      block(id, pass.mcp_url);
  } else if (state.agent === "claude-code") {
    panel.innerHTML =
      `<p>Add the server from your terminal, then run <code>claude mcp list</code> to check it.</p>` +
      block(id, `claude mcp add --transport http geo-observability "${pass.mcp_url}"`);
  } else if (state.agent === "codex") {
    panel.innerHTML =
      `<p>Add this to your Codex MCP configuration, then restart the session.</p>` +
      block(id, `[mcp_servers.geo-observability]\nurl = "${pass.mcp_url}"`);
  } else if (state.agent === "any") {
    panel.innerHTML =
      `<p>Any client that speaks remote MCP over streamable HTTP can use this URL. No header is needed; the pass is in the URL.</p>` +
      block(id, JSON.stringify({ mcpServers: { "geo-observability": { url: pass.mcp_url } } }, null, 2));
  } else {
    panel.innerHTML =
      `<p>Add a remote MCP server named <strong>geo-observability</strong> with this URL. The pass is in the URL, so no header is needed.</p>` +
      block(id, pass.mcp_url);
  }
}

function renderCode() {
  const pass = state.pass;
  if (!pass) return;
  const panel = $("code-panel");
  const id = `code-${state.code}`;
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  const project = pass.project_id || "<project_id>";
  if (state.code === "curl") {
    panel.innerHTML = block(
      id,
      `export GEO_API="${pass.api_url}"\nexport GEO_KEY="${pass.api_key}"\n\ncurl -s "$GEO_API/projects" \\\n  -H "x-api-key: $GEO_KEY"\n\ncurl -s -X POST "$GEO_API/reports/brands" \\\n  -H "x-api-key: $GEO_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"project_id":"${project}","dimensions":["engine"],"start_date":"${start}","end_date":"${end}"}'`,
    );
  } else if (state.code === "javascript") {
    panel.innerHTML = block(
      id,
      `const api = "${pass.api_url}";\nconst key = "${pass.api_key}";\n\nconst projects = await fetch(\`\${api}/projects\`, {\n  headers: { "x-api-key": key },\n}).then((r) => r.json());\n\nconsole.log(projects);`,
    );
  } else if (state.code === "python") {
    panel.innerHTML = block(
      id,
      `import requests\n\nAPI = "${pass.api_url}"\nKEY = "${pass.api_key}"\n\nprojects = requests.get(\n    f"{API}/projects",\n    headers={"x-api-key": KEY},\n).json()\nprint(projects)`,
    );
  } else {
    panel.innerHTML =
      `<p>Point any MCP client at this URL. The pass is embedded, so no header or sign-in is needed.</p>` +
      block(id, pass.mcp_url);
  }
}

function renderUsage() {
  const pass = state.pass;
  const remaining = pass.remaining || { api: pass.limits?.api ?? 0, mcp: pass.limits?.mcp ?? 0 };
  const days = pass.days_left ?? 0;
  const chips = [
    { text: `${remaining.api} API calls left`, low: remaining.api < 20 },
    { text: `${remaining.mcp} MCP calls left`, low: remaining.mcp < 5 },
    { text: `${days} day${days === 1 ? "" : "s"} left`, low: days < 2 },
  ];
  $("usage").innerHTML = chips.map((chip) => `<span data-low="${chip.low}">${esc(chip.text)}</span>`).join("");
}

function wireAgentTabs() {
  tabs($("agent-tabs"), AGENTS, state.agent, (id) => {
    state.agent = id;
    wireAgentTabs();
    renderAgent();
  });
}

function wireCodeTabs() {
  const codeTabs = [
    { id: "curl", label: "curl" },
    { id: "javascript", label: "JavaScript" },
    { id: "python", label: "Python" },
    { id: "mcp", label: "MCP" },
  ];
  tabs($("code-tabs"), codeTabs, state.code, (id) => {
    state.code = id;
    wireCodeTabs();
    renderCode();
  });
}

function render() {
  const pass = state.pass;
  if (!pass) return;
  clearError();
  for (const id of ["connect", "test", "code"]) {
    const section = document.getElementById(id);
    if (section) section.hidden = false;
  }
  setStatus(`${pass.project_name || "Demo workspace"} · read-only demo · ${pass.tenant_slug || "demo"}`);
  $("api-key").textContent = pass.api_key;
  $("mcp-url").textContent = pass.mcp_url;
  $("playground").href = pass.playground_url || "/app/?tenant=demo";
  renderUsage();
  wireAgentTabs();
  renderAgent();
  wireCodeTabs();
  renderCode();
}

async function copyText(text) {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 800)),
    ]);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-target]");
  if (!button) return;
  const target = document.getElementById(button.dataset.copyTarget);
  if (!target) return;
  const original = button.textContent;
  button.textContent = "Copied";
  copyText(target.textContent || "");
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
});

$("new-pass").addEventListener("click", newPass);
$("try-now").addEventListener("click", () => {
  $("test").scrollIntoView({ behavior: "smooth", block: "start" });
  $("test").focus?.();
});

$("test-prompt").textContent = TEST_PROMPT;

(async function boot() {
  const saved = read();
  if (saved?.api_key && saved?.mcp_url) {
    state.pass = saved;
    render();
    await refresh();
  } else {
    await issue();
  }
})();
