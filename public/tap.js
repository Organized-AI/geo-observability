/*! GEO Observability tap.js: counts visits that arrive from AI assistants. No cookies, no IDs. */
(function () {
  try {
    var s = document.currentScript;
    if (!s) return;
    var key = s.getAttribute("data-key"), project = s.getAttribute("data-project");
    if (!key || !project) return;
    var ref = document.referrer || "";
    var utm = new URLSearchParams(location.search).get("utm_source") || "";
    var ai = /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|meta\.ai|grok\.com|chat\.deepseek\.com|chat\.mistral\.ai|you\.com|phind\.com)$/i;
    var host = "";
    try { host = ref ? new URL(ref).hostname : ""; } catch (e) {}
    var fromAi = (host && ai.test(host)) || /chatgpt|openai|claude|anthropic|perplexity|gemini|copilot|grok|deepseek|mistral/i.test(utm);
    if (!fromAi) return;
    var key2 = "geo_tap_" + location.pathname;
    try { if (sessionStorage.getItem(key2)) return; sessionStorage.setItem(key2, "1"); } catch (e) {}
    var endpoint = new URL("/ingest/hit", s.src).toString();
    var body = JSON.stringify({ k: key, p: project, url: location.origin + location.pathname, ref: host ? "https://" + host + "/" : "", utm: utm });
    if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
    else fetch(endpoint, { method: "POST", body: body, keepalive: true, mode: "no-cors" });
  } catch (e) {}
})();
