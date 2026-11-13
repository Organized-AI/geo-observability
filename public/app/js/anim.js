// GSAP wrappers. Every helper is a no-op when GSAP is missing or the user prefers reduced motion,
// and animations only ever start from a hidden state that GSAP itself sets, so content can't get stuck hidden.
const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const G = () => window.gsap;
export const motionOK = () => !!G() && !(mq && mq.matches) && !document.body.classList.contains("is-printing");

let registered = false;
function reg() {
  if (registered || !G()) return;
  registered = true;
  try { const p = [window.Flip, window.ScrollTrigger].filter(Boolean); if (p.length) G().registerPlugin(...p); } catch { /* ignore */ }
}
const safe = (fn) => { try { reg(); fn(); } catch { /* animation is decorative */ } };

export function viewIn(el) {
  if (!motionOK() || !el) return;
  safe(() => G().fromTo(el, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out", clearProps: "opacity,visibility,transform" }));
}

export function reveal(els, opts = {}) {
  if (!motionOK() || !els || (els.length === 0)) return;
  safe(() => G().from(els, { autoAlpha: 0, y: opts.y ?? 8, duration: opts.duration ?? 0.4, stagger: opts.stagger ?? 0.04, ease: "power2.out", clearProps: "opacity,visibility,transform" }));
}

export function staggerRows(tbody, max = 40) {
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll(":scope > tr")).slice(0, max);
  reveal(rows, { y: 6, stagger: 0.018, duration: 0.3 });
}

export function countUp(el, to, format) {
  el.textContent = format(to);
  if (!motionOK() || typeof to !== "number" || !Number.isFinite(to)) return;
  const o = { v: 0 };
  safe(() => G().to(o, { v: to, duration: 0.9, ease: "power2.out", onUpdate: () => { el.textContent = format(o.v); }, onComplete: () => { el.textContent = format(to); } }));
}

export function drawLines(paths) {
  if (!motionOK()) return;
  safe(() => {
    paths.forEach((p, i) => {
      const len = p.getTotalLength ? p.getTotalLength() : 0;
      if (!len) return;
      G().fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1, delay: i * 0.08, ease: "power2.inOut", clearProps: "strokeDasharray,strokeDashoffset" });
    });
  });
}

export function growBars(rects) {
  if (!motionOK() || !rects.length) return;
  safe(() => G().from(rects, { attr: { width: 0 }, duration: 0.7, stagger: 0.04, ease: "power3.out" }));
}

export function fadeIn(els, delay = 0) {
  if (!motionOK() || !els.length) return;
  safe(() => G().from(els, { autoAlpha: 0, duration: 0.5, delay, stagger: 0.03, clearProps: "opacity,visibility" }));
}

export function drawerIn(panel, backdrop) {
  if (!motionOK()) return;
  safe(() => {
    G().fromTo(panel, { xPercent: 100 }, { xPercent: 0, duration: 0.38, ease: "power3.out", clearProps: "transform" });
    G().fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.3, clearProps: "opacity" });
  });
}
export function drawerOut(panel, backdrop, done) {
  if (!motionOK()) { done(); return; }
  try {
    G().to(backdrop, { opacity: 0, duration: 0.2 });
    G().to(panel, { xPercent: 100, duration: 0.25, ease: "power2.in", onComplete: done });
  } catch { done(); }
}

// Flip: capture positions, run a DOM mutation, animate from the old layout.
export function flip(targets, mutate, opts = {}) {
  const Flip = window.Flip;
  if (!motionOK() || !Flip) { mutate(); return; }
  let done = false;
  try {
    reg();
    const state = Flip.getState(targets);
    mutate();
    done = true;
    Flip.from(state, { duration: 0.45, ease: "power2.inOut", absolute: opts.absolute ?? false, nested: true, onEnter: (els) => G().fromTo(els, { opacity: 0 }, { opacity: 1, duration: 0.3 }), ...opts.extra });
  } catch { if (!done) mutate(); }
}
