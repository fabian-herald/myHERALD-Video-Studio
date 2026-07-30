import assert from "node:assert/strict";
import {test} from "node:test";
import {videoPlanZ, type VideoPlan} from "../plan/schema.ts";
import type {StillWindow} from "./still.ts";
import {
  FREEZE_BAR_MS,
  MIN_SAMPLED_WINDOW_MS,
  SAMPLE_SPACING_MS,
  STILL_GAP_MS,
  STILL_PAGE_MS,
  describeWindow,
  sampleTimes,
  stillBriefLine,
  stillWindows,
  windowMs,
  worstStillWindows,
} from "./still.ts";

interface Phrase {
  text: string;
  startMs: number;
  durationMs: number;
}

/** A plan of sections laid end to end, each carrying the phrases given. */
function planOf(sections: {id: string; startMs: number; durationMs: number; phrases: Phrase[]}[]): VideoPlan {
  return videoPlanZ.parse({
    schemaVersion: 1,
    id: "v",
    createdAt: "2026-07-30T00:00:00.000Z",
    brief: "b",
    title: "t",
    thesis: "th",
    intent: "thought-leadership",
    formats: ["9x16"],
    language: "en",
    narration: {provider: "gemini", voice: "Achird"},
    sections: sections.map((section, index) => ({
      id: section.id,
      kind: index === 0 ? "hook" : "outro",
      startMs: section.startMs,
      durationMs: section.durationMs,
      phrases: section.phrases.map((phrase, phraseIndex) => ({
        id: `${section.id}-${phraseIndex}`,
        ...phrase,
      })),
    })),
  });
}

/** One section, filled edge to edge by a single phrase of `speechMs`, then silence. */
const oneSection = (speechMs: number, durationMs: number, text = "A line of narration.") =>
  planOf([
    {id: "a", startMs: 0, durationMs, phrases: [{text, startMs: 0, durationMs: speechMs}]},
    {id: "b", startMs: durationMs, durationMs: 1000, phrases: []},
  ]);

test("the thresholds sit under the bar the finished file is measured against", () => {
  // The whole point of computing these before the render is to warn earlier than the
  // post-render check. A threshold at or above the freeze bar would only ever report a
  // window that had already failed QC, which is the situation this replaces.
  assert.ok(STILL_GAP_MS < FREEZE_BAR_MS, "the gap threshold does not warn before the freeze check");
  assert.equal(FREEZE_BAR_MS, 1500, "the freeze bar drifted from qc.ts's freezedetect d=1.5");
});

test("a short gap between phrases is not a still window", () => {
  const plan = planOf([
    {
      id: "a",
      startMs: 0,
      durationMs: 4000,
      phrases: [
        {text: "One.", startMs: 0, durationMs: 1500},
        // 500ms of breath. Nothing changes, but not for long enough to matter.
        {text: "Two.", startMs: 2000, durationMs: 1500},
      ],
    },
    {id: "b", startMs: 3500, durationMs: 1000, phrases: []},
  ]);
  assert.deepEqual(stillWindows(plan), []);
});

test("a long gap between phrases is a still window", () => {
  const plan = planOf([
    {
      id: "a",
      startMs: 0,
      durationMs: 6000,
      phrases: [
        {text: "One.", startMs: 0, durationMs: 1000},
        {text: "Two.", startMs: 3000, durationMs: 3000},
      ],
    },
    {id: "b", startMs: 6000, durationMs: 1000, phrases: []},
  ]);
  const gaps = stillWindows(plan).filter((window) => window.kind === "gap");
  assert.equal(gaps.length, 1);
  assert.deepEqual(
    {from: gaps[0]?.fromMs, to: gaps[0]?.toMs, section: gaps[0]?.sectionId},
    {from: 1000, to: 3000, section: "a"},
  );
});

test("silence after the last word of a section is a still window", () => {
  // The commonest shape by far, and where two of the four observed freezes landed: the
  // voice stops and the scene holds while the next one is still to come.
  const windows = stillWindows(oneSection(2000, 5000))
    .filter((window) => window.sectionId === "a" && window.kind === "gap");
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.fromMs, 2000);
  assert.equal(windows[0]?.toMs, 5000);
});

test("a caption page held long enough is itself a still window", () => {
  // Text on screen is not motion. The page arrives, and then the same pixels sit there
  // for as long as the phrase takes to say.
  const windows = stillWindows(oneSection(STILL_PAGE_MS + 400, STILL_PAGE_MS + 400, "A long held line."));
  const pages = windows.filter((window) => window.kind === "page");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.text, "A long held line.");
});

test("a page just under the threshold is left alone", () => {
  const windows = stillWindows(oneSection(STILL_PAGE_MS - 1, STILL_PAGE_MS - 1));
  assert.deepEqual(windows.filter((window) => window.kind === "page"), []);
});

test("a wordless section is one window from end to end", () => {
  // A signature card with no narration under it. Nothing in the caption layer will ever
  // change here, so the composition is carrying the entire scene by itself.
  const plan = planOf([
    {id: "a", startMs: 0, durationMs: 3000, phrases: [{text: "Said.", startMs: 0, durationMs: 3000}]},
    {id: "card", startMs: 3000, durationMs: 4000, phrases: []},
  ]);
  const windows = stillWindows(plan).filter((window) => window.sectionId === "card");
  assert.equal(windows.length, 1);
  assert.deepEqual([windows[0]?.fromMs, windows[0]?.toMs], [3000, 7000]);
});

test("a window never crosses a section boundary", () => {
  // A scene change is the largest pixel change in the video. Merging silence either side
  // of one would report a window that cannot possibly freeze.
  const plan = planOf([
    {id: "a", startMs: 0, durationMs: 2000, phrases: [{text: "Said.", startMs: 0, durationMs: 800}]},
    {id: "b", startMs: 2000, durationMs: 2000, phrases: [{text: "Also.", startMs: 3200, durationMs: 800}]},
  ]);
  for (const window of stillWindows(plan)) {
    const section = plan.sections.find((candidate) => candidate.id === window.sectionId);
    assert.ok(section);
    assert.ok(window.fromMs >= section.startMs && window.toMs <= section.startMs + section.durationMs,
      `${window.sectionId} window ${window.fromMs}–${window.toMs} escapes its section`);
  }
});

test("every window is long enough to be worth sampling", () => {
  const plan = planOf([
    {
      id: "a",
      startMs: 0,
      durationMs: 12_000,
      phrases: [
        {text: "One.", startMs: 0, durationMs: 400},
        {text: "Two, at some length.", startMs: 2600, durationMs: 2400},
        {text: "Three.", startMs: 5200, durationMs: 500},
      ],
    },
    {id: "b", startMs: 12_000, durationMs: 1000, phrases: []},
  ]);
  for (const window of stillWindows(plan)) {
    assert.ok(windowMs(window) >= STILL_GAP_MS, `${describeWindow(window)} is shorter than the threshold`);
    const [from, to] = sampleTimes(window);
    assert.ok(to > from, `${describeWindow(window)} samples the same instant twice`);
  }
});

test("the sampled pair straddles the middle of the window, not its ends", () => {
  // Measured, not chosen. Sampling the ends catches the caption page arriving or leaving,
  // so a frozen scene reads as a moving one; a pair a full second either side of the
  // midpoint did the same thing quietly and collapsed the separation altogether — two
  // compositions with real freezes fell to 27dB, level with clean ones.
  const [from, to] = sampleTimes({sectionId: "a", fromMs: 4000, toMs: 7000, kind: "gap", text: ""});
  assert.equal((from + to) / 2, 5.5, "the pair is not centred on the window");
  assert.equal(Number((to - from).toFixed(3)), SAMPLE_SPACING_MS / 1000);
});

test("a window too short to sample is one the check must skip, not squeeze", () => {
  // Squeezing the pair into a shorter window would push it onto the edges, which is the
  // failure above. The threshold and the spacing have to move together.
  assert.ok(MIN_SAMPLED_WINDOW_MS > SAMPLE_SPACING_MS,
    "a window exactly as long as the spacing leaves the samples sitting on its boundaries");
  const shortest: StillWindow = {sectionId: "a", fromMs: 0, toMs: MIN_SAMPLED_WINDOW_MS, kind: "gap", text: ""};
  const [from, to] = sampleTimes(shortest);
  assert.ok(from * 1000 >= 150 && to * 1000 <= MIN_SAMPLED_WINDOW_MS - 150,
    "the shortest sampled window puts its frames within 150ms of a caption change");
});

test("only the worst window of each section survives, at most one per section", () => {
  // Real plans produce 15–34 windows apiece, because a spoken caption page is typically
  // 2–4 seconds and clears the threshold on its own. All of them in the brief says "the
  // whole video" in thirty lines; all of them in the check costs sixty headless frames an
  // attempt. One per section is the unit the rule is written in.
  const plan = planOf([
    {
      id: "a",
      startMs: 0,
      durationMs: 12_000,
      phrases: [
        {text: "Short.", startMs: 0, durationMs: 1700},
        {text: "The longest held line in this scene.", startMs: 2000, durationMs: 4000},
        {text: "Middling.", startMs: 8000, durationMs: 2000},
      ],
    },
    {id: "b", startMs: 12_000, durationMs: 3000, phrases: []},
  ]);
  const worst = worstStillWindows(plan);
  assert.equal(worst.length, 2, "one window per section, no more and no fewer");
  assert.equal(worst[0]?.sectionId, "a");
  assert.equal(windowMs(worst[0] as (typeof worst)[number]), 4000);
  assert.equal(worst[1]?.sectionId, "b");
});

test("a section with nothing still contributes nothing", () => {
  const plan = planOf([
    {
      id: "a",
      startMs: 0,
      durationMs: 3000,
      phrases: [
        {text: "One.", startMs: 0, durationMs: 1500},
        {text: "Two.", startMs: 1500, durationMs: 1500},
      ],
    },
    {id: "b", startMs: 3000, durationMs: 4000, phrases: []},
  ]);
  assert.deepEqual(worstStillWindows(plan).map((window) => window.sectionId), ["b"]);
});

test("worst windows come back in the plan's own section order", () => {
  // They are printed against the sections in BRIEF.md, which are in plan order. Coming
  // back sorted by length would attach each line to the wrong scene.
  const plan = planOf([
    {id: "a", startMs: 0, durationMs: 3000, phrases: []},
    {id: "b", startMs: 3000, durationMs: 9000, phrases: []},
    {id: "c", startMs: 12_000, durationMs: 5000, phrases: []},
  ]);
  assert.deepEqual(worstStillWindows(plan).map((window) => window.sectionId), ["a", "b", "c"]);
});

test("the brief line names the filter the finished file is judged by", () => {
  // "Keep it alive" has been in the contract for months and produced hairline drifts that
  // changed too few pixels to register. The composer optimises against what it is told the
  // measure is, so the measure goes in.
  const line = stillBriefLine({sectionId: "a", fromMs: 0, toMs: 3800, kind: "page", text: "Held."});
  assert.match(line, /freezedetect=n=0\.001:d=1\.5/);
  assert.match(line, /whole/i, "the line does not say the measure is whole-frame");
  assert.match(line, /area/i, "the line does not say what registers");
});

test("a window is described with both ends and its length", () => {
  const described = describeWindow({sectionId: "a", fromMs: 62_100, toMs: 64_180, kind: "gap", text: ""});
  assert.match(described, /62\.10.*64\.18s/);
  assert.match(described, /2\.08s/);
  assert.match(described, /no caption/);
});
