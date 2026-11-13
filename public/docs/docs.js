// GEO Observability docs — navigation, theme, search, copy buttons, table of contents, entrance.
(function () {
  'use strict';
  var BASE = typeof window.__GEO_BASE__ === 'string' ? window.__GEO_BASE__ : ''; // set by the Worker under a base path

  var root = document.documentElement;
  var body = document.body;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* storage can be unavailable; the page still works */ }
  }

  // ---------- theme ----------
  var themeBtn = document.querySelector('.theme-btn');
  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set === 'light' || set === 'dark') return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      store('docs-theme', next);
    });
  }

  // ---------- mobile navigation ----------
  var menuBtn = document.querySelector('.menu-btn');
  var scrim = document.querySelector('.nav-scrim');
  function setNav(open) {
    body.classList.toggle('nav-open', open);
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    }
    if (scrim) scrim.hidden = !open;
  }
  if (menuBtn) menuBtn.addEventListener('click', function () { setNav(!body.classList.contains('nav-open')); });
  if (scrim) scrim.addEventListener('click', function () { setNav(false); });

  // Keep the current page visible in a long sidebar.
  var current = document.querySelector('.sidenav [aria-current="page"]');
  if (current && current.scrollIntoView) {
    var nav = document.getElementById('sidenav');
    var r = current.getBoundingClientRect();
    if (nav && r.bottom > window.innerHeight - 40) nav.scrollTop = current.offsetTop - 120;
  }

  // ---------- copy buttons ----------
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
      catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.doc pre'), function (pre) {
    var code = pre.querySelector('code');
    if (!code) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('click', function () {
      copyText(code.innerText.replace(/\n$/, '')).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('is-done');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1600);
      }, function () {
        btn.textContent = 'Press Ctrl+C';
      });
    });
    pre.appendChild(btn);
  });

  // ---------- table of contents highlight ----------
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var visible = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
      var heads = document.querySelectorAll('.doc h2[id]');
      var active = null;
      for (var i = 0; i < heads.length; i++) {
        if (visible[heads[i].id]) { active = heads[i].id; break; }
      }
      if (!active) {
        for (var j = heads.length - 1; j >= 0; j--) {
          if (heads[j].getBoundingClientRect().top < 120) { active = heads[j].id; break; }
        }
      }
      tocLinks.forEach(function (a) { a.classList.toggle('is-active', a === byId[active]); });
    }, { rootMargin: '-60px 0px -60% 0px' });
    Array.prototype.forEach.call(document.querySelectorAll('.doc h2[id]'), function (h) { observer.observe(h); });
  }

  // ---------- search ----------
  var input = document.getElementById('docs-search');
  var list = document.getElementById('search-results');
  var index = null;
  var loading = null;
  var selected = -1;

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch(BASE + '/docs/search.json')
        .then(function (r) { return r.json(); })
        .then(function (data) { index = data; return data; })
        .catch(function () { loading = null; return []; });
    }
    return loading;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function highlight(text, terms) {
    var out = escapeHtml(text);
    terms.forEach(function (t) {
      if (t.length < 2) return;
      var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }

  function score(page, terms) {
    var title = page.title.toLowerCase();
    var section = page.section.toLowerCase();
    var heads = (page.headings || []).join(' ').toLowerCase();
    var excerpt = page.excerpt.toLowerCase();
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var s = 0;
      if (title.indexOf(t) === 0) s += 12;
      else if (title.indexOf(t) > -1) s += 8;
      if (heads.indexOf(t) > -1) s += 4;
      if (section.indexOf(t) > -1) s += 3;
      if (excerpt.indexOf(t) > -1) s += 2;
      if (!s) return 0; // every term has to match somewhere
      total += s;
    }
    return total;
  }

  function render(results, terms) {
    selected = -1;
    if (!results.length) {
      list.innerHTML = '<li class="r-empty">No pages match. Try a shorter word.</li>';
    } else {
      list.innerHTML = results.map(function (p, i) {
        return '<li role="option" id="sr-' + i + '" aria-selected="false"><a href="' + escapeHtml(BASE + p.url) + '">' +
          '<span class="r-section">' + escapeHtml(p.section) + '</span>' +
          '<span class="r-title">' + highlight(p.title, terms) + '</span>' +
          '<span class="r-excerpt">' + highlight(p.excerpt, terms) + '</span></a></li>';
      }).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    selected = -1;
  }

  function run() {
    var q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    loadIndex().then(function (data) {
      var terms = q.split(/\s+/).filter(Boolean);
      var results = data
        .map(function (p) { return { p: p, s: score(p, terms) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, 8)
        .map(function (x) { return x.p; });
      render(results, terms);
    });
  }

  function move(delta) {
    var items = list.querySelectorAll('[role="option"]');
    if (!items.length) return;
    if (selected > -1) items[selected].setAttribute('aria-selected', 'false');
    selected = (selected + delta + items.length) % items.length;
    items[selected].setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', items[selected].id);
    items[selected].scrollIntoView({ block: 'nearest' });
  }

  if (input && list) {
    input.addEventListener('focus', loadIndex);
    input.addEventListener('input', run);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        var items = list.querySelectorAll('[role="option"] a');
        var target = items[selected > -1 ? selected : 0];
        if (target) { e.preventDefault(); window.location.href = target.getAttribute('href'); }
      } else if (e.key === 'Escape') { close(); input.blur(); }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.search')) close();
    });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag) && !e.target.isContentEditable) {
        e.preventDefault();
        input.focus();
      }
      if (e.key === 'Escape' && body.classList.contains('nav-open')) setNav(false);
    });
  }

  // ---------- entrance ----------
  if (!reduceMotion && window.gsap) {
    var parts = Array.prototype.slice.call(document.querySelectorAll('.doc > *'), 0, 10);
    window.gsap.from(parts, {
      opacity: 0,
      y: 10,
      duration: 0.45,
      stagger: 0.035,
      ease: 'power2.out',
      clearProps: 'opacity,transform',
    });
  }
})();
