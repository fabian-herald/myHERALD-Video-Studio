import {buildCaptions} from "../tts/captions.ts";
import type {VideoPlan} from "../plan/schema.ts";

/**
 * The bar the finished file is measured against: `freezedetect=n=0.001:d=2.5` in
 * `render/qc.ts`. Everything below is calibrated to sit just inside it, so the composer
 * is warned before the check fires rather than after.
 */
export const FREEZE_BAR_MS = 2500;

/**
 * No caption on screen at all. 300ms under the freeze bar deliberately: a window that
 * only just clears this threshold is one where a small overrun becomes a real freeze.
 */
export const STILL_GAP_MS = 2200;

/**
 * The same caption page held. Longer than the gap threshold because a page is itself an
 * arrival — it appeared, which changed the picture — so the genuinely static stretch
 * starts a beat after `fromMs`.
 */
export const STILL_PAGE_MS = 2300;

export interface StillWindow {
  sectionId: string;
  fromMs: number;
  toMs: number;
  /** `gap`: the caption layer is empty. `page`: one page is held unchanged. */
  kind: "gap" | "page";
  /** The held text, for a `page` window. Empty for a gap. */
  text: string;
}

export const windowMs = (window: StillWindow) => window.toMs - window.fromMs;

/**
 * Stretches where the caption layer paints the same pixels from one frame to the next.
 *
 * The caption layer is the only part of the picture the pipeline animates on its own:
 * pages appear and clear on measured phrase boundaries, and each change is a large,
 * guaranteed pixel difference. Everywhere else, whether anything moves is entirely the
 * composer's decision — and four freezes in one render landed in exactly these windows.
 *
 * So this is the honest statement of where the composition is carrying the frame alone.
 * It is derived rather than described, for the same reason `motionBrief` derives its
 * table from `ENERGY_MOTION`: a hand-written account of "the quiet parts" drifts from
 * the audio the moment anyone edits a phrase.
 *
 * Windows never cross a section boundary — a scene change is itself a change of picture.
 */
export function stillWindows(plan: VideoPlan): StillWindow[] {
  const pages = buildCaptions(plan).pages;
  const windows: StillWindow[] = [];

  for (const section of plan.sections) {
    const start = section.startMs;
    const end = section.startMs + section.durationMs;
    if (end <= start) continue;

    const own = pages
      .filter((page) => page.toMs > start && page.fromMs < end)
      .map((page) => ({
        text: page.text,
        fromMs: Math.max(page.fromMs, start),
        toMs: Math.min(page.toMs, end),
      }))
      .sort((a, b) => a.fromMs - b.fromMs);

    let cursor = start;
    for (const page of own) {
      if (page.fromMs - cursor >= STILL_GAP_MS) {
        windows.push({sectionId: section.id, fromMs: cursor, toMs: page.fromMs, kind: "gap", text: ""});
      }
      if (page.toMs - page.fromMs >= STILL_PAGE_MS) {
        windows.push({sectionId: section.id, fromMs: page.fromMs, toMs: page.toMs, kind: "page", text: page.text});
      }
      cursor = Math.max(cursor, page.toMs);
    }
    if (end - cursor >= STILL_GAP_MS) {
      windows.push({sectionId: section.id, fromMs: cursor, toMs: end, kind: "gap", text: ""});
    }
  }

  return windows;
}

/**
 * The worst still window in each section, or nothing if that section has none.
 *
 * Measured against real plans, the complete list runs to 15–34 windows a video and 34–94
 * seconds of still time — because a spoken caption page is typically 2–4 seconds long and
 * clears the threshold on its own. Handing the composer all of them says "the whole video"
 * in thirty lines, and sampling all of them costs sixty-odd headless frames per attempt.
 *
 * One per section is the useful unit for the generated brief. The rule is per-scene: long
 * stretches need a meaningful visual beat, not a continuously moving object.
 */
export function worstStillWindows(plan: VideoPlan): StillWindow[] {
  const worst = new Map<string, StillWindow>();
  for (const window of stillWindows(plan)) {
    const held = worst.get(window.sectionId);
    if (!held || windowMs(window) > windowMs(held)) worst.set(window.sectionId, window);
  }
  return plan.sections
    .map((section) => worst.get(section.id))
    .filter((window): window is StillWindow => Boolean(window));
}

/**
 * How far apart the two sampled frames sit. A meaningful state change may happen between
 * them; an object does not have to keep moving for the whole interval.
 *
 * Both halves of that were settled by measurement, not taste. Sampling the *ends* of a
 * window catches the outgoing and incoming caption pages, so a frozen scene reads as a
 * moving one; widening the pair to a full second either side of the midpoint did the same
 * thing more subtly and collapsed the separation entirely (two compositions with real
 * freezes fell to 27dB, indistinguishable from clean ones). A short span about the middle
 * sees only what the composition itself is doing.
 */
export const SAMPLE_SPACING_MS = 1600;

/** Below this a window cannot hold the pair clear of its own edges. */
export const MIN_SAMPLED_WINDOW_MS = SAMPLE_SPACING_MS + 400;

/** The two instants a window is sampled at, in seconds. */
export function sampleTimes(window: StillWindow): [number, number] {
  const middle = (window.fromMs + window.toMs) / 2;
  const at = (ms: number) => Number((ms / 1000).toFixed(2));
  return [at(middle - SAMPLE_SPACING_MS / 2), at(middle + SAMPLE_SPACING_MS / 2)];
}

/** `62.10–64.18s (2.08s)`, the form used in both the brief and the check's findings. */
export function describeWindow(window: StillWindow): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(2);
  return `${seconds(window.fromMs)}–${seconds(window.toMs)}s (${seconds(windowMs(window))}s`
    + `${window.kind === "page" ? `, "${window.text}" held` : ", no caption at all"})`;
}

/**
 * The section's worst still stretch, as a line of the brief.
 *
 * Absolute times, matching every other timing in BRIEF.md, so it can be read straight
 * against `data-start`. The measured bar is named rather than described: the composer has
 * been told "keep it alive" in prose for months and produced hairline drifts that changed
 * too few pixels to register, so the number it is actually judged against goes in.
 */
export function stillBriefLine(window: StillWindow): string {
  return `- **caption layer holds still ${describeWindow(window)}** — the scene does not need `
    + "continuous motion, and readable elements may hold. But this whole span may not remain "
    + "one unchanged picture. Schedule a meaningful visual beat within it: reveal, count, "
    + "compare, connect, progress or transition, then hold the resolved state. It is measured "
    + "on the finished file "
    + `with \`freezedetect=n=0.001:d=${FREEZE_BAR_MS / 1000}\`, which averages the change across `
    + "the *whole* frame, so the visual beat must affect meaningful area rather than only a "
    + "hairline or a tiny decorative mark.";
}
