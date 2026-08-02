import fs from "node:fs/promises";
import path from "node:path";
import {
  MIN_SAMPLED_WINDOW_MS,
  SAMPLE_SPACING_MS,
  describeWindow,
  sampleTimes,
  stillWindows,
  windowMs,
  type StillWindow,
} from "../compose/still.ts";
import type {VideoPlan} from "../plan/schema.ts";
import {run} from "../util/exec.ts";
import {renderSnapshots} from "./hyperframes.ts";

/**
 * Peak-signal-to-noise ratio, in dB, at or above which the sampled part of a long hold
 * counts as standing still.
 *
 * Calibrated against every composition in `data/videos`. The original calibration used
 * frames 500ms apart; the current wider pair preserves the same conservative boundary for
 * detecting an unchanged state while allowing a discrete visual beat between samples:
 *
 * | composition | QC verdict | highest reading |
 * |---|---|---|
 * | a2ab00, cbedeb, 255684, 5741a2, 85b912 | no freeze | 28.3 – 32.9 |
 * | a83a00 | no freeze | **37.5** |
 * | ed8445 | 1 freeze | 42.2 |
 * | 466bde | 1 freeze | 44.1 (3 windows over 38) |
 * | ce0ec6 | 7 freezes | 45.4 (6 windows over 38) |
 *
 * So 38 is the bottom of the gap, and a83a00's 37.5 is why it is not lower: that
 * composition passed the post-render check, and failing it here would burn a repair pass
 * on a scene that was going to be fine. The margin above the clean cluster is wide (5dB);
 * the margin below the flagged one is 0.6dB, and a reading in the high thirties is a scene
 * that is barely moving either way.
 *
 * A derived threshold was tried first and was simply wrong. `freezedetect=n=0.001` reads
 * as 52–53dB between *consecutive* frames, not the 60dB the filter's documented noise
 * figure suggests, and consecutive frames are far too noisy to sample at all — the encoder's
 * own floor sits on top of any real motion. The wider current sample is intentionally about
 * visual state change, not continuous per-frame motion.
 */
export const FROZEN_PSNR_DB = 38;

/**
 * A long video with many short phrases can produce a hundred windows. Sampling stays
 * proportional by taking the longest ones — a longer window is both likelier to freeze and
 * worse when it does — and the count that was skipped is reported rather than swallowed.
 */
export const MAX_SAMPLED_WINDOWS = 40;

export interface FrozenWindow {
  window: StillWindow;
  psnrDb: number;
  frames: [string, string];
}

export interface MotionSample {
  sampled: number;
  skipped: number;
  frozen: FrozenWindow[];
}

/**
 * Does the picture meaningfully evolve where the caption layer has gone quiet?
 *
 * The composition is checked here rather than the finished file because by the time QC
 * runs, the render has been paid for. `checkComposition`'s other gates read the source;
 * this one has to look at pixels, since the defect is precisely that markup which passes
 * every structural rule can still paint the same frame for two seconds.
 *
 * Sound, not complete: two sampled frames cannot prove a scene never stalls, only that this
 * stretch of it evolved. The post-render freeze check stays where it is.
 */
export async function sampleMotion(options: {
  dir: string;
  plan: VideoPlan;
  outputDir?: string;
  onLog?: (line: string) => void;
}): Promise<MotionSample> {
  const {dir, plan, onLog} = options;
  const all = stillWindows(plan).filter((window) => windowMs(window) >= MIN_SAMPLED_WINDOW_MS);
  const windows = [...all]
    .sort((a, b) => windowMs(b) - windowMs(a))
    .slice(0, MAX_SAMPLED_WINDOWS)
    .sort((a, b) => a.fromMs - b.fromMs);

  if (!windows.length) return {sampled: 0, skipped: 0, frozen: []};

  const outputDir = options.outputDir ?? path.join(dir, ".motion-check");
  await fs.rm(outputDir, {recursive: true, force: true});

  const times = windows.flatMap((window) => sampleTimes(window));
  const frames = await renderSnapshots({
    dir,
    durationSeconds: 0,
    outputDir,
    at: times.map((seconds) => seconds.toFixed(2)).join(","),
  });

  // A gate that measures nothing looks exactly like a gate that found nothing, and this
  // one did: a relative output path made the snapshot land somewhere the reader never
  // looked, every window came back unmeasured, and three compositions with known freezes
  // were waved through with "0 frozen". Anything short of a full set is a failure to run.
  if (frames.length !== times.length) {
    throw new Error(
      `expected ${times.length} frames for ${windows.length} still windows, got ${frames.length}`,
    );
  }

  const frozen: FrozenWindow[] = [];
  let unmeasured = 0;
  for (const [index, window] of windows.entries()) {
    const first = frames[index * 2] as string;
    const second = frames[index * 2 + 1] as string;
    const psnrDb = await framePsnr(first, second);
    if (Number.isNaN(psnrDb)) {
      unmeasured += 1;
      continue;
    }
    if (psnrDb >= FROZEN_PSNR_DB) frozen.push({window, psnrDb, frames: [first, second]});
  }
  if (unmeasured) throw new Error(`ffmpeg returned no reading for ${unmeasured} of ${windows.length} windows`);

  const skipped = all.length - windows.length;
  onLog?.(`  motion       ${windows.length} still windows sampled, ${frozen.length} frozen`
    + (skipped ? `, ${skipped} shorter windows not sampled` : ""));
  return {sampled: windows.length, skipped, frozen};
}

/**
 * Identical frames give `inf`, which is the answer, not an error — so it is mapped to
 * Infinity rather than parsed as a number and silently becoming NaN.
 */
export async function framePsnr(first: string, second: string): Promise<number> {
  const result = await run("ffmpeg", [
    "-hide_banner", "-i", first, "-i", second, "-lavfi", "psnr", "-f", "null", "-",
  ]).catch((error: unknown) => error as {stderr?: string});

  return parsePsnr(result.stderr ?? "");
}

/** Pure, so the parse is tested without running ffmpeg. */
export function parsePsnr(stderr: string): number {
  const found = /PSNR[^\n]*\baverage:(\S+)/.exec(stderr);
  if (!found) return Number.NaN;
  if (found[1] === "inf") return Number.POSITIVE_INFINITY;
  const value = Number(found[1]);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * One finding per frozen window, phrased as the repair the composer has to make.
 *
 * The reading is quoted with the clean range beside it, because "add motion" is what the
 * contract has said all along and what produced these compositions. A number it can aim at,
 * and the two frames to look at, is the part that was missing.
 */
export function describeFrozen({window, psnrDb, frames}: FrozenWindow): string {
  const reading = psnrDb === Number.POSITIVE_INFINITY
    ? "the two frames are pixel-identical"
    : `they differ by ${psnrDb.toFixed(1)}dB PSNR, where a moving scene reads under 33`;
  return `scene-${window.sectionId} does not visibly evolve ${describeWindow(window)}. Two frames `
    + `${SAMPLE_SPACING_MS / 1000}s apart in the middle of it were compared and ${reading}. `
    + `Look at ${path.basename(frames[0])} and ${path.basename(frames[1])}. Add one meaningful `
    + "visual beat inside this span, such as a reveal, count, comparison, connection, progress "
    + "step or transition. It may hold after that beat. Do not add perpetual drift merely to "
    + "satisfy the check; the change should communicate something and affect meaningful area.";
}
