import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {applyFixers, autoFix, type CompositionFiles} from "./autofix.ts";
import type {CheckFinding, CheckReport} from "./check.ts";
import type {AuthoringDir} from "../compose/workdir.ts";

const authoring = {
  dir: "",
  compositionId: "demo-portrait",
  family: "portrait",
  width: 1080,
  height: 1920,
  durationSeconds: 30,
} as AuthoringDir;

const files = (over: Partial<CompositionFiles> = {}): CompositionFiles => ({
  "index.html": "<html><body></body></html>",
  "styles.css": "",
  "animation.js": "",
  ...over,
});

const error = (over: Partial<CheckFinding>): CheckFinding =>
  ({severity: "error", message: "", source: "plan", ...over});

const report = (findings: CheckFinding[]): CheckReport => ({
  ok: findings.every((f) => f.severity !== "error"),
  errorCount: findings.filter((f) => f.severity === "error").length,
  warningCount: findings.filter((f) => f.severity === "warning").length,
  findings,
});

async function withComposition(
  seed: CompositionFiles,
  run: (dir: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-autofix-"));
  try {
    for (const [name, body] of Object.entries(seed)) {
      await fs.writeFile(path.join(dir, name), body, "utf8");
    }
    await run(dir);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test("a drifted timing is written from the expected literal", () => {
  const html = '<section id="scene-a" class="clip" data-start="9.9" data-duration="2.000"></section>';
  const {files: fixed, applied} = applyFixers(
    files({"index.html": html}),
    [error({code: "timing_drift", elementId: "scene-a", attribute: "data-start", expected: "1.500"})],
    {authoring},
  );
  assert.deepEqual(applied, ["timing_drift"]);
  assert.match(fixed["index.html"], /data-start="1\.500"/);
});

test("a missing timing attribute is inserted, not skipped", () => {
  const html = '<section id="scene-a" class="clip"></section>';
  const {files: fixed} = applyFixers(
    files({"index.html": html}),
    [error({code: "missing_timing", elementId: "scene-a", attribute: "data-duration", expected: "2.250"})],
    {authoring},
  );
  assert.match(fixed["index.html"], /data-duration="2\.250"/);
});

test("the real 53e128 repair: an unidentified rail and a ./media prefix", () => {
  // The entire attempt 1 -> 2 diff of thought-leadership-53e128, which cost a full model
  // session. The lockup was already present; the rail simply carried no id, so the checker
  // could not find it. Verified byte-for-byte against that run's frozen attempts.
  const html = '<html><body>'
    + '<header class="brand-rail on-light clip" data-start="0" data-duration="43.23" data-track-index="70">'
    + '<img class="rail-lockup" src="./media/logo-lockup-light.png" alt="myHERALD" />'
    + "</header></body></html>";
  const {files: fixed, applied} = applyFixers(
    files({"index.html": html}),
    [error({
      code: "canonical_lockup_missing_rail",
      elementId: "brand-rail",
      expected: '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD">',
    })],
    {authoring},
  );
  assert.deepEqual(applied, ["canonical_lockup_missing_rail", "media_path_prefix"]);
  assert.match(
    fixed["index.html"],
    /<header id="brand-rail" class="brand-rail on-light clip" data-start="0" data-duration="43\.23" data-track-index="70">/,
  );
  assert.match(fixed["index.html"], /src="media\/logo-lockup-light\.png"/);
  // The lockup was already there. Adding the id must not also stack a second one.
  assert.equal((fixed["index.html"].match(/rail-lockup/g) ?? []).length, 1);
});

test("a rail that already has a lockup is not given a second one", () => {
  const html = '<header id="brand-rail" class="brand-rail">'
    + '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD"></header>';
  const {files: fixed} = applyFixers(
    files({"index.html": html}),
    [error({
      code: "canonical_lockup_missing_rail",
      elementId: "brand-rail",
      expected: '<img class="rail-lockup" src="media/logo-lockup-dark.png" alt="myHERALD">',
    })],
    {authoring},
  );
  assert.equal((fixed["index.html"].match(/rail-lockup/g) ?? []).length, 1);
});

test("a lockup finding with no determined asset is declined", () => {
  const html = '<header id="brand-rail" class="brand-rail"><span>myHERALD</span></header>';
  const {applied} = applyFixers(
    files({"index.html": html}),
    [error({code: "canonical_lockup_missing_rail", elementId: "brand-rail"})],
    {authoring},
  );
  assert.equal(applied.includes("canonical_lockup_missing_rail"), false);
});

test("a stray ./media prefix alone never triggers a verification pass", () => {
  // Learned from the first live run: eleven layout errors, none mechanical, no fixer
  // willing to act — but this normalisation made the batch look non-empty, so the pass
  // wrote, spent a 63s checker round and reverted. Cosmetic tidying is not worth that.
  const {applied} = applyFixers(
    files({"index.html": '<img src="./media/logo-lockup-light.png">'}),
    [error({code: "text_occluded", selector: ".lead"})],
    {authoring},
  );
  assert.deepEqual(applied, []);
});

test("the media prefix is stripped alongside a real fix; mandated ./ paths survive", () => {
  const html = '<link href="./tokens.css"><link href="./blocks/base.css">'
    + '<script src="./vendor/gsap.min.js"></script><audio src="./narration.m4a"></audio>'
    + '<img src="./media/logo-lockup-light.png">'
    + '<section id="scene-a" class="clip"></section>';
  const {files: fixed, applied} = applyFixers(
    files({"index.html": html}),
    [error({code: "missing_timing", elementId: "scene-a", attribute: "data-start", expected: "0.000"})],
    {authoring},
  );
  assert.deepEqual(applied, ["missing_timing", "media_path_prefix"]);
  assert.match(fixed["index.html"], /src="media\/logo-lockup-light\.png"/);
  // BRIEF.md mandates these four; a blanket strip would break them to fix one.
  assert.match(fixed["index.html"], /href="\.\/tokens\.css"/);
  assert.match(fixed["index.html"], /href="\.\/blocks\/base\.css"/);
  assert.match(fixed["index.html"], /src="\.\/vendor\/gsap\.min\.js"/);
  assert.match(fixed["index.html"], /src="\.\/narration\.m4a"/);
});

test("an em-dash becomes an en-dash, never a comma", () => {
  const {files: fixed} = applyFixers(
    files({"index.html": "<h1>Slots — statt Gedanken</h1>"}),
    [error({code: "em_dash", file: "index.html", expected: "–"})],
    {authoring},
  );
  assert.match(fixed["index.html"], /Slots – statt Gedanken/);
});

test("the vendored GSAP is linked, never the CDN the upstream hint suggests", () => {
  const html = '<body><script src="./animation.js"></script></body>';
  const {files: fixed} = applyFixers(
    files({"index.html": html}),
    [error({code: "missing_gsap_script"})],
    {authoring},
  );
  assert.match(fixed["index.html"], /<script src="\.\/vendor\/gsap\.min\.js"><\/script>/);
  assert.doesNotMatch(fixed["index.html"], /cdn|https?:/i);
  // GSAP must be defined before animation.js runs.
  assert.ok(
    fixed["index.html"].indexOf("gsap.min.js") < fixed["index.html"].indexOf("animation.js"),
  );
});

test("a lone narration audio element gains the id the runtime expects", () => {
  const {files: fixed} = applyFixers(
    files({"index.html": '<audio src="narration.m4a" data-start="0"></audio>'}),
    [error({code: "media_missing_id"})],
    {authoring},
  );
  assert.match(fixed["index.html"], /<audio id="narration" src="narration\.m4a"/);
});

test("ambiguous audio elements are left to the composer", () => {
  const {applied} = applyFixers(
    files({"index.html": '<audio src="narration.m4a"></audio><audio src="bed.m4a"></audio>'}),
    [error({code: "media_missing_id"})],
    {authoring},
  );
  assert.equal(applied.includes("media_missing_id"), false);
});

test("an unknown code is never guessed at", () => {
  const {applied} = applyFixers(
    files(),
    [error({code: "text_box_overflow", selector: ".lead"}), error({code: "contrast_aa_failure"})],
    {authoring},
  );
  assert.deepEqual(applied, []);
});

test("warnings never trigger a fix", () => {
  const {applied} = applyFixers(
    files({"index.html": '<section id="scene-a"></section>'}),
    [{severity: "warning", code: "missing_timing", message: "", source: "plan",
      elementId: "scene-a", attribute: "data-start", expected: "0.000"}],
    {authoring},
  );
  assert.deepEqual(applied, []);
});

test("a verified improvement is kept and reported", async () => {
  const seed = files({"index.html": '<section id="scene-a" class="clip"></section>'});
  await withComposition(seed, async (dir) => {
    let calls = 0;
    const result = await autoFix({
      dir,
      authoring: {...authoring, dir},
      report: report([error({
        code: "missing_timing", elementId: "scene-a", attribute: "data-start", expected: "1.500",
      })]),
      check: async () => {
        calls += 1;
        return report([]);
      },
    });
    assert.deepEqual(result.applied, ["missing_timing"]);
    assert.equal(result.report.ok, true);
    assert.equal(calls, 1, "the fix must be proven by exactly one verification pass");
    assert.match(await fs.readFile(path.join(dir, "index.html"), "utf8"), /data-start="1\.500"/);
  });
});

test("a fix that introduces a new error code is rolled back byte-exactly", async () => {
  const original = '<section id="scene-a" class="clip"></section>';
  const seed = files({"index.html": original});
  await withComposition(seed, async (dir) => {
    const result = await autoFix({
      dir,
      authoring: {...authoring, dir},
      report: report([error({
        code: "missing_timing", elementId: "scene-a", attribute: "data-start", expected: "1.500",
      })]),
      // Fewer errors than before, but a code the composer never saw. Not an improvement.
      check: async () => report([error({code: "content_overlap"})]),
    });

    assert.deepEqual(result.applied, [], "a rolled-back batch must report nothing applied");
    assert.equal(result.report.errorCount, 1);
    assert.equal(result.report.findings[0]?.code, "missing_timing");
    assert.equal(
      await fs.readFile(path.join(dir, "index.html"), "utf8"),
      original,
      "the composition must be restored byte-for-byte",
    );
  });
});

test("a fix that trades an error for a warning is rolled back", async () => {
  const original = '<section id="scene-a" class="clip"></section>';
  await withComposition(files({"index.html": original}), async (dir) => {
    const result = await autoFix({
      dir,
      authoring: {...authoring, dir},
      report: report([error({
        code: "missing_timing", elementId: "scene-a", attribute: "data-start", expected: "1.500",
      })]),
      check: async () => report([
        {severity: "warning", code: "id_requires_css_escape", message: "", source: "hyperframes"},
      ]),
    });
    assert.deepEqual(result.applied, []);
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), original);
  });
});

test("nothing fixable means no write and no verification pass", async () => {
  const original = "<html><body><p>fine</p></body></html>";
  await withComposition(files({"index.html": original}), async (dir) => {
    let calls = 0;
    const result = await autoFix({
      dir,
      authoring: {...authoring, dir},
      report: report([error({code: "text_box_overflow", selector: ".lead"})]),
      check: async () => {
        calls += 1;
        return report([]);
      },
    });
    assert.deepEqual(result.applied, []);
    assert.equal(calls, 0, "a checker pass costs 20-40s and must not run for nothing");
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), original);
  });
});

test("rounds are capped so two fixers cannot ping-pong", async () => {
  const seed = files({"index.html": '<section id="scene-a" class="clip"></section>'});
  await withComposition(seed, async (dir) => {
    let calls = 0;
    await autoFix({
      dir,
      authoring: {...authoring, dir},
      report: report([
        error({code: "missing_timing", elementId: "scene-a", attribute: "data-start", expected: "1.500"}),
        error({code: "scene_not_clip", elementId: "scene-a"}),
      ]),
      // Always one fewer error, never ok — without a cap this would loop forever.
      check: async () => {
        calls += 1;
        return report([error({code: "missing_timing", elementId: "scene-a", attribute: "data-start", expected: `${calls}.000`})]);
      },
      maxRounds: 2,
    });
    assert.ok(calls <= 2, `expected at most 2 verification passes, got ${calls}`);
  });
});
