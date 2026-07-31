import {
  narrationProfileForIntent,
  type Intent,
  type NarrationProfileId,
} from "../plan/schema.ts";

export interface IntentNarrationProfile {
  id: NarrationProfileId;
  intent: Intent;
  style: string;
  pace: (targetSeconds: number) => string;
  transition: string;
  scene: string;
  tags: readonly [string, string, string];
  promptTargetWps: number;
  rawTargetWps: number;
  rawPaceRange: readonly [number, number];
  sectionGapMs: number;
}

export const NARRATION_PROFILES: Record<NarrationProfileId, IntentNarrationProfile> = {
  "social-promotional": {
    id: "social-promotional",
    intent: "promotional",
    style: "Style: Short-form advertising with controlled energy. Persuasive and polished, never shouty.",
    pace: (seconds) => `Pace: Fast and continuous, with no dead air. Aim for around ${seconds} seconds without slurring words.`,
    transition: "Hook immediately, build desire through the middle, and finish punchy.",
    scene: "A premium commercial voice-over recorded in a sound-stage booth.",
    tags: ["intrigue", "desire", "confident"],
    promptTargetWps: 2.65,
    rawTargetWps: 2.45,
    rawPaceRange: [2.1, 3.0],
    // The B749 listener check preferred the uncut 667/835 ms transitions. Keep the
    // social-promotion flow natural; only genuinely long dead air should be shortened.
    sectionGapMs: 800,
  },
  educational: {
    id: "educational",
    intent: "educational",
    style: "Style: Clear educational narration. Patient and conversational, never childish or corporate.",
    pace: (seconds) => `Pace: Steady and easy to follow. Aim for around ${seconds} seconds without dragging.`,
    transition: "Give each chapter enough room to register, while keeping the explanation moving.",
    scene: "A knowledgeable guide explaining one idea clearly in a quiet studio.",
    tags: ["information", "explanation", "confident"],
    promptTargetWps: 2.15,
    rawTargetWps: 1.95,
    rawPaceRange: [1.65, 2.35],
    sectionGapMs: 650,
  },
  "thought-leadership": {
    id: "thought-leadership",
    intent: "thought-leadership",
    style: "Style: Thought leadership with calm authority. Reflective, clear, and never commercial.",
    pace: (seconds) => `Pace: Measured forward motion. Aim for around ${seconds} seconds; never rush a paragraph transition.`,
    transition: "Let the argument breathe, especially after the opening, while avoiding dead air.",
    scene: "A founder sharing a considered argument in a quiet studio.",
    tags: ["observant", "conviction", "confident"],
    promptTargetWps: 2.2,
    rawTargetWps: 2.05,
    rawPaceRange: [1.85, 2.25],
    sectionGapMs: 650,
  },
  announcement: {
    id: "announcement",
    intent: "announcement",
    style: "Style: A clear product announcement. Fresh, concrete, and confident, with a little positive excitement but no launch-day hype.",
    pace: (seconds) => `Pace: Brisk and direct. Aim for around ${seconds} seconds with clean articulation.`,
    transition: "Lead with what changed, build a subtle positive lift through the benefit, and close with upbeat confidence.",
    scene: "A founder recording a concise product update in a quiet studio.",
    tags: ["information", "positive", "confident"],
    promptTargetWps: 2.45,
    rawTargetWps: 2.25,
    rawPaceRange: [1.9, 2.75],
    // Natural sub-900 ms transitions passed the BC5C listening preparation without
    // needing a cut. Preserve them just as the social-promotion profile does.
    sectionGapMs: 800,
  },
  "performance-ad": {
    id: "performance-ad",
    intent: "promotional",
    style: "Style: Direct-response performance advertising with high, controlled energy. Immediate, urgent, and conversational, never shouty or like a radio announcer.",
    pace: (seconds) => `Pace: Fast and relentless but fully articulated. Aim for around ${seconds} seconds with no dead air and no rushed syllables.`,
    transition: "Hit the first line immediately, build pressure through the proof, and make the final action decisive. Create energy through emphasis and rhythm, not volume.",
    scene: "A close-mic paid-social performance ad made to stop a cold viewer in a busy feed.",
    tags: ["attention", "momentum", "decisive"],
    promptTargetWps: 3,
    rawTargetWps: 2.8,
    rawPaceRange: [2.45, 3.3],
    sectionGapMs: 450,
  },
};

export function intentNarrationProfile(intent: Intent, requested?: NarrationProfileId) {
  return NARRATION_PROFILES[narrationProfileForIntent(intent, requested)];
}
