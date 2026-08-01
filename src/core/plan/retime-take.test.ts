import assert from "node:assert/strict";
import {test} from "node:test";
import {retimeFromTake, SILENT_SECTION_MIN_MS, type PlacedPhrase} from "./retime.ts";
import type {VideoPlan} from "./schema.ts";

/** Two spoken sections and a wordless signature, which is the shape every video has. */
function plan(): VideoPlan {
  return {
    sections: [
      {
        id: "hook", energy: "edge", onScreen: [], startMs: 0, durationMs: 0,
        phrases: [
          {id: "a", text: "Your calendar asks a strange thing.", gapAfterMs: 140, startMs: 0, durationMs: 0},
          {id: "b", text: "Promise Monday what you understand by Thursday.", gapAfterMs: 340, startMs: 0, durationMs: 0},
        ],
      },
      {
        id: "unit", energy: "settled", onScreen: [], startMs: 0, durationMs: 0,
        phrases: [
          {id: "c", text: "Those are not the same unit.", gapAfterMs: 140, startMs: 0, durationMs: 0},
        ],
      },
      {id: "signature", energy: "settled", onScreen: [], startMs: 0, durationMs: 0, phrases: []},
    ],
  } as unknown as VideoPlan;
}

const PLACED: PlacedPhrase[] = [
  {sectionId: "hook", phraseId: "a", startMs: 200, durationMs: 2_080},
  {sectionId: "hook", phraseId: "b", startMs: 3_260, durationMs: 2_640},
  {sectionId: "unit", phraseId: "c", startMs: 6_980, durationMs: 1_180},
];

test("phrases keep the positions they were measured at", () => {
  const retimed = retimeFromTake(plan(), PLACED);
  const [first, second] = retimed.sections[0]!.phrases;
  assert.equal(first!.startMs, 200);
  assert.equal(first!.durationMs, 2_080);
  assert.equal(second!.startMs, 3_260);
});

test("positions are read, never accumulated", () => {
  // Accumulating duration + gap would put phrase b at 2_080 + 140 = 2_220, drifting
  // a full second from where it is actually spoken.
  const retimed = retimeFromTake(plan(), PLACED);
  assert.equal(retimed.sections[0]!.phrases[1]!.startMs, 3_260);
  assert.notEqual(retimed.sections[0]!.phrases[1]!.startMs, 2_220);
});

test("gaps are rewritten from the silence that is really there", () => {
  const retimed = retimeFromTake(plan(), PLACED);
  // 3_260 - (200 + 2_080) = 980ms of real breath, not the 140 the plan guessed.
  assert.equal(retimed.sections[0]!.phrases[0]!.gapAfterMs, 980);
  // The last phrase of a section has nothing after it inside that section.
  assert.equal(retimed.sections[0]!.phrases[1]!.gapAfterMs, 0);
});

test("a section owns the pause after its own last line", () => {
  const retimed = retimeFromTake(plan(), PLACED);
  const hook = retimed.sections[0]!;
  // Runs to where `unit` starts speaking, not to where its own last word ends.
  assert.equal(hook.durationMs, 6_980);
});

test("sections tile from zero, so no frame is left unclaimed", () => {
  const retimed = retimeFromTake(plan(), PLACED);
  // The take opens with 200ms of lead-in. Scene one still has to be on screen for it,
  // or the video starts blank.
  assert.equal(retimed.sections[0]!.startMs, 0);
  let expected = 0;
  for (const section of retimed.sections) {
    assert.equal(section.startMs, expected, `${section.id} must start where the last ended`);
    expected += section.durationMs;
  }
});

test("the final spoken section runs to the end of the audio", () => {
  const retimed = retimeFromTake(plan(), PLACED);
  const unit = retimed.sections[1]!;
  assert.equal(unit.startMs, 6_980);
  assert.equal(unit.durationMs, SILENT_SECTION_MIN_MS, "1_180ms of speech still needs reading time");
});

test("the mastered post-roll belongs to the last scene instead of being cut off", () => {
  const retimed = retimeFromTake(plan(), PLACED, 11_400);
  const last = retimed.sections.at(-1)!;
  assert.equal(last.startMs + last.durationMs, 11_400);
  assert.equal(retimed.sections[1]!.phrases[0]!.durationMs, 1_180, "speech is never stretched");
});

test("a wordless section still gets time on screen", () => {
  const retimed = retimeFromTake(plan(), PLACED);
  const signature = retimed.sections[2]!;
  assert.equal(signature.phrases.length, 0);
  assert.equal(signature.durationMs, SILENT_SECTION_MIN_MS);
});

test("a phrase missing from the alignment stops the retime rather than guessing", () => {
  assert.throws(
    () => retimeFromTake(plan(), PLACED.slice(0, 2)),
    /unit\/c was not located in the take/,
  );
});
