// Hand-rolled SVG charts: line, horizontal bars, sparkline, donut.
import { h, s, clear, fmt, debounce } from "./dom.js";
import { drawLines, growBars, fadeIn } from "./anim.js";

export const seriesColor = (i) => `var(--series-${(i % 7) + 1})`;

function niceStep(range, count) {
  const raw = range / count || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// series: [{name, color, values: {day: number}}]; days: sorted day strings.
export function lineChart(host, opts) {
  host.classList.add("chart");
  const { series, days, yFormat = (v) => String(v), invert = false, height = 240, label = "Line chart", clamp01 = false } = opts;
  let drawnW = 0;
  const tip = h("div", { class: "chart-tip", hidden: true, role: "presentation" });

  function render(animate) {
    clear(host);
    const W = Math.max(260, Math.round(host.clientWidth || 640));
    drawnW = W;
    const H = height;
    const m = { t: 14, r: 16, b: 28, l: 52 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = series.flatMap((se) => days.map((d) => se.values[d])).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (!vals.length || !days.length) { host.append(h("p", { class: "chart-empty" }, "No data in this range yet.")); return; }
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (invert) { lo = Math.max(1, Math.floor(lo)); hi = Math.ceil(hi); if (hi <= lo) hi = lo + 1; }
    else { lo = Math.min(0, lo); if (hi <= lo) hi = lo + 1; }
    const step = niceStep(hi - lo, 4);
    lo = invert ? lo : Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    if (clamp01 && hi > 1) hi = Math.max(1, Math.ceil(Math.max(...vals) / step) * step);
    const ticks = [];
    for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(+v.toFixed(6));
    const xAt = (i) => m.l + (days.length === 1 ? iw / 2 : (i * iw) / (days.length - 1));
    const yAt = (v) => { const r = (v - lo) / (hi - lo || 1); return invert ? m.t + r * ih : m.t + ih - r * ih; };

    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": label, class: "chart-svg" });
    const grid = s("g", { class: "chart-grid" });
    for (const t of ticks) {
      const y = yAt(t);
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: y, y2: y }), s("text", { x: m.l - 8, y: y + 4, "text-anchor": "end", class: "chart-axis" }, yFormat(t)));
    }
    const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(iw / 74))));
    days.forEach((d, i) => {
      if (i % every !== 0 && i !== days.length - 1) return;
      if (i !== days.length - 1 && days.length - 1 - i < every * 0.6) return;
      grid.append(s("text", { x: xAt(i), y: H - 8, "text-anchor": i === 0 && days.length > 1 ? "start" : i === days.length - 1 && days.length > 1 ? "end" : "middle", class: "chart-axis" }, fmt.date(d)));
    });
    svg.append(grid);

    const paths = [];
    const dotsG = s("g");
    series.forEach((se) => {
      let d = "", pen = false;
      days.forEach((day, i) => {
        const v = se.values[day];
        if (typeof v !== "number" || !Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
        pen = true;
      });
      if (!d) return;
      const p = s("path", { d, fill: "none", class: ["chart-line", se.own && "is-own"], style: `stroke:${se.color}` });
      paths.push(p);
      svg.append(p);
      const present = days.filter((day) => typeof se.values[day] === "number");
      if (present.length === 1) dotsG.append(s("circle", { cx: xAt(days.indexOf(present[0])), cy: yAt(se.values[present[0]]), r: 3.5, style: `fill:${se.color}` }));
    });
    svg.append(dotsG);

    const rule = s("line", { class: "chart-rule", y1: m.t, y2: m.t + ih, x1: -10, x2: -10 });
    const hoverDots = s("g");
    const overlay = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", class: "chart-overlay" });
    svg.append(rule, hoverDots, overlay);
    const move = (clientX) => {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * W;
      const i = days.length === 1 ? 0 : Math.max(0, Math.min(days.length - 1, Math.round(((px - m.l) / iw) * (days.length - 1))));
      const x = xAt(i);
      rule.setAttribute("x1", x); rule.setAttribute("x2", x);
      clear(hoverDots); clear(tip);
      tip.append(h("p", { class: "chart-tip-day" }, fmt.dateLong(days[i])));
      const rows = series.map((se) => ({ se, v: se.values[days[i]] })).filter((r) => typeof r.v === "number");
      rows.sort((a, b) => (invert ? a.v - b.v : b.v - a.v));
      for (const { se, v } of rows) {
        hoverDots.append(s("circle", { cx: x, cy: yAt(v), r: 4, class: "chart-hover-dot", style: `fill:${se.color}` }));
        tip.append(h("p", { class: "chart-tip-row" }, h("span", { class: "dot", style: { background: se.color } }), h("span", { class: "chart-tip-name" }, se.name), h("span", { class: "num" }, yFormat(v))));
      }
      tip.hidden = false;
      const left = (x / W) * box.width;
      tip.style.left = `${Math.min(Math.max(8, left + 12), box.width - tip.offsetWidth - 8)}px`;
      if (left + 12 + tip.offsetWidth > box.width - 8) tip.style.left = `${Math.max(8, left - tip.offsetWidth - 12)}px`;
    };
    overlay.addEventListener("pointermove", (e) => move(e.clientX));
    overlay.addEventListener("pointerleave", () => { tip.hidden = true; clear(hoverDots); rule.setAttribute("x1", -10); rule.setAttribute("x2", -10); });
    host.append(svg, tip);
    if (animate) { drawLines(paths); fadeIn(Array.from(dotsG.children), 0.6); }
  }

  render(true);
  if (host._ro) host._ro.disconnect(); // a redraw on the same host replaces the old observer
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(debounce(() => {
      if (!host.isConnected) { ro.disconnect(); return; }
      if (Math.abs((host.clientWidth || 0) - drawnW) > 4) render(false);
    }, 120));
    ro.observe(host);
    host._ro = ro;
  }
  return host;
}

export function legend(series) {
  return h("ul", { class: "legend" }, series.map((se) =>
    h("li", { class: se.own ? "is-own" : null }, h("span", { class: "dot", style: { background: se.color } }), se.name)));
}

// items: [{label (string|Node), value, color?, display?}]
export function bars(items, opts = {}) {
  const max = opts.max ?? Math.max(0, ...items.map((i) => i.value || 0));
  const format = opts.format || ((v) => fmt.int(v));
  const fills = [];
  const el = h("div", { class: "hbars", role: "list" }, items.map((it, i) => {
    const w = max > 0 ? Math.max(0, Math.min(100, ((it.value || 0) / max) * 100)) : 0;
    const fill = s("rect", { x: 0, y: 0, width: w, height: 10, rx: 0, style: `fill:${it.color || opts.color || "var(--accent)"}` });
    fills.push(fill);
    return h("div", { class: "hbar", role: "listitem" },
      h("span", { class: "hbar-label" }, it.label),
      s("svg", { class: "hbar-track", viewBox: "0 0 100 10", preserveAspectRatio: "none", "aria-hidden": "true" }, s("rect", { x: 0, y: 0, width: 100, height: 10, class: "hbar-bg" }), fill),
      h("span", { class: "hbar-value num" }, it.display ?? format(it.value)));
  }));
  if (opts.animate !== false) requestAnimationFrame(() => growBars(fills));
  return el;
}

export function sparkline(values, opts = {}) {
  const pts = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const svg = s("svg", { class: "spark", viewBox: "0 0 100 30", preserveAspectRatio: "none", "aria-hidden": "true" });
  if (pts.length < 2) return svg;
  let lo = Math.min(...pts), hi = Math.max(...pts);
  if (hi === lo) { hi += 1; lo -= 1; }
  const y = (v) => { const r = (v - lo) / (hi - lo); return opts.invert ? 3 + r * 24 : 27 - r * 24; };
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 100).toFixed(2)},${y(v).toFixed(2)}`).join("");
  const area = `${d}L100,30L0,30Z`;
  svg.append(s("path", { d: area, class: "spark-area", style: `fill:${opts.color || "var(--accent)"}` }), s("path", { d, class: "spark-line", style: `stroke:${opts.color || "var(--accent)"}` }));
  return svg;
}

// segments: [{label, value, color}]
export function donut(segments, opts = {}) {
  const total = segments.reduce((a, b) => a + (b.value || 0), 0);
  const r = 42, c = 2 * Math.PI * r;
  const svg = s("svg", { class: "donut", viewBox: "0 0 120 120", role: "img", "aria-label": opts.label || "Breakdown" });
  svg.append(s("circle", { cx: 60, cy: 60, r, class: "donut-bg" }));
  let off = 0;
  const arcs = [];
  for (const seg of segments) {
    if (!total || !seg.value) continue;
    const len = (seg.value / total) * c;
    const arc = s("circle", { cx: 60, cy: 60, r, class: "donut-arc", style: `stroke:${seg.color}`, "stroke-dasharray": `${Math.max(0, len - 1.5)} ${c}`, "stroke-dashoffset": -off, transform: "rotate(-90 60 60)" });
    arcs.push(arc);
    svg.append(arc);
    off += len;
  }
  svg.append(s("text", { x: 60, y: 58, "text-anchor": "middle", class: "donut-total num" }, opts.center ?? fmt.int(total)), s("text", { x: 60, y: 75, "text-anchor": "middle", class: "donut-sub" }, opts.sub || "total"));
  fadeIn(arcs);
  return h("div", { class: "donut-wrap" }, svg,
    h("ul", { class: "legend legend-col" }, segments.map((seg) => h("li", null, h("span", { class: "dot", style: { background: seg.color } }), seg.label,
      h("span", { class: "num legend-val" }, total ? `${fmt.int(seg.value)} · ${fmt.pct((seg.value || 0) / total)}` : "0")))));
}

// Pivot rows [{day, key, value}] into lineChart series.
export function pivot(rows, keyField, valueField, names = {}) {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const byKey = new Map();
  for (const r of rows) {
    const k = r[keyField];
    if (!byKey.has(k)) byKey.set(k, {});
    const vals = byKey.get(k);
    vals[r.day] = (vals[r.day] || 0) + (Number(r[valueField]) || 0);
  }
  const series = [...byKey.entries()].map(([k, values], i) => ({ name: names[k] || fmt.label(k), color: seriesColor(i), values }));
  return { days, series };
}
