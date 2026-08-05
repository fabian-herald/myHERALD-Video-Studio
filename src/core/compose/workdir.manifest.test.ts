import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {loadBrandKit} from "../brand/kit.ts";
import {videoPlanZ, type VideoPlan} from "../plan/schema.ts";
import {prepareAuthoringDir} from "./workdir.ts";

/**
 * THE AUTHORING-DIRECTORY EQUALITY TEST.
 *
 * `prepareAuthoringDir` writes everything the composer sees except the three files it
 * authors itself — CONTRACT.md, CRAFT.md, BRIEF.md, the blocks, the brand tokens, the
 * fonts, the exemplar, the narration. That directory *is* the composer's world, and until
 * this test nothing in the suite looked at it as a whole: a change to any supplied block or
 * to the brief's wording could alter every future composition and no test would notice.
 *
 * So: every file it writes is hashed and pinned against a checked-in manifest. Regenerate
 * only with `UPDATE_WORKDIR_MANIFEST=1`, and read the diff when you do — a manifest update
 * is a deliberate statement that the composer's inputs changed, not a way to make a red
 * test green.
 *
 * It was originally written to prove an optional template system could be turned off
 * without disturbing this path. That system was measured, found not to earn its keep, and
 * removed (see `docs/template-build-plan.md`). The test outlived it because the property it
 * pins was always the valuable part and never really about templates: **the composer's
 * inputs do not change by accident.** The second assertion below — that BRIEF.md does not
 * mention regions or layer items — is kept as the tripwire for that system, or anything
 * like it, arriving again without the equality above being reconsidered first.
 *
 * Both properties run against the fixtures `exemplar-conformance.test.ts` already uses: the
 * real dba07c-derived plan and a silent narration track.
 */

const FIXTURES_DIR = fileURLToPath(new URL(".", import.meta.url));
const MANIFEST_PATH = path.join(FIXTURES_DIR, "workdir.manifest.fixture.json");

async function loadFixturePlan(): Promise<VideoPlan> {
  const raw = await fs.readFile(path.join(FIXTURES_DIR, "exemplar-plan.fixture.json"), "utf8");
  return videoPlanZ.parse(JSON.parse(raw));
}

/** Every file under `dir`, as POSIX-style paths relative to `dir`, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)).map((child) => path.join(entry.name, child)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.map((file) => file.split(path.sep).join("/")).sort();
}

async function hashTree(dir: string): Promise<Record<string, string>> {
  const files = await listFiles(dir);
  const manifest: Record<string, string> = {};
  for (const file of files) {
    const bytes = await fs.readFile(path.join(dir, file));
    manifest[file] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  return manifest;
}

function diffManifests(expected: Record<string, string>, actual: Record<string, string>) {
  const expectedFiles = new Set(Object.keys(expected));
  const actualFiles = new Set(Object.keys(actual));
  const added = [...actualFiles].filter((file) => !expectedFiles.has(file)).sort();
  const removed = [...expectedFiles].filter((file) => !actualFiles.has(file)).sort();
  const changed = [...actualFiles]
    .filter((file) => expectedFiles.has(file) && expected[file] !== actual[file])
    .sort();
  return {added, removed, changed};
}

test("prepareAuthoringDir output is byte-identical to the pinned manifest", async () => {
  const plan = await loadFixturePlan();
  const kit = await loadBrandKit();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-workdir-manifest-"));

  try {
    await prepareAuthoringDir({
      plan,
      kit,
      family: "portrait",
      dir,
      narrationPath: path.join(FIXTURES_DIR, "exemplar-narration.fixture.m4a"),
    });

    const actual = await hashTree(dir);

    if (process.env.UPDATE_WORKDIR_MANIFEST === "1") {
      await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
      return;
    }

    const expected = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")) as Record<string, string>;
    const {added, removed, changed} = diffManifests(expected, actual);

    assert.ok(added.length === 0 && removed.length === 0 && changed.length === 0, [
      "prepareAuthoringDir's output no longer matches workdir.manifest.fixture.json — the",
      "byte-for-byte pin on everything the composer is handed before it writes a line.",
      "",
      "Why this test exists: that directory is the composer's entire world, and a change to",
      "any of it silently changes every video made afterwards. This is the only test that",
      "looks at the whole directory, so an accidental edit to a supplied block, the brand",
      "tokens, or the brief's wording reaches production unnoticed if this is waved through.",
      "",
      "So decide which this is before you touch the fixture:",
      "  • Deliberate — a block edited, the kit changed, a file added on purpose. Regenerate,",
      "    then READ THE DIFF and keep it in the same commit as the change that caused it:",
      "      UPDATE_WORKDIR_MANIFEST=1 node --import tsx --test src/core/compose/workdir.manifest.test.ts",
      "  • Unintended — you changed something else and this moved as a side effect. That is",
      "    the regression this test exists to catch; fix the cause, not the fixture.",
      "",
      added.length ? `Added files not in the manifest: ${added.join(", ")}` : "",
      removed.length ? `Manifest files no longer written: ${removed.join(", ")}` : "",
      changed.length ? `Files whose bytes changed: ${changed.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test("BRIEF.md mentions neither regions nor layer items", async () => {
  const plan = await loadFixturePlan();
  const kit = await loadBrandKit();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-workdir-brief-"));

  try {
    await prepareAuthoringDir({
      plan,
      kit,
      family: "portrait",
      dir,
      narrationPath: path.join(FIXTURES_DIR, "exemplar-narration.fixture.m4a"),
    });

    const brief = await fs.readFile(path.join(dir, "BRIEF.md"), "utf8");

    const failureContext = "\nWhy this test exists: a region/layer template system was built "
      + "against this repo in August 2026, measured, and removed — its own gate failed at "
      + "48.6% against a 60% threshold, and a composer handed the full library ignored it "
      + "entirely (docs/template-build-plan.md). This assertion is the tripwire for that "
      + "vocabulary reappearing in the composer's prompt. If it fired, read that document "
      + "first: the idea has been tried and measured, and reintroducing it needs new "
      + "evidence rather than new enthusiasm.";

    assert.doesNotMatch(brief, /\bregions?\b/i, `BRIEF.md mentions "region(s)".${failureContext}`);
    assert.doesNotMatch(brief, /\blayer items?\b/i, `BRIEF.md mentions "layer item(s)".${failureContext}`);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});
