import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {loadBrandKit} from "../brand/kit.ts";
import type {VideoPlan} from "../plan/schema.ts";
import {writeBaselineComposition} from "./baseline.ts";

const kit = await loadBrandKit();

function plan(onScreen: string): VideoPlan {
  return {
    schemaVersion: 1,
    id: "baseline-test",
    createdAt: "2026-08-02T00:00:00.000Z",
    brief: "Exercise the diagnostic composition.",
    intent: "educational",
    formats: ["9x16"],
    language: "en",
    title: "Baseline test",
    thesis: "The baseline preserves the plan.",
    sections: [
      {
        id: "hook", kind: "hook", intentNote: "Open", energy: "settled",
        onScreen: "A useful opening", phrases: [], startMs: 0, durationMs: 2_000,
      },
      {
        id: "signature", kind: "outro", intentNote: "Close", energy: "quiet",
        onScreen, phrases: [], startMs: 2_000, durationMs: 3_000,
      },
    ],
    alternates: [],
    narration: {provider: "gemini", voice: "Achird", style: "", register: "", timing: "planned"},
  };
}

test("the baseline keeps non-brand outro copy alongside the canonical end card", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-baseline-"));
  try {
    await writeBaselineComposition({
      dir,
      compositionId: "baseline-test",
      durationSeconds: 5,
      width: 1080,
      height: 1920,
      family: "portrait",
    }, plan("Name, then point"), kit);
    const html = await fs.readFile(path.join(dir, "index.html"), "utf8");
    // Compare visible text, not markup. `headline()` splits copy across `<br /><em>` on
    // purpose — that is the brand's headline signature — so the words survive while the
    // contiguous string does not. This is the same normalisation the copy_drift gate uses.
    const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.match(visible, /Name, then point/);
    assert.match(html, /class="cta-lockup end-card"/);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test("baseline validation findings stay diagnostic instead of aborting before render and QC", () => {
  const source = readFileSync(new URL("../pipeline/run.ts", import.meta.url), "utf8");
  // `const composer =` also appears earlier, in the post-render QC repair helper, so the
  // end of the branch has to be searched forward from its start rather than from the top.
  const start = source.indexOf("if (baselineOnly)");
  const branch = source.slice(start, source.indexOf("const composer =", start));
  assert.ok(start >= 0 && branch.length > 0, "the baseline-only branch was not found");
  assert.doesNotMatch(branch, /throw new Error/);
  assert.match(branch, /render\/QC will record the result/);
});
