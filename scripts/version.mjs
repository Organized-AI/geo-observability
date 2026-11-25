#!/usr/bin/env node
/**
 * One version, stated in package.json, package-lock.json and CHANGELOG.md ("## [X.Y.Z] - YYYY-MM-DD").
 *
 *   node scripts/version.mjs check                  package.json, package-lock.json and CHANGELOG agree
 *   node scripts/version.mjs check --tag v1.4.0     ...and the tag names that version (the release workflow runs this)
 *   node scripts/version.mjs notes 1.4.0            print that CHANGELOG section (GitHub Release notes)
 *   node scripts/version.mjs prepare minor          move [Unreleased] into a new dated section and bump the version
 *                                                   (patch | minor | major | X.Y.Z); commit it in a pull request, then tag
 *   node scripts/version.mjs milestone p3            tag HEAD "build/<version>-p3" to mark a phase while building
 *
 * Milestone tags start with "build/", never "v", because release.yml deploys production on any v*.*.* tag
 * (a pre-release like v1.5.0-beta.1 would match too).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Sections of a changelog, newest first: { version, date, start, end, body }. Accepts "## [1.2.3] - date" and "## 1.2.3". */
export function sections(text) {
  const lines = text.split("\n");
  const heads = [];
  lines.forEach((line, i) => {
    const m = line.match(/^## \[?([^\]\s]+)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (m) heads.push({ version: m[1], date: m[2] ?? "", start: i });
  });
  return heads.map((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].start : lines.length;
    return { ...h, end, body: lines.slice(h.start + 1, end).join("\n").trim() };
  });
}

export function problems({ pkg, lock, changelog, tag }) {
  const out = [];
  const v = pkg.version;
  if (!SEMVER.test(v)) out.push(`package.json version "${v}" is not X.Y.Z`);
  if (lock.version !== v || lock.packages?.[""]?.version !== v) out.push(`package-lock.json says ${lock.version}, package.json says ${v}: run npm install`);
  const secs = sections(changelog);
  const seen = new Set();
  for (const s of secs) {
    if (seen.has(s.version)) out.push(`CHANGELOG.md has two ## [${s.version}] sections`);
    seen.add(s.version);
  }
  if (!secs.some((s) => s.version === v)) out.push(`CHANGELOG.md has no ## [${v}] section`);
  if (tag !== undefined) {
    if (tag !== `v${v}`) out.push(`tag ${tag} does not match version ${v} (expected v${v})`);
    const sec = secs.find((s) => s.version === v);
    if (sec && !sec.body) out.push(`CHANGELOG.md section ${v} is empty`);
  }
  return out;
}

export function bump(current, how) {
  if (SEMVER.test(how)) return how;
  const [a, b, c] = current.split(".").map(Number);
  if (how === "major") return `${a + 1}.0.0`;
  if (how === "minor") return `${a}.${b + 1}.0`;
  if (how === "patch") return `${a}.${b}.${c + 1}`;
  throw new Error(`expected patch, minor, major or X.Y.Z, got "${how}"`);
}

/** Move the [Unreleased] body under a new "## [next] - date" heading and leave [Unreleased] empty. */
export function release(changelog, next, date) {
  const secs = sections(changelog);
  const un = secs.find((s) => s.version.toLowerCase() === "unreleased");
  if (!un || !un.body) throw new Error("CHANGELOG.md has nothing under ## [Unreleased]");
  if (secs.some((s) => s.version === next)) throw new Error(`CHANGELOG.md already has ${next}`);
  const lines = changelog.split("\n");
  const replacement = ["## [Unreleased]", "", `## [${next}] - ${date}`, "", un.body, ""];
  lines.splice(un.start, un.end - un.start, ...replacement);
  return lines.join("\n");
}

/** "build/1.5.0-p3" for a phase name; null when the name is not a short slug. */
export function milestoneTag(version, name) {
  const slug = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,39}$/.test(slug)) return null;
  return `build/${version}-${slug}`;
}

function read(name) {
  return readFileSync(join(ROOT, name), "utf8");
}

function main(argv) {
  const [cmd, value] = argv;
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const changelog = read("CHANGELOG.md");
  if (cmd === "check") {
    const i = argv.indexOf("--tag");
    const tag = i >= 0 ? argv[i + 1] : undefined;
    const found = problems({ pkg, lock, changelog, tag });
    for (const p of found) console.log(p);
    if (!found.length) console.log(`version ${pkg.version} agrees everywhere${tag ? ` and matches ${tag}` : ""}`);
    return found.length ? 1 : 0;
  }
  if (cmd === "notes") {
    const sec = sections(changelog).find((s) => s.version === String(value ?? pkg.version).replace(/^v/, ""));
    if (!sec) throw new Error(`no CHANGELOG section for ${value}`);
    console.log(sec.body);
    return 0;
  }
  if (cmd === "prepare") {
    const next = bump(pkg.version, value ?? "");
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(join(ROOT, "CHANGELOG.md"), release(changelog, next, date));
    pkg.version = next;
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    writeFileSync(join(ROOT, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    console.log(`prepared ${next}. Open a pull request with it; once it is merged, tag main:\n  git switch main && git pull && git tag -a v${next} -m v${next} && git push origin v${next}`);
    return 0;
  }
  if (cmd === "milestone") {
    const tag = milestoneTag(pkg.version, value);
    if (!tag) throw new Error("give a short phase name of letters, digits, dots or dashes, like p3 or hooks-h6");
    const found = problems({ pkg, lock, changelog });
    if (found.length) throw new Error(found.join("; "));
    const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
    if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("commit your changes first; a milestone marks a commit");
    const head = git("log", "-1", "--format=%h %s");
    git("tag", "-a", tag, "-m", `${tag}: ${head}`);
    console.log(`tagged ${tag} at ${head}\nlist: git tag -l 'build/*'   share: git push origin ${tag}`);
    return 0;
  }
  console.log("usage: node scripts/version.mjs check [--tag vX.Y.Z] | notes [X.Y.Z] | prepare patch|minor|major|X.Y.Z | milestone <phase>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
