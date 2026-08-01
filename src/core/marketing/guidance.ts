import type {Settings} from "../settings.ts";
import type {Intent, NarrationProfileId} from "../plan/schema.ts";

export const MARKETING_GUIDANCE_IDS = ["ad-creative", "social", "marketing-psychology"] as const;
export type MarketingGuidanceId = (typeof MARKETING_GUIDANCE_IDS)[number];

export interface MarketingGuidance {
  ids: MarketingGuidanceId[];
  prompt: string;
}

/**
 * Small, guarded planning aids derived from the installed marketing skills. We do not
 * hand the whole plugin to every run: ad account optimisation and universal three-second
 * hooks are wrong for most videos this studio makes. The intent and narration profile are
 * the authority; these modules may sharpen them, never replace them.
 */
export function marketingGuidanceFor(
  settings: Settings,
  intent: Intent,
  narrationProfile: NarrationProfileId,
): MarketingGuidance {
  const modules: {id: MarketingGuidanceId; text: string}[] = [];

  if (settings.marketingSkills.adCreative && narrationProfile === "performance-ad") {
    modules.push({
      id: "ad-creative",
      text: [
        "Performance-ad guidance: establish the viewer's problem and the product's useful",
        "difference immediately; build one clear promise toward one CTA. Prefer specific proof",
        "from the approved facts over generic superlatives. This does not author campaign setup,",
        "budget, targeting or ROAS advice.",
      ].join(" "),
    });
  }

  if (settings.marketingSkills.social && narrationProfile !== "performance-ad") {
    modules.push({
      id: "social",
      text: [
        "Social guidance: earn attention with relevance and a crisp opening, then make each",
        "section easy to follow without captions. The selected intent remains binding: thought",
        "leadership must keep its calm authority, education must teach, announcements may lift,",
        "and social-promotional may be lively. Do not force clickbait, artificial urgency or a",
        "three-second-hook cadence onto a profile that calls for restraint.",
      ].join(" "),
    });
  }

  if (settings.marketingSkills.marketingPsychology) {
    modules.push({
      id: "marketing-psychology",
      text: [
        "Psychology guidance: reduce cognitive load, make the contrast and consequence easy to",
        "understand, and use concrete framing. Never invent social proof, scarcity, authority,",
        "numbers or outcomes. Approved product facts and brand voice override every persuasion",
        "pattern.",
      ].join(" "),
    });
  }

  return {
    ids: modules.map((module) => module.id),
    prompt: modules.length
      ? `# Optional marketing guidance\n\n${modules.map((module) => `- ${module.text}`).join("\n")}`
      : "",
  };
}
