import type {OutputFormat} from "../plan/formats.ts";
import type {Intent} from "../plan/schema.ts";

export interface IntentPreset {
  id: Intent;
  label: string;
  formats: OutputFormat[];
  defaultFormats: OutputFormat[];
  durationBandSeconds: [number, number];
  sectionRange: [number, number];
  requiresCta: boolean;
  allowsAvatar: boolean;
  mediaPolicy: "optional" | "required" | "rare";
  /** Appended to the planning prompt. This is where "not an ad" actually lives. */
  guidance: string;
}

export const INTENT_PRESETS: Record<Intent, IntentPreset> = {
  promotional: {
    id: "promotional",
    label: "Promotional / Ad",
    formats: ["9x16", "4x5", "1x1"],
    defaultFormats: ["9x16", "4x5", "1x1"],
    durationBandSeconds: [15, 30],
    sectionRange: [5, 7],
    requiresCta: true,
    allowsAvatar: true,
    mediaPolicy: "optional",
    guidance: [
      "This is paid media. A cold viewer decides in three seconds whether to keep watching.",
      "Open on tension the viewer already feels — never on the product name or a logo.",
      "State one concrete outcome, and give a reason to believe it before the halfway point.",
      "Close on a specific, benefit-led call to action. Not 'learn more'.",
      "Captions are burned in and carry the whole message; assume the sound is off at first.",
    ].join(" "),
  },

  educational: {
    id: "educational",
    label: "Educational / Explainer",
    formats: ["16x9", "9x16"],
    defaultFormats: ["16x9"],
    durationBandSeconds: [60, 240],
    sectionRange: [6, 14],
    requiresCta: false,
    allowsAvatar: true,
    mediaPolicy: "required",
    guidance: [
      "This teaches. The viewer chose to watch, so earn the time rather than grabbing it.",
      "Structure it in named chapters that build on each other.",
      "Show the real product where it proves a point — screenshots are evidence, not decoration.",
      "Prefer one clear idea per chapter over density.",
      "End by restating what the viewer can now do, not by pitching.",
    ].join(" "),
  },

  "thought-leadership": {
    id: "thought-leadership",
    label: "Thought leadership",
    formats: ["9x16", "4x5", "16x9"],
    defaultFormats: ["9x16", "4x5"],
    durationBandSeconds: [30, 90],
    sectionRange: [4, 8],
    requiresCta: false,
    allowsAvatar: true,
    mediaPolicy: "rare",
    guidance: [
      "This is a point of view, not a pitch. The product may be the author but is never the subject.",
      "Take an actual position — one a reasonable person could disagree with.",
      "Name the thing the industry gets wrong, then say what you do instead and why.",
      "No call to action at all. The last frame is the brand signature and nothing more.",
      "Do not mention features. If it reads as an ad, it has failed.",
      "End on the door, not the wall. The closing line is the one a viewer repeats to a"
      + " colleague, so it points at what to do differently rather than restating what is"
      + " broken. Diagnosis belongs in the middle of the piece, never at its end.",
      "Calm is the register, not the dynamic. Held at one level for forty seconds a piece"
      + " reads as flat rather than composed, so give it a curve: pull back before the line"
      + " that has to land, lean in on the turn, and let the close carry conviction.",
    ].join(" "),
  },

  announcement: {
    id: "announcement",
    label: "Product update",
    formats: ["9x16", "1x1", "16x9"],
    defaultFormats: ["9x16", "1x1"],
    durationBandSeconds: [20, 60],
    sectionRange: [4, 7],
    requiresCta: false,
    allowsAvatar: false,
    mediaPolicy: "required",
    guidance: [
      "Something shipped. Be concrete and specific about what changed and who it helps.",
      "Lead with the change itself, not with a build-up.",
      "Show the actual thing. An announcement without evidence reads as noise.",
      "Close on a soft invitation to try it, not a hard sell.",
    ].join(" "),
  },
};

export const intentPreset = (intent: Intent) => INTENT_PRESETS[intent];
