import fs from "node:fs/promises";
import path from "node:path";
import {run} from "../util/exec.ts";
import type {CompositionSize} from "../gen/substance.ts";

/**
 * The contact sheet is the fastest honest review in the system: representative frames
 * side by side answer "are these scenes structurally different?" in about three seconds,
 * which is the one question no automated check can settle.
 */
export async function buildContactSheet(
  frames: readonly string[],
  outputPath: string,
  columns = 4,
): Promise<string | null> {
  if (!frames.length) return null;
  await fs.mkdir(path.dirname(outputPath), {recursive: true});

  const rows = Math.ceil(frames.length / columns);
  const inputs = frames.flatMap((frame) => ["-i", frame]);
  const scaled = frames
    .map((_, index) => `[${index}:v]scale=380:-1,pad=iw+8:ih+8:4:4:black[t${index}]`)
    .join(";");
  const tiled = `${frames.map((_, index) => `[t${index}]`).join("")}xstack=inputs=${frames.length}:layout=${stackLayout(frames.length, columns)}[out]`;

  await run("ffmpeg", [
    "-y", ...inputs,
    "-filter_complex", `${scaled};${tiled}`,
    "-map", "[out]",
    "-frames:v", "1",
    outputPath,
  ]).catch(async () => {
    // xstack needs a full grid; fall back to a single row when the count is awkward.
    await run("ffmpeg", [
      "-y", ...inputs,
      "-filter_complex",
      `${scaled};${frames.map((_, index) => `[t${index}]`).join("")}hstack=inputs=${frames.length}[out]`,
      "-map", "[out]", "-frames:v", "1", outputPath,
    ]);
  });

  void rows;
  return outputPath;
}

/** xstack layout string: `0_0|w0_0|0_h0|w0_h0` style grid coordinates. */
function stackLayout(count: number, columns: number): string {
  return Array.from({length: count}, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column === 0 ? "0" : Array.from({length: column}, (_, i) => `w${i}`).join("+");
    const y = row === 0 ? "0" : Array.from({length: row}, (_, i) => `h${i * columns}`).join("+");
    return `${x}_${y}`;
  }).join("|");
}

/** A representative still, taken from the frames already rendered for the sheet. */
export async function buildCover(frames: readonly string[], outputPath: string): Promise<string | null> {
  const source = frames[Math.min(1, frames.length - 1)];
  if (!source) return null;
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await fs.copyFile(source, outputPath);
  return outputPath;
}

export interface Provenance {
  videoId: string;
  createdAt: string;
  thesis: string;
  intent: string;
  planner: {provider: string; model: string};
  /** Optional planning aids that were actually present in the prompt for this run. */
  marketingGuidance: readonly string[];
  composer: {
    provider: string;
    model: string;
    /** The thinking budget the composition was authored under. */
    effort: string;
    turns: number;
    actions: number;
    attempts: number;
    /**
     * How much composition there is, as authored and as finally shipped. Both, because the
     * pair answers the question a single number cannot: did the composer author a dense
     * frame, or did the visual-review pass rescue a thin one?
     */
    size: CompositionSize | null;
    sizeFinal: CompositionSize | null;
  };
  /** How varied the finished script turned out, measured from the real audio. */
  rhythm: {
    variation: number;
    shortestMs: number;
    longestMs: number;
    meanMs: number;
    energies: readonly string[];
    notes: readonly string[];
  };
  narration: {
    provider: string;
    model: string;
    voice: string;
    cloned: boolean;
    phrases: number;
    profileId: string;
    timingTreatment: string;
    sectionGapMs?: number;
    sectionGapsShortened?: number;
  };
  visualEngine: string;
  hyperframesVersion: string;
  planHash: string;
  tokensHash: string;
  formats: string[];
  cost: {billingMode: string; chargedUsd: number; apiEquivalentUsd: number; entries: unknown[]};
  captionAlignment: string;
  knownLimitations: string[];
  outputFileHashes: Record<string, string>;
}

export async function writeProvenance(provenance: Provenance, target: string) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}
