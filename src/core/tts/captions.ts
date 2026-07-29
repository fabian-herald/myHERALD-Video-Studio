import fs from "node:fs/promises";
import path from "node:path";
import {TIMING_PROVENANCE, type VideoPlan} from "../plan/schema.ts";

export interface CaptionPage {
  cueIndex: number;
  sectionId: string;
  fromMs: number;
  toMs: number;
  text: string;
}

export interface CaptionToken {
  cueIndex: number;
  text: string;
  fromMs: number;
  toMs: number;
}

export interface CaptionData {
  pages: CaptionPage[];
  tokens: CaptionToken[];
  /** Stated plainly so nobody mistakes this for forced alignment. */
  alignment: string;
}

/** Trailing punctuation earns extra time because speakers pause on it. */
function weightOf(word: string) {
  const base = Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length);
  const punctuation = /[.!?]$/.test(word) ? 5 : /[,;:—–]$/.test(word) ? 2.5 : 0;
  return base + punctuation;
}

/**
 * Page boundaries are exact, by one of two routes: a phrase synthesised as its own
 * clip and measured with ffprobe, or a phrase located inside one continuous take by
 * ASR word timings. Which one applies is recorded on the plan, because this function
 * cannot tell from the numbers alone and must not guess in the provenance record.
 *
 * Word placement *within* a page is estimated either way, by character and
 * punctuation weight. That is a documented approximation.
 */
export function buildCaptions(plan: VideoPlan): CaptionData {
  const pages: CaptionPage[] = [];
  const tokens: CaptionToken[] = [];
  let cueIndex = 0;

  for (const section of plan.sections) {
    for (const phrase of section.phrases) {
      if (!phrase.durationMs) continue;
      const fromMs = phrase.startMs;
      const toMs = phrase.startMs + phrase.durationMs;
      pages.push({cueIndex, sectionId: section.id, fromMs, toMs, text: phrase.text});

      const words = phrase.text.trim().split(/\s+/).filter(Boolean);
      const weights = words.map(weightOf);
      const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;

      let cursor = fromMs;
      words.forEach((word, index) => {
        const share = ((weights[index] ?? 1) / total) * phrase.durationMs;
        const start = Math.round(cursor);
        cursor += share;
        tokens.push({
          cueIndex,
          text: word,
          fromMs: start,
          toMs: index === words.length - 1 ? toMs : Math.round(cursor),
        });
      });
      cueIndex += 1;
    }
  }

  return {
    pages,
    tokens,
    alignment: `${TIMING_PROVENANCE[plan.narration.timing]}; `
      + "word placement within a page by character-and-punctuation weight",
  };
}

/** Written next to the composition and loaded before animation.js. */
export async function writeCaptionData(data: CaptionData, target: string) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  const body = `// GENERATED — page boundaries are measured, word placement is weighted.\n`
    + `window.__captionData = ${JSON.stringify(data, null, 2)};\n`;
  await fs.writeFile(target, body, "utf8");
}

/** The exact transcript the rendered captions must reproduce, for QC. */
export const captionTranscript = (data: CaptionData) =>
  data.pages.map((page) => page.text).join(" ").replace(/\s+/g, " ").trim();
