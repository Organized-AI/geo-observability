// Email sign-in: ask for a single-use link. The answer is the same whether or not the email has an account.
const BASE = typeof window.__GEO_BASE__ === "string" ? window.__GEO_BASE__ : ""; // set by the Worker under a base path
const $ = (id) => document.getElementById(id);
const note = $("note");
const form = $("form");
const submit = $("submit");

function say(text, tone = "info") {
  note.textContent = text;
  note.dataset.tone = tone;
  note.hidden = !text;
}

const q = new URLSearchParams(location.search);
if (q.get("sent") === "checkout") say("Your payment went through. We've emailed you a link to open your workspace.", "info");
if (q.get("sent") === "failed") say(`Your payment went through, but the sign-in email didn't send. ${q.get("why") || ""}`.trim(), "neg");

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("email");
  if (!email.checkValidity() || !email.value.trim()) { say("Enter a valid email address.", "neg"); email.focus(); return; }
  submit.disabled = true;
  submit.textContent = "Sending…";
  try {
    const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ email: email.value.trim() }), credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    say(data.message || "Check your email for a sign-in link.", "info");
    submit.textContent = "Send another link";
  } catch (e) {
    say(e.message, "neg");
    submit.textContent = "Email me a sign-in link";
  } finally {
    submit.disabled = false;
  }
});

const gsap = window.gsap;
if (gsap && !matchMedia("(prefers-reduced-motion: reduce)").matches) gsap.from("[data-in]", { y: 14, opacity: 0, duration: 0.5, stagger: 0.07, ease: "power3.out" });
