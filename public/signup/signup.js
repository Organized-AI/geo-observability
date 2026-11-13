// Self-serve signup: create the workspace, then hand off to Stripe Checkout to save a card.
const $ = (id) => document.getElementById(id);
const note = $("note");
const form = $("form");
const submit = $("submit");

function say(text, tone = "info") {
  note.textContent = text;
  note.dataset.tone = tone;
  note.hidden = !text;
}

async function call(method, body) {
  const res = await fetch("/api/signup", {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function animateIn() {
  const gsap = window.gsap;
  if (!gsap || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  gsap.from("[data-in]", { y: 14, opacity: 0, duration: 0.5, stagger: 0.07, ease: "power3.out" });
}

async function init() {
  if (new URLSearchParams(location.search).get("canceled")) say("No card was saved, so nothing was charged. You can try again whenever you're ready.", "warn");
  try {
    const me = await call("GET");
    if (me.signed_in) {
      $("email-field").hidden = true;
      $("who").textContent = `Signed in as ${me.email}. The new workspace will be yours.`;
    }
    const list = (me.workspaces || []).filter((w) => w.billing_status !== "incomplete");
    if (list.length) {
      $("existing").hidden = false;
      const ul = $("existing-list");
      for (const w of list) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "/app/";
        a.addEventListener("click", () => { try { localStorage.setItem("geo-tenant", w.slug); } catch { /* storage off */ } });
        a.append(Object.assign(document.createElement("span"), { textContent: w.name }), Object.assign(document.createElement("span"), { textContent: "Open →" }));
        li.append(a);
        ul.append(li);
      }
    }
    if (!me.open) {
      form.querySelectorAll("input, button").forEach((el) => { el.disabled = true; });
      say("Sign-up isn't open yet. Check back soon, or ask your Organized AI contact.", "warn");
    }
  } catch (e) {
    say(e.message, "neg");
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("name").value.trim();
  const emailBox = $("email");
  const needsEmail = !$("email-field").hidden;
  if (needsEmail && !emailBox.checkValidity()) { say("Enter a valid email address.", "neg"); emailBox.focus(); return; }
  if (!name) { say("Give your workspace a name.", "neg"); $("name").focus(); return; }
  submit.disabled = true;
  submit.textContent = "Opening Stripe…";
  try {
    const r = await call("POST", { email: needsEmail ? emailBox.value.trim() : undefined, name, website: $("website").value.trim() });
    if (r.status === "check_email") {
      say(r.message, "info");
      submit.disabled = false;
      submit.textContent = "Continue to add a card";
      return;
    }
    if (r.slug) { try { localStorage.setItem("geo-tenant", r.slug); } catch { /* storage off */ } }
    location.assign(r.checkout_url);
  } catch (e) {
    say(e.message, "neg");
    submit.disabled = false;
    submit.textContent = "Continue to add a card";
  }
});

init();
animateIn();
