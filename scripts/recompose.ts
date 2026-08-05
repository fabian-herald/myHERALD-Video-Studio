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
import {OUT_DIR, rel, videoDir} from "../src/core/paths.ts";
import {amendLedgerEntry} from "../src/core/ledger.ts";
import {buildContactSheet, buildCover, type Provenance} from "../src/core/render/artifacts.ts";
import {emitFormat, renderSnapshots, renderVideo} from "../src/core/render/hyperframes.ts";
import {runQc, writeQc} from "../src/core/render/qc.ts";
import {billingMode} from "../src/core/cost.ts";
import {readSettings} from "../src/core/settings.ts";
import {compositionSize} from "../src/core/gen/substance.ts";
import {buildCaptions} from "../src/core/tts/captions.ts";

const argv = process.argv.slice(2);
const positional = argv.filter((value, index) =>
  !value.startsWith("--") && !argv[index - 1]?.startsWith("--"));
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const videoId = positional[0];
if (!videoId) {
  console.error(
    "usage: npm run recompose -- <videoId> [suffix] [composer]\n"
    + "       npm run recompose -- <videoId> [suffix] --render-only [--from <workDirName>]\n\n"
    + "  --render-only  render an authored composition that already exists, spending no\n"
    + "                 model call. For recovering a run that composed cleanly and then\n"
    + "                 lost its render — a crash, a cancel, or an exhausted usage limit.\n"
    + "  --from         work/ subdirectory to render (default: portrait)\n"
    + "  --record       promote the result to the run's real output: canonical filename,\n"
    + "                 provenance corrected, ledger status set from QC\n",
  );
  process.exit(1);
}
const suffix = positional[1] ?? "motion";
const settings = await readSettings();
const composerId = positional[2] ?? settings.composer;
const renderOnly = argv.includes("--render-only");
const record = argv.includes("--record");
const dir = videoDir(videoId);
const log = (line: string) => console.log(line);

const plan = await loadPlan(path.join(dir, "plan.json"));
const kit = await loadBrandKit();
const narrationPath = path.join(dir, "narration-narration-loudnorm-v2.m4a");
await fs.access(narrationPath);

const authoringDir = renderOnly
  ? path.join(dir, "work", flag("from") ?? "portrait")
  : path.join(dir, "work", `portrait-${suffix}`);

if (!renderOnly) {
  await fs.rm(authoringDir, {recursive: true, force: true});
}
await fs.mkdir(authoringDir, {recursive: true});
// Safe either way: the scaffolding this writes is every file *except* the three the
// composer owns, so refreshing it over an existing composition cannot disturb the work.
const authoring = await prepareAuthoringDir({
  plan, kit, family: "portrait", dir: authoringDir, narrationPath,
});

if (renderOnly) {
  for (const file of ["index.html", "styles.css", "animation.js"]) {
    await fs.access(path.join(authoringDir, file)).catch(() => {
      console.error(`No ${file} in ${authoringDir}. There is no composition here to render.`);
      process.exit(1);
    });
  }
  log(`render-only   ${videoId} · ${path.basename(authoringDir)} · no model call`);
} else {
  log(`recompose     ${videoId} · ${plan.sections.length} sections · ${authoring.durationSeconds}s · ${composerId}`);
  const composed = await composeWithRepair({
    authoring, plan, kit, family: "portrait", composerId, baselineOnly: false, log,
  });
  log(`compose       attempts ${composed.attempts} · baseline ${composed.usedBaseline}`);
  // `composeWithRepair` has always returned this and this script has always thrown it away,
  // which made the one workflow built for comparing composers the one with no price on it.
  // Same two-number split `runPipeline` reports: what leaves an account, and what the same
  // token usage would list at metered API prices (see `src/core/cost.ts`).
  const charged = billingMode() === "api" ? composed.costUsd : 0;
  log(`cost          $${charged.toFixed(2)} charged · $${composed.costUsd.toFixed(2)} at API list prices`
    + ` · ${composerId} · ${(composerId === "codex" ? settings.codexModel : settings.claudeModel) || "default"}`);
}

// `--record` promotes the result to the run's real output rather than a suffixed
// comparison artifact, so the canonical filename is the one the Studio already expects.
const format = "9x16" as const;
const renderDir = path.join(dir, "render", `${format}-${suffix}`);
await emitFormat(authoring.dir, format, renderDir);
const outPath = path.join(
  OUT_DIR,
  videoId,
  record ? `master-${format}.mp4` : `master-${format}-${suffix}.mp4`,
);
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
await writeQc(qc, path.join(OUT_DIR, videoId, record ? `qc-${format}.json` : `qc-${format}-${suffix}.json`));
log(`qc            ${qc.passed ? "passed" : `FAILED — ${(qc.diagnostics.failed as string[]).join(", ")}`}`);
log(`out           ${outPath}`);
log(`sheet         ${sheet}`);

if (record) {
  // The pipeline records a run only after every stage returns, so a run that authored
  // cleanly and then died still reads as a total failure. Correct the record — without
  // pretending the stages that never ran did: the reason stays in knownLimitations.
  const provenancePath = path.join(OUT_DIR, videoId, "provenance.json");
  // The real type, not a structural copy — the copy silently drifted the last time the
  // composer block grew a field. Partial because a recovered run may predate any of them.
  const provenance = JSON.parse(await fs.readFile(provenancePath, "utf8")) as
    Omit<Partial<Provenance>, "composer"> & {composer?: Partial<Provenance["composer"]>};

  // The composition is on disk and unchanged, so its size is measurable even though the run
  // that produced it never got far enough to record one.
  const snapshot: Record<string, string> = {};
  for (const file of ["index.html", "styles.css", "animation.js"]) {
    snapshot[file] = await fs.readFile(path.join(authoringDir, file), "utf8");
  }
  const size = compositionSize(snapshot);
  provenance.composer = {...provenance.composer, provider: composerId, size, sizeFinal: size};
  provenance.knownLimitations = [
    ...(provenance.knownLimitations ?? []).filter((note) => !/family failed before completion/.test(note)),
    `Recovered after the run aborted: the composition passed every check and was rendered `
    + `from work/${path.basename(authoringDir)} without a model call, so any review pass `
    + `still outstanding when the run stopped did not run.`,
  ];
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

  await amendLedgerEntry(videoId, {
    status: qc.passed ? "ready" : "failed",
    outputs: [{format, path: rel(outPath)}],
  });
  log(`recorded      ledger status ${qc.passed ? "ready" : "failed"} · provenance updated`);
  log(`size          ${size.lines["styles.css"]} css · ${size.gsapCalls} gsap · min ${size.minElementsPerScene} el/scene`);
}
