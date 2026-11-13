/* Applies the saved theme before first paint and wires any [data-theme-toggle] button. */
(function () {
  var KEY = "oa-theme";
  var root = document.documentElement;
  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ } }
  function systemDark() { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
  function current() { var t = root.getAttribute("data-theme"); return t || (systemDark() ? "dark" : "light"); }
  var saved = read();
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

  function label(btn) {
    var dark = current() === "dark";
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
  }
  function wire() {
    var btns = document.querySelectorAll("[data-theme-toggle]");
    Array.prototype.forEach.call(btns, function (btn) {
      if (btn.__wired) return;
      btn.__wired = true;
      label(btn);
      btn.addEventListener("click", function () {
        var next = current() === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        write(next);
        Array.prototype.forEach.call(document.querySelectorAll("[data-theme-toggle]"), label);
        document.dispatchEvent(new CustomEvent("themechange", { detail: next }));
      });
    });
  }
  window.oaWireTheme = wire;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
