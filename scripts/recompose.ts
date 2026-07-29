/**
 * Re-author an existing video's composition against the current brief, reusing its plan
 * and its narration:
 *
 *   npm run recompose -- <videoId> [suffix]
 *
 * For testing a change to the contract, the blocks or the motion brief without spending
 * a planning call and a TTS take, and without the script and the voice changing
 * underneath the comparison. Outputs land beside the originals as `master-9x16-<suffix>`.
 *
 * Two things it deliberately does NOT do, so read its output accordingly: it renders one
 * format rather than the family, and it skips the single QC-repair pass that
 * `runPipeline` gives the composer after a post-render failure. A `qc FAILED` here is
 * therefore a raw first result — through `npm run make` the same composition would get
 * one chance to fix it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../src/core/brand/kit.ts";
import {FPS, prepareAuthoringDir, sectionSnapshotTimes} from "../src/core/compose/workdir.ts";
import {composeWithRepair} from "../src/core/pipeline/run.ts";
import {loadPlan, planDurationMs} from "../src/core/plan/schema.ts";
import {OUT_DIR, videoDir} from "../src/core/paths.ts";
import {buildContactSheet, buildCover} from "../src/core/render/artifacts.ts";
import {emitFormat, renderSnapshots, renderVideo} from "../src/core/render/hyperframes.ts";
import {runQc, writeQc} from "../src/core/render/qc.ts";
import {buildCaptions} from "../src/core/tts/captions.ts";

const videoId = process.argv[2];
if (!videoId) {
  console.error("usage: npm run recompose -- <videoId> [suffix]");
  process.exit(1);
}
const suffix = process.argv[3] ?? "motion";
const dir = videoDir(videoId);
const log = (line: string) => console.log(line);

const plan = await loadPlan(path.join(dir, "plan.json"));
const kit = await loadBrandKit();
const narrationPath = path.join(dir, "narration-narration-loudnorm-v2.m4a");
await fs.access(narrationPath);

const authoringDir = path.join(dir, "work", `portrait-${suffix}`);
await fs.rm(authoringDir, {recursive: true, force: true});
await fs.mkdir(authoringDir, {recursive: true});
const authoring = await prepareAuthoringDir({plan, kit, family: "portrait", dir: authoringDir, narrationPath});

log(`recompose     ${videoId} · ${plan.sections.length} sections · ${authoring.durationSeconds}s`);
const composed = await composeWithRepair({
  authoring, plan, kit, family: "portrait", composerId: "claude", baselineOnly: false, log,
});
log(`compose       attempts ${composed.attempts} · baseline ${composed.usedBaseline}`);

const format = "9x16" as const;
const renderDir = path.join(dir, "render", `${format}-${suffix}`);
await emitFormat(authoring.dir, format, renderDir);
const outPath = path.join(OUT_DIR, videoId, `master-${format}-${suffix}.mp4`);
await renderVideo({dir: renderDir, outputPath: outPath, quality: "high"});

const frames = await renderSnapshots({
  dir: renderDir,
  durationSeconds: authoring.durationSeconds,
  at: sectionSnapshotTimes(plan),
  outputDir: path.join(renderDir, "snapshots"),
});
const sheet = await buildContactSheet(frames, path.join(OUT_DIR, videoId, `contact-sheet-${suffix}.png`));
const cover = await buildCover(frames, path.join(OUT_DIR, videoId, `cover-${suffix}.png`));

const qc = await runQc({
  videoPath: outPath,
  format,
  expectedDurationMs: planDurationMs(plan),
  fps: FPS,
  captions: buildCaptions(plan),
  coverPath: cover ?? undefined,
});
await writeQc(qc, path.join(OUT_DIR, videoId, `qc-${format}-${suffix}.json`));
log(`qc            ${qc.passed ? "passed" : `FAILED — ${(qc.diagnostics.failed as string[]).join(", ")}`}`);
log(`out           ${outPath}`);
log(`sheet         ${sheet}`);
