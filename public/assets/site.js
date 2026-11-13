/* Landing page behaviour: mobile menu and GSAP reveals. Content stays visible if GSAP is missing. */
(function () {
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    });
  }

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var gsap = window.gsap;
  if (reduce || !gsap) return;
  try {
    if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
    var tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.from("[data-hero]", { y: 18, autoAlpha: 0, duration: 0.7, stagger: 0.08, clearProps: "all" })
      .from("[data-mock]", { y: 26, autoAlpha: 0, duration: 0.7, stagger: 0.12, clearProps: "all" }, "-=0.45")
      .from(".mock-text mark", { backgroundColor: "rgba(0,0,0,0)", duration: 0.6, stagger: 0.15, clearProps: "backgroundColor" }, "-=0.2")
      .from(".path-steps li", { y: 10, autoAlpha: 0, duration: 0.4, stagger: 0.08, clearProps: "all" }, "-=0.3");

    if (!window.ScrollTrigger) return;
    var groups = new Map();
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      var p = el.parentElement || document.body;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(el);
    });
    groups.forEach(function (items, parent) {
      gsap.from(items, {
        y: 24, autoAlpha: 0, duration: 0.7, ease: "power3.out", stagger: 0.07, clearProps: "all",
        scrollTrigger: { trigger: parent, start: "top 85%", once: true }
      });
    });
  } catch (err) {
    // Animation is decorative; make sure nothing stays hidden.
    document.querySelectorAll("[data-reveal],[data-hero],[data-mock]").forEach(function (el) { el.style.opacity = ""; el.style.visibility = ""; el.style.transform = ""; });
  }
})();
