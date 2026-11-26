import { test } from "node:test";
import assert from "node:assert/strict";
import { bump, milestoneTag, problems, release, sections } from "../scripts/version.mjs";

const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n- New thing\n\n## [1.3.1] - 2026-11-13\n- Pricing\n\n## 1.3.0\n- Base path\n";
const pkg = (v) => ({ version: v });
const lock = (v) => ({ version: v, packages: { "": { version: v } } });

test("sections reads bracketed and bare headings", () => {
  assert.deepEqual(sections(changelog).map((s) => [s.version, s.date]), [["Unreleased", ""], ["1.3.1", "2026-11-13"], ["1.3.0", ""]]);
  assert.equal(sections(changelog)[1].body, "- Pricing");
});

test("versions must agree, and a tag must match with a non-empty section", () => {
  assert.deepEqual(problems({ pkg: pkg("1.3.1"), lock: lock("1.3.1"), changelog }), []);
  assert.deepEqual(problems({ pkg: pkg("1.3.1"), lock: lock("1.3.1"), changelog, tag: "v1.3.1" }), []);
  assert.match(problems({ pkg: pkg("1.3.1"), lock: lock("1.3.0"), changelog }).join(), /package-lock/);
  assert.match(problems({ pkg: pkg("1.4.0"), lock: lock("1.4.0"), changelog }).join(), /no ## \[1.4.0\]/);
  assert.match(problems({ pkg: pkg("1.3.1"), lock: lock("1.3.1"), changelog, tag: "v1.3.2" }).join(), /does not match/);
});

test("bump and release move Unreleased into a dated section", () => {
  assert.equal(bump("1.3.1", "patch"), "1.3.2");
  assert.equal(bump("1.3.1", "minor"), "1.4.0");
  assert.equal(bump("1.3.1", "major"), "2.0.0");
  assert.equal(bump("1.3.1", "1.5.0"), "1.5.0");
  assert.throws(() => bump("1.3.1", "next"));
  const out = release(changelog, "1.4.0", "2026-12-01");
  const s = sections(out);
  assert.deepEqual(s.map((x) => x.version), ["Unreleased", "1.4.0", "1.3.1", "1.3.0"]);
  assert.equal(s[0].body, "");
  assert.equal(s[1].body, "### Added\n- New thing");
  assert.throws(() => release(out, "1.5.0", "2026-12-02"), /nothing under/);
});

test("milestone tags never look like a release tag", () => {
  assert.equal(milestoneTag("1.5.0", "P3"), "build/1.5.0-p3");
  assert.equal(milestoneTag("1.5.0", "hooks-h6"), "build/1.5.0-hooks-h6");
  assert.equal(milestoneTag("1.5.0", ""), null);
  assert.equal(milestoneTag("1.5.0", "a b"), null);
  assert.equal(milestoneTag("1.5.0", "../x"), null);
  assert.ok(!/^v\d/.test(milestoneTag("1.5.0", "p3")));
});
