#!/usr/bin/env node
// Builds the user documentation from docs-src/**/*.md into public/docs/.
//
//   node scripts/build-docs.mjs
//
// Each Markdown file starts with simple front matter:
//
//   ---
//   title: Quickstart
//   section: Get started
//   order: 2
//   slug: quickstart        (optional; defaults to the file name without its number prefix)
//   description: ...        (optional; used for <meta name="description">)
//   ---
//
// Output: public/docs/<slug>/index.html for every page, public/docs/index.html (the Welcome
// page), and public/docs/search.json for the client-side search box. The shared stylesheet and
// script live in public/docs/docs.css and public/docs/docs.js and are not generated here.

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, Renderer } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs-src');
const OUT = path.join(ROOT, 'public', 'docs');
const BASE = '/docs';
const SITE = 'GEO Observability';
const WELCOME_SLUG = 'welcome';

// Section order for the left navigation. Every page's `section` must be one of these.
const SECTIONS = [
  'Get started',
  'Set up your project',
  'Read your results',
  'Brand perception',
  'Your project',
  'Plans and usage',
  'Improve',
  'Your website and traffic',
  'Run transparency',
  'Reference',
  'Agencies',
  'Integrations',
];

// Files in public/docs that this script owns besides the page folders. Anything else that the
// script did not write (docs.css, docs.js) is left alone.
const KEEP = new Set(['docs.css', 'docs.js']);

// ---------- helpers ----------

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

// Inline tags (links, code, emphasis) are removed without a gap so "the <a>edge tap</a>, because" stays
// "the edge tap, because"; block tags become a space so paragraphs don't run together.
const INLINE = /<\/?(a|code|strong|em|b|i|span|kbd|mark|abbr|sup|sub)\b[^>]*>/gi;
const stripTags = (html) => decodeEntities(html.replace(INLINE, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').trim();

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

function parseFrontMatter(raw, file) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) throw new Error(`${file}: bad front matter line "${line}"`);
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    data[key] = value;
  }
  for (const key of ['title', 'section', 'order']) {
    if (!data[key]) throw new Error(`${file}: front matter needs "${key}"`);
  }
  data.order = Number(data.order);
  if (!Number.isFinite(data.order)) throw new Error(`${file}: "order" must be a number`);
  return { data, body: raw.slice(m[0].length) };
}

// ---------- Markdown rendering ----------

function renderMarkdown(markdown) {
  const headings = [];
  const used = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        let id = slugify(stripTags(inner)) || 'section';
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2) headings.push({ id, text: stripTags(inner) });
        if (depth === 2 || depth === 3) {
          return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
        }
        return `<h${depth}>${inner}</h${depth}>\n`;
      },
      table(token) {
        // Wrap tables so wide ones scroll inside the article instead of the page.
        const html = Renderer.prototype.table.call(this, token);
        return `<div class="table-wrap">${html}</div>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href);
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const rel = external ? ' rel="noopener" target="_blank"' : '';
        return `<a href="${escapeHtml(href)}"${t}${rel}>${text}</a>`;
      },
    },
  });
  const html = marked.parse(markdown);
  return { html, headings };
}

// ---------- layout ----------

function navHtml(pagesBySection, current) {
  return SECTIONS.map((section) => {
    const items = pagesBySection.get(section) || [];
    const open = items.some((p) => p.slug === current.slug);
    const links = items
      .map((p) => {
        const cur = p.slug === current.slug ? ' aria-current="page"' : '';
        return `<li><a href="${p.url}"${cur}>${escapeHtml(p.navTitle)}</a></li>`;
      })
      .join('');
    return `<div class="nav-group${open ? ' is-current' : ''}"><p class="nav-heading">${escapeHtml(section)}</p><ul>${links}</ul></div>`;
  }).join('\n');
}

function tocHtml(headings) {
  if (headings.length < 2) return '';
  const items = headings.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('');
  return `<p class="toc-heading">On this page</p><ul>${items}</ul>`;
}

function pagerHtml(prev, next) {
  const cell = (p, dir) =>
    p
      ? `<a class="pager-link pager-${dir}" href="${p.url}"><span class="pager-label">${dir === 'prev' ? 'Previous' : 'Next'}</span><span class="pager-title">${escapeHtml(p.title)}</span></a>`
      : '<span></span>';
  return `<nav class="pager" aria-label="Previous and next page">${cell(prev, 'prev')}${cell(next, 'next')}</nav>`;
}

function layout({ page, prev, next, pagesBySection }) {
  const title = `${page.title} · ${SITE} docs`;
  const description = page.description || page.excerpt;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<meta name="description" content="${escapeHtml(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,500;8..60,600;8..60,700&display=swap">
<link rel="stylesheet" href="${BASE}/docs.css">
<script>try{var t=localStorage.getItem('docs-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <button class="icon-btn menu-btn" type="button" aria-controls="sidenav" aria-expanded="false" aria-label="Open navigation">
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <a class="brand" href="${BASE}/">
    <img class="brand-mark" src="/brand/logo-64.png" alt="" width="22" height="22">
    <span class="brand-name">GEO Observability</span>
    <span class="brand-sub">Docs</span>
  </a>
  <div class="search" role="search">
    <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <input id="docs-search" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" aria-label="Search the docs" aria-controls="search-results" aria-expanded="false">
    <kbd class="search-kbd" aria-hidden="true">/</kbd>
    <ul id="search-results" class="search-results" role="listbox" hidden></ul>
  </div>
  <button class="icon-btn theme-btn" type="button" aria-label="Switch colour theme" title="Switch colour theme">
    <svg class="i-sun" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <svg class="i-moon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
  </button>
</header>
<div class="shell">
  <nav id="sidenav" class="sidenav" aria-label="Documentation">
${navHtml(pagesBySection, page)}
  </nav>
  <div class="nav-scrim" hidden></div>
  <main id="main" class="content">
    <article class="doc">
      <p class="eyebrow">${escapeHtml(page.section)}</p>
      <h1>${escapeHtml(page.title)}</h1>
${page.html}
      ${pagerHtml(prev, next)}
    </article>
  </main>
  <aside class="toc" aria-label="On this page">
    ${tocHtml(page.headings)}
  </aside>
</div>
<footer class="footer"><p>GEO Observability by Organized AI</p></footer>
<script src="/vendor/gsap.min.js" defer></script>
<script src="${BASE}/docs.js" defer></script>
</body>
</html>
`;
}

// ---------- build ----------

async function main() {
  const files = await walk(SRC);
  if (!files.length) throw new Error(`No Markdown files found in ${SRC}`);

  const pages = [];
  const slugs = new Set();
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const rel = path.relative(SRC, file);
    const { data, body } = parseFrontMatter(raw, rel);
    if (!SECTIONS.includes(data.section)) {
      throw new Error(`${rel}: unknown section "${data.section}". Add it to SECTIONS in build-docs.mjs.`);
    }
    const slug = data.slug || path.basename(file, '.md').replace(/^\d+[-_]/, '');
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`${rel}: slug "${slug}" must be lower-case letters, digits and dashes`);
    if (slugs.has(slug)) throw new Error(`${rel}: duplicate slug "${slug}"`);
    slugs.add(slug);
    const { html, headings } = renderMarkdown(body);
    const text = stripTags(html.replace(/<a class="anchor"[^>]*>#<\/a>/g, ''));
    const excerpt = text.length > 220 ? `${text.slice(0, 217).replace(/\s+\S*$/, '')}…` : text;
    pages.push({
      file: rel,
      slug,
      title: data.title,
      navTitle: data.nav || data.title,
      section: data.section,
      order: data.order,
      description: data.description,
      url: slug === WELCOME_SLUG ? `${BASE}/` : `${BASE}/${slug}/`,
      html,
      headings,
      excerpt,
    });
  }

  pages.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.order - b.order);
  if (!slugs.has(WELCOME_SLUG)) throw new Error(`A page with slug "${WELCOME_SLUG}" is required`);

  const pagesBySection = new Map();
  for (const p of pages) {
    if (!pagesBySection.has(p.section)) pagesBySection.set(p.section, []);
    pagesBySection.get(p.section).push(p);
  }

  // Check internal links and anchors so a renamed page can't leave a dead link behind.
  const anchorsBySlug = new Map(pages.map((p) => [p.slug, new Set([...p.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  const problems = [];
  for (const p of pages) {
    for (const m of p.html.matchAll(/href="(\/docs\/[^"]*)"/g)) {
      const [pathPart, hash] = m[1].split('#');
      const target = pathPart.replace(/^\/docs\/?/, '').replace(/\/$/, '') || WELCOME_SLUG;
      if (!anchorsBySlug.has(target)) problems.push(`${p.file}: link to missing page ${m[1]}`);
      else if (hash && !anchorsBySlug.get(target).has(hash)) problems.push(`${p.file}: link to missing anchor ${m[1]}`);
    }
    for (const m of p.html.matchAll(/href="#([^"]+)"/g)) {
      if (!anchorsBySlug.get(p.slug).has(m[1])) problems.push(`${p.file}: link to missing anchor #${m[1]}`);
    }
  }
  if (problems.length) throw new Error(`Broken links:\n  ${problems.join('\n  ')}`);

  // Clear old generated output, keeping the hand-written CSS and JS.
  await mkdir(OUT, { recursive: true });
  for (const entry of await readdir(OUT)) {
    if (KEEP.has(entry)) continue;
    await rm(path.join(OUT, entry), { recursive: true, force: true });
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const html = layout({ page, prev: pages[i - 1], next: pages[i + 1], pagesBySection });
    const dir = path.join(OUT, page.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html);
    if (page.slug === WELCOME_SLUG) await writeFile(path.join(OUT, 'index.html'), html);
  }

  const search = pages.map((p) => ({
    title: p.title,
    section: p.section,
    url: p.url,
    excerpt: p.excerpt,
    headings: p.headings.map((h) => h.text),
  }));
  await writeFile(path.join(OUT, 'search.json'), JSON.stringify(search));

  for (const f of KEEP) {
    try {
      await stat(path.join(OUT, f));
    } catch {
      console.warn(`warning: public/docs/${f} is missing`);
    }
  }

  console.log(`Built ${pages.length} pages in ${SECTIONS.length} sections → ${path.relative(ROOT, OUT)}/`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
