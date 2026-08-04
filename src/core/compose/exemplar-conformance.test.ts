import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {loadBrandKit} from "../brand/kit.ts";
import {videoPlanZ, type VideoPlan} from "../plan/schema.ts";
import {checkComposition, formatFindings} from "../render/check.ts";
import {COMPOSITION_FILES} from "../gen/composer.ts";
import {FPS, prepareAuthoringDir} from "./workdir.ts";

/**
 * The exemplar against the full gate, the way a real composition meets it.
 *
 * `exemplar.test.ts` covers the checks that need nothing but the files. Three more —
 * `checkTokens`, `checkPlanConformance` and the HyperFrames CLI itself — are unexported and
 * reachable only through `checkComposition`, and no test in `src/` called it at all. That is
 * the gap this closes: the reference every composer is told to match had never been run
 * through the gate every composition is held to.
 *
 * It shells out to the HyperFrames CLI and takes tens of seconds, so it is opt-in:
 *
 *     STUDIO_INTEGRATION=1 npm test
 *
 * Two fixtures make it possible. `exemplar-plan.fixture.json` is the plan dba07c was
 * rendered from, without which `checkPlanConformance` has nothing to compare against.
 * `exemplar-narration.fixture.m4a` is 45.74s of silence, because `prepareAuthoringDir` does
 * a plain `copyFile` of the narration — committing a silent track is cheaper and safer than
 * adding a no-narration branch to production code purely to serve a test.
 */

const skip = process.env.STUDIO_INTEGRATION
  ? false
  : "set STUDIO_INTEGRATION=1 to run (drives the HyperFrames CLI)";

const EXEMPLAR = fileURLToPath(new URL("./exemplar/", import.meta.url));

test("the exemplar passes the same gate every composition is held to", {skip}, async () => {
  const plan: VideoPlan = videoPlanZ.parse(
    JSON.parse(await fs.readFile(new URL("./exemplar-plan.fixture.json", import.meta.url), "utf8")),
  );
  const kit = await loadBrandKit();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-exemplar-"));

  try {
    await prepareAuthoringDir({
      plan,
      kit,
      family: "portrait",
      dir,
      narrationPath: fileURLToPath(new URL("./exemplar-narration.fixture.m4a", import.meta.url)),
    });
    for (const file of COMPOSITION_FILES) {
      await fs.copyFile(path.join(EXEMPLAR, file), path.join(dir, file));
    }

    // Motion sampling wants a browser and a full render; the point here is the static gate.
    const report = await checkComposition({dir, plan, kit, family: "portrait", fps: FPS, sampleMotion: false});
    assert.equal(report.errorCount, 0, formatFindings(report, 20));
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});
