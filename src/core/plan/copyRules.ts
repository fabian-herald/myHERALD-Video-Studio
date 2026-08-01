import type {BrandKit} from "../brand/kit.ts";
import {CAPTION_MAX_CHARS, CAPTION_MAX_WORDS} from "../render/qc.ts";
import type {VideoPlan} from "./schema.ts";

type VoiceRules = Pick<BrandKit["voice"], "bannedWords">;

/**
 * Copy rules shared by initial planning and the cheap edit path.
 *
 * Returning prose lets the planner feed the exact violations back into its retry. The
 * edit path wraps the same result in an exception before TTS, file writes, or renders.
 */
export function copyRulesViolation(plan: VideoPlan, rules: VoiceRules): string | null {
  const problems: string[] = [];
  const rawCopy = plan.sections
    .flatMap((section) => [section.onScreen, ...section.phrases.map((phrase) => phrase.text)])
    .join(" ");
  const allCopy = rawCopy.toLowerCase();

  for (const word of rules.bannedWords) {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}`).test(allCopy)) {
      problems.push(`- the banned word "${word}" appears in the copy`);
    }
  }
  if (rawCopy.includes("—")) {
    problems.push("- an em-dash (—) appears in the copy; the brand guide forbids it");
  }

  for (const section of plan.sections) {
    for (const phrase of section.phrases) {
      const words = phrase.text.trim().split(/\s+/).filter(Boolean).length;
      if (words > CAPTION_MAX_WORDS || phrase.text.length > CAPTION_MAX_CHARS) {
        problems.push(
          `- ${section.id}/${phrase.id} is ${words} words / ${phrase.text.length} chars `
          + `(max ${CAPTION_MAX_WORDS} / ${CAPTION_MAX_CHARS}): "${phrase.text}"`,
        );
      }
    }
    if (section.onScreen.trim() && section.onScreen.trim().split(/\s+/).length > 6) {
      problems.push(`- ${section.id} onScreen copy is longer than six words: "${section.onScreen}"`);
    }
  }

  const ids = plan.sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) problems.push("- section ids are not unique");
  return problems.length ? problems.join("\n") : null;
}

export function assertPlanCopyRules(plan: VideoPlan, rules: VoiceRules) {
  const violation = copyRulesViolation(plan, rules);
  if (violation) {
    throw new Error(
      "The edited copy violates the same rules used during planning. No narration or render was started:\n"
      + violation,
    );
  }
}
