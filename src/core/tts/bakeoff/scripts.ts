import fs from "node:fs/promises";
import path from "node:path";
import {ROOT} from "../../paths.ts";
import {videoPlanZ} from "../../plan/schema.ts";
import type {AlignmentTarget} from "../align.ts";
import type {BakeoffLanguage, BakeoffScript} from "./types.ts";

export async function loadBakeoffScript(videoId: string, language: BakeoffLanguage): Promise<BakeoffScript> {
  if (language === "de") {
    const file = path.join(ROOT, "data/narration-bakeoff/the-second-draft.de.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as BakeoffScript;
    validateScript(parsed, videoId, language);
    return parsed;
  }

  const file = path.join(ROOT, "data/videos", videoId, "plan.json");
  const plan = videoPlanZ.parse(JSON.parse(await fs.readFile(file, "utf8")));
  const sections = plan.sections
    .filter((section) => section.phrases.length > 0)
    .map((section) => ({
      id: section.id,
      phrases: section.phrases.map((phrase) => ({id: phrase.id, text: phrase.text})),
    }));
  const script: BakeoffScript = {videoId, language, sections};
  validateScript(script, videoId, language);
  return script;
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
