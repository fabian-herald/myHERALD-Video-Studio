import fs from "node:fs/promises";
import path from "node:path";
import {ROOT} from "../../paths.ts";
import {videoPlanZ} from "../../plan/schema.ts";
import type {AlignmentTarget} from "../align.ts";
import type {BakeoffLanguage, BakeoffScript} from "./types.ts";

/**
 * The bake-off script, in both languages, from committed fixtures.
 *
 * The German half always read a fixture; the English half read
 * `data/videos/<id>/plan.json`, which is a working directory, is gitignored, and is
 * therefore absent on any fresh checkout — so these tests could only ever have passed on
 * one machine. Renaming the video folders is what finally surfaced it: seven tests started
 * failing on a hardcoded id that no longer existed.
 *
 * Both halves are now fixtures. A bake-off compares voices against a fixed script, and a
 * fixed script is exactly what a fixture is for.
 */
export const BAKEOFF_SCRIPT_ID = "the-second-draft";

export async function loadBakeoffScript(
  videoId: string = BAKEOFF_SCRIPT_ID,
  language: BakeoffLanguage = "en",
): Promise<BakeoffScript> {
  const file = path.join(ROOT, `data/narration-bakeoff/${BAKEOFF_SCRIPT_ID}.${language}.json`);
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as BakeoffScript;
  validateScript(parsed, videoId, language);
  return parsed;
}

function validateScript(script: BakeoffScript, videoId: string, language: BakeoffLanguage) {
  if (script.videoId !== videoId || script.language !== language) {
    throw new Error(`Script identity mismatch: expected ${videoId}/${language}.`);
  }
  if (script.sections.length !== 7) {
    throw new Error(`${language} bake-off script must contain exactly seven spoken sections.`);
  }
  const phrases = script.sections.flatMap((section) => section.phrases);
  if (phrases.length !== 27 || phrases.some((phrase) => !phrase.text.trim())) {
    throw new Error(`${language} bake-off script must contain exactly 27 non-empty phrases.`);
  }
}

export const plainTranscript = (script: BakeoffScript) =>
  script.sections.map((section) => section.phrases.map((phrase) => phrase.text).join(" ")).join("\n\n");

export const alignmentTargets = (script: BakeoffScript): AlignmentTarget[] =>
  script.sections.flatMap((section) => section.phrases.map((phrase) => ({
    sectionId: section.id,
    phraseId: phrase.id,
    text: phrase.text,
  })));

export const sectionTexts = (script: BakeoffScript) =>
  script.sections.map((section) => section.phrases.map((phrase) => phrase.text).join(" "));

export function pauseTaggedTranscript(script: BakeoffScript) {
  return script.sections.map((section) =>
    section.phrases.map((phrase) => phrase.text).join(" [short pause] "),
  ).join("\n[medium pause]\n");
}

const PERFORMANCE_TAGS = [
  "observant", "reflective", "informative", "conviction", "firm", "reflective", "confident",
] as const;

/** Gemini Studio-style performance tags, held identical for the Achird/Algenib A/B. */
export function performanceTaggedTranscript(script: BakeoffScript) {
  return script.sections.map((section, index) => {
    const phrases = section.phrases.map((phrase) => phrase.text).join(" [short pause] ");
    return `[${PERFORMANCE_TAGS[index]}] ${phrases}`;
  }).join("\n[medium pause]\n");
}

export function ssmlTranscript(script: BakeoffScript) {
  const sections = script.sections.map((section) =>
    section.phrases.map((phrase) => escapeXml(phrase.text)).join('<break time="250ms"/>'),
  );
  return `<speak>${sections.join('<break time="650ms"/>')}</speak>`;
}

const escapeXml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
