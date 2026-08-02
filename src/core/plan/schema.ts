import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {OUTPUT_FORMATS} from "./formats.ts";
import {CONTENT_LANGUAGES} from "./language.ts";

export const INTENTS = ["promotional", "educational", "thought-leadership", "announcement"] as const;
export type Intent = (typeof INTENTS)[number];

export const NARRATION_PROFILE_IDS = [
  "social-promotional", "performance-ad", "educational", "thought-leadership", "announcement",
] as const;
export type NarrationProfileId = (typeof NARRATION_PROFILE_IDS)[number];

/** Resolve before synthesis so an unsupported intent/profile pair never reaches a provider. */
export function narrationProfileForIntent(intent: Intent, requested?: NarrationProfileId): NarrationProfileId {
  const allowed: readonly NarrationProfileId[] = intent === "promotional"
    ? ["performance-ad", "social-promotional"]
    : [intent];
  const resolved = requested ?? allowed[0]!;
  if (!allowed.includes(resolved)) {
    throw new Error(
      `Narration profile "${resolved}" is not supported for ${intent}. Choose: ${allowed.join(", ")}.`,
    );
  }
  return resolved;
}

export const SECTION_KINDS = [
  "hook", "point", "proof", "turn", "payoff", "cta",
  "title", "chapter", "screen", "quote", "outro",
] as const;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "ids are kebab-case");

/**
 * One caption page and one TTS request. Phrase granularity is what buys exact
 * caption timings without any ASR — each clip is measured after synthesis.
 */
export const phraseZ = z.object({
  id: slug,
  text: z.string().min(1),
  /** Measured from the synthesised clip. 0 until narration has run. */
  startMs: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(0),
  /** Silence appended after this phrase, for breathing room. */
  gapAfterMs: z.number().min(0).max(4000).default(120),
});

export const presenterSlotZ = z.object({
  kind: z.literal("presenter"),
  /** Decided from the chosen avatar's capabilities, never by the model. */
  style: z.enum(["cutout", "inset", "full"]).default("inset"),
  boundMediaId: z.string().optional(),
});

/**
 * How hard a section pushes. The video's dynamic range, made explicit.
 *
 * A single delivery setting for a whole video is what makes it monotone, however good
 * that setting is: a calm voice held at exactly one level for forty seconds stops
 * reading as calm and starts reading as flat. These four give the piece a curve — a
 * settled baseline, a pull-back that lets a line land, a lift that carries conviction
 * without ever becoming a sell. They drive the narration and the motion together.
 */
export const ENERGIES = ["quiet", "settled", "lift", "edge"] as const;
export type Energy = (typeof ENERGIES)[number];

/**
 * A rectangle in the source image's own pixels, and when to be looking at it.
 *
 * Fractions of the image rather than stage coordinates, because the same composition is
 * re-emitted at four sizes and a pixel offset that framed a button in 9:16 frames
 * whitespace in 16:9. `atMs` is relative to the section, not the video, so editing an
 * earlier section's length does not silently push every zoom out of sync.
 */
export const focusRectZ = z.object({
  atMs: z.number().min(0),
  /** x, y, width, height as fractions of the image, 0–1. */
  rect: z.tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
  ]),
  /** Optional caption for the detail being pointed at. Rendered if present. */
  label: z.string().default(""),
});

/**
 * A real screenshot on a stage, with the moments the picture should move in on.
 *
 * This is the core of long-form explainer: talking about a button while the button is
 * a 12-pixel smudge in a full-page screenshot teaches nothing. `focus` drives a GSAP
 * transform onto each rect so the frame arrives at the detail as the narration reaches it.
 */
export const screenZ = z.object({
  mediaId: z.string(),
  /**
   * `contain` sits the image on the stage untouched. `device-frame` and `browser-chrome`
   * wrap it, which reads as a product rather than an attachment — and both are drawn in
   * CSS from brand tokens, never as a supplied image asset.
   */
  fit: z.enum(["contain", "device-frame", "browser-chrome"]).default("contain"),
  focus: z.array(focusRectZ).default([]),
});

/**
 * Numbers a section puts on screen, each tied to the fact that sources it.
 *
 * Deliberately data and not a `diagram` section kind. A kind would hand the composer a
 * scene template to fill, which is the failure this whole architecture exists to escape —
 * the previous studio chose from twelve hardcoded layouts by regex and produced one
 * layout six times. Given values and a shape hint, the composer decides whether this is
 * bars, a line, a counter or a single enormous figure, and lays it out to suit the scene.
 *
 * `factId` is what makes it publishable: every value traces to an approved fact carrying
 * an evidence note, and `assertPlanClaimsAreSourced` refuses the plan otherwise. A chart
 * is the easiest place in a video to state a number nobody can stand behind.
 */
export const dataSeriesZ = z.object({
  /** A hint, not an instruction. The composer may choose a better form. */
  shape: z.enum(["bars", "line", "counter", "share"]).default("bars"),
  unit: z.string().default(""),
  caption: z.string().default(""),
  points: z.array(z.object({
    label: z.string().min(1),
    value: z.number(),
    /** The approved fact this number came from. Required — no fact, no figure. */
    factId: z.string().min(1),
  })).min(1),
});

export const sectionZ = z.object({
  id: slug,
  kind: z.enum(SECTION_KINDS),
  /** What this section has to accomplish — guidance for the composer, never rendered. */
  intentNote: z.string().default(""),
  /** Where this section sits on the video's energy curve. */
  energy: z.enum(ENERGIES).default("settled"),
  /** Display copy. Short. The composer must render this verbatim. */
  onScreen: z.string().default(""),
  phrases: z.array(phraseZ).default([]),
  startMs: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(0),
  mediaId: z.string().optional(),
  /** A screenshot to hold and move through. Supersedes `mediaId` when both are set. */
  screen: screenZ.optional(),
  /** Figures to put on screen, each sourced. See `dataSeriesZ`. */
  data: dataSeriesZ.optional(),
  slot: presenterSlotZ.optional(),
});

export type FocusRect = z.infer<typeof focusRectZ>;
export type ScreenSpec = z.infer<typeof screenZ>;
export type DataSeries = z.infer<typeof dataSeriesZ>;

/**
 * The geometry a bar chart must use for each sourced value.
 * Percentages use their literal 0–100 scale; other units are normalised to the largest
 * magnitude in that series so the visual relationship remains truthful.
 */
export function dataBarGeometry(data: DataSeries) {
  const max = data.unit.trim() === "%"
    ? 100
    : Math.max(1, ...data.points.map((point) => Math.abs(point.value)));
  return data.points.map((point) => ({
    label: point.label,
    value: point.value,
    max,
    fill: Math.min(1, Math.max(0, Math.abs(point.value) / max)),
  }));
}

export const videoPlanZ = z.object({
  schemaVersion: z.literal(1),
  id: slug,
  createdAt: z.string(),
  brief: z.string(),
  intent: z.enum(INTENTS),
  formats: z.array(z.enum(OUTPUT_FORMATS)).min(1),
  language: z.enum(CONTENT_LANGUAGES).default("en"),
  title: z.string(),
  /** The single claim this video makes. Also the ledger's duplicate-detection key. */
  thesis: z.string(),
  sections: z.array(sectionZ).min(2),
  cta: z.object({label: z.string(), url: z.string()}).optional(),
  /** Runner-up angles, kept so "try another angle" costs one message. */
  alternates: z.array(z.object({
    thesis: z.string(),
    angle: z.string(),
    why: z.string(),
  })).default([]),
  narration: z.object({
    provider: z.string().default("gemini"),
    voice: z.string().default("Achird"),
    /** Promotional has two distinct deliveries; other intents resolve to their own id. */
    profile: z.enum(NARRATION_PROFILE_IDS).optional(),
    style: z.string().default(""),
    /** The brand's narrator register, held constant while `style` varies by section. */
    register: z.string().default(""),
    /**
     * Where the timestamps in this plan came from. Written by whichever retime ran,
     * never by the planner.
     *
     * The plan is the only thing the three callers of `buildCaptions` have in common,
     * so the provenance of its own numbers has to travel with it. Without that, the
     * caption record describes whichever narration path was written first rather than
     * the one that actually ran — and it claimed measured clips through a whole video
     * that was force-aligned.
     */
    timing: z.enum(["planned", "measured-clips", "aligned-take"]).default("planned"),
  }),
});

export type VideoPlan = z.infer<typeof videoPlanZ>;
export type PlanSection = z.infer<typeof sectionZ>;
export type PlanPhrase = z.infer<typeof phraseZ>;
export type TimingSource = VideoPlan["narration"]["timing"];

/** How the phrase boundaries in a plan were arrived at, in words, for the record. */
export const TIMING_PROVENANCE: Record<TimingSource, string> = {
  planned: "estimated by the planner; no audio has been synthesised yet",
  "measured-clips": "phrase-exact page boundaries from measured TTS clips",
  "aligned-take": "phrase boundaries located in one continuous take by ASR word timings",
};

export const planDurationMs = (plan: VideoPlan) =>
  plan.sections.reduce((total, section) => Math.max(total, section.startMs + section.durationMs), 0);

export const allPhrases = (plan: VideoPlan) =>
  plan.sections.flatMap((section) => section.phrases.map((phrase) => ({section, phrase})));

export const hasPresenterSlot = (plan: VideoPlan) =>
  plan.sections.some((section) => section.slot?.kind === "presenter");

export async function loadPlan(planPath: string): Promise<VideoPlan> {
  return videoPlanZ.parse(JSON.parse(await fs.readFile(planPath, "utf8")));
}

export async function savePlan(plan: VideoPlan, planPath: string) {
  await fs.mkdir(path.dirname(planPath), {recursive: true});
  await fs.writeFile(planPath, `${JSON.stringify(videoPlanZ.parse(plan), null, 2)}\n`, "utf8");
}

/** The JSON Schema handed to the planner so it can only emit a valid plan. */
export function planJsonSchema() {
  return z.toJSONSchema(videoPlanZ, {io: "input"});
}
