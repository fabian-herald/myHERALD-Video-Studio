import type {Provenance} from "./artifacts.ts";
import type {QcReport} from "./qc.ts";

/**
 * `provenance.json` in a form someone will actually read.
 *
 * Everything below is already recorded — model, effort, turns, voice, sizes, hashes — and
 * all of it is in a 120-line JSON file inside `out/`, which is not where anyone looks and
 * not a thing anyone reads to answer "which model did what on this one". So the same facts
 * get written next to the video as plain text.
 *
 * A rendering, not a second source of truth: nothing here is computed that provenance does
 * not already hold, so the two cannot disagree about anything.
 */

/**
 * Provenance as it may actually be found on disk.
 *
 * Every field here exists in the current shape. Older files predate some of them — the
 * first ones recorded no composer effort, no sizes and no marketing guidance — and this
 * renders historical records as much as new ones, so it reads defensively and says "—"
 * where a run genuinely did not record something. Inventing a plausible value would make
 * the summary disagree with the file it claims to summarise.
 */
type StoredProvenance = {
  [K in keyof Provenance]?: Provenance[K] extends object
    ? Partial<Provenance[K]>
    : Provenance[K];
};

export interface SummaryInput {
  provenance: StoredProvenance;
  title: string;
  brief: string;
  language: string;
  sections: number;
  phrases: number;
  durationMs: number;
  quality: string;
  outputs: readonly {format: string; path: string; qc: QcReport}[];
  /** Total wall clock and the stage that took most of it. */
  timing?: {totalMs: number; slowest?: {name: string; ms: number}};
}

const pad = (label: string) => label.padEnd(20);

const duration = (ms: number) => {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
};

/** `codex · gpt-5.6-terra`, and just the provider when there is no model to name. */
const who = (provider: string, model?: string) =>
  model && model !== "n/a" && model !== provider ? `${provider} · ${model}` : provider || "—";

const wrap = (text: string, width = 78): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
};

export function renderSummary(input: SummaryInput): string {
  const p = input.provenance;
  const planner = p.planner ?? {};
  const composer = p.composer ?? {};
  const narration = p.narration ?? {};
  const cost = p.cost ?? {};
  const out: string[] = [];

  const heading = input.title || p.videoId || "Untitled";
  out.push(heading, "=".repeat(heading.length), "");
  out.push(p.videoId ?? "", p.createdAt ? new Date(p.createdAt).toLocaleString() : "", "");
  if (p.thesis) out.push(...wrap(p.thesis), "");
  if (input.brief) out.push("Brief:", ...wrap(input.brief).map((line) => `  ${line}`), "");

  out.push("WHO MADE WHAT", "");
  out.push(`  ${pad("strategy & script")}${who(planner.provider ?? "", planner.model)}`);
  const composerLine = [
    who(composer.provider ?? "", composer.model),
    composer.effort && composer.effort !== "n/a" ? `${composer.effort} effort` : "",
    // Attempts is the one that says whether it went smoothly. 1 means it passed first time.
    composer.attempts ? `${composer.attempts} attempt${composer.attempts === 1 ? "" : "s"}` : "",
    composer.turns ? `${composer.turns} turns` : "",
    composer.actions ? `${composer.actions} actions` : "",
  ].filter(Boolean).join(" · ");
  out.push(`  ${pad("composition")}${composerLine || "—"}`);
  out.push(`  ${pad("narration")}${who(narration.provider ?? "", narration.model)}`
    + (narration.voice ? ` · voice ${narration.voice}` : "")
    + (narration.cloned ? " (cloned)" : ""));
  const alignment = p.captionAlignment || "";
  // A sentence, not a value — it runs to 150 characters and wrecks the column if inlined.
  out.push(`  ${pad("word timings")}${alignment.split(";")[0]?.trim() || "—"}`);
  out.push(`  ${pad("renderer")}${[p.visualEngine, p.hyperframesVersion].filter(Boolean).join(" ") || "—"}`);
  if (p.marketingGuidance?.length) {
    out.push(`  ${pad("planning aids")}${p.marketingGuidance.join(", ")}`);
  }
  out.push("");

  out.push("CONFIGURATION", "");
  out.push(`  ${pad("intent")}${p.intent ?? "—"}`);
  out.push(`  ${pad("narration profile")}${narration.profileId ?? "—"}`);
  out.push(`  ${pad("formats")}${p.formats?.join(", ") ?? "—"}`);
  out.push(`  ${pad("language")}${input.language}`);
  out.push(`  ${pad("render quality")}${input.quality}`);
  out.push(`  ${pad("timing treatment")}${narration.timingTreatment ?? "—"}`
    + (narration.sectionGapMs ? ` · gaps capped at ${narration.sectionGapMs}ms` : ""));
  out.push("");

  out.push("RESULT", "");
  out.push(`  ${pad("length")}${(input.durationMs / 1000).toFixed(2)}s · `
    + `${input.sections} sections · ${input.phrases} phrases`);
  const size = composer.sizeFinal ?? composer.size;
  if (size) {
    out.push(`  ${pad("composition size")}${size.lines["styles.css"]} css · ${size.lines["index.html"]} html`
      + ` · ${size.lines["animation.js"]} js · ${size.cssRules} rules · ${size.gsapCalls} gsap`);
    // Both numbers, when they differ: it is the only way to see whether the composer
    // authored a dense frame or the visual-review pass rescued a thin one.
    if (composer.size && composer.sizeFinal
      && composer.size.lines["styles.css"] !== composer.sizeFinal.lines["styles.css"]) {
      out.push(`  ${pad("")}(as authored: ${composer.size.lines["styles.css"]} css, `
        + `before the visual-review pass)`);
    }
  }
  for (const output of input.outputs) {
    const failed = output.qc.passed ? "" : ` — ${(output.qc.diagnostics.failed as string[] ?? []).join(", ")}`;
    out.push(`  ${pad(output.format)}${output.qc.passed ? "QC passed" : "QC FAILED"}${failed}`);
  }
  if (input.timing) {
    out.push(`  ${pad("run time")}${duration(input.timing.totalMs)}`
      + (input.timing.slowest
        ? ` · ${input.timing.slowest.name} took ${Math.round(input.timing.slowest.ms / input.timing.totalMs * 100)}%`
        : ""));
  }
  if ((cost.chargedUsd ?? 0) > 0 || (cost.apiEquivalentUsd ?? 0) > 0) {
    out.push(`  ${pad("cost")}${cost.billingMode ?? "?"} · charged $${(cost.chargedUsd ?? 0).toFixed(2)}`
      + ` · would cost $${(cost.apiEquivalentUsd ?? 0).toFixed(2)} on metered APIs`);
  }
  out.push("");

  if (p.knownLimitations?.length) {
    out.push("KNOWN LIMITATIONS", "");
    for (const limitation of p.knownLimitations) out.push(...wrap(limitation ?? "").map((l) => `  ${l}`));
    out.push("");
  }

  out.push(`Full detail: out/${p.videoId ?? ""}/provenance.json`);
  return `${out.join("\n")}\n`;
}
