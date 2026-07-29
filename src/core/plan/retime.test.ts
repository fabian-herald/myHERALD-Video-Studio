import assert from "node:assert/strict";
import {test} from "node:test";
import {retimePlan, seedGaps, SILENT_SECTION_MIN_MS} from "./retime.ts";
import {planDurationMs, videoPlanZ, type VideoPlan} from "./schema.ts";

function plan(sections: {id: string; phrases: string[]}[]): VideoPlan {
  return videoPlanZ.parse({
    schemaVersion: 1,
    id: "test-video",
    createdAt: "2026-07-28T00:00:00.000Z",
    brief: "brief",
    intent: "thought-leadership",
    formats: ["9x16"],
    language: "en",
    title: "Test",
    thesis: "A thesis.",
    sections: sections.map((section) => ({
      id: section.id,
      kind: "point",
      onScreen: "Copy",
      phrases: section.phrases.map((text, index) => ({id: `p${index}`, text, gapAfterMs: 100})),
    })),
    narration: {provider: "gemini", voice: "Achird", style: ""},
  });
}

test("timings are rebuilt from measured audio, not from the plan's guesses", () => {
  const source = plan([
    {id: "one", phrases: ["first", "second"]},
    {id: "two", phrases: ["third"]},
  ]);

  const retimed = retimePlan(source, [
    {sectionId: "one", phraseId: "p0", durationMs: 1000},
    {sectionId: "one", phraseId: "p1", durationMs: 2000},
    {sectionId: "two", phraseId: "p0", durationMs: 1500},
  ]);

  const [one, two] = retimed.sections;
  assert.equal(one?.startMs, 0);
  assert.equal(one?.phrases[0]?.durationMs, 1000);
  assert.equal(one?.phrases[1]?.startMs, 1100, "the second phrase starts after the first gap");
  assert.equal(one?.durationMs, 3200, "1000 + 100 + 2000 + 100");
  assert.equal(two?.startMs, 3200, "sections butt up against each other with no drift");
  assert.equal(planDurationMs(retimed), 4800);
});

test("a wordless section still occupies real time", () => {
  const source = plan([{id: "one", phrases: ["only"]}, {id: "silent", phrases: []}]);
  const retimed = retimePlan(source, [{sectionId: "one", phraseId: "p0", durationMs: 900}]);

  assert.equal(retimed.sections[1]?.durationMs, SILENT_SECTION_MIN_MS);
  assert.equal(planDurationMs(retimed), 1000 + SILENT_SECTION_MIN_MS);
});

test("a missing measurement fails loudly instead of guessing", () => {
  const source = plan([{id: "one", phrases: ["a", "b"]}, {id: "two", phrases: ["c"]}]);
  assert.throws(
    () => retimePlan(source, [{sectionId: "one", phraseId: "p0", durationMs: 500}]),
    /No measured narration for one\/p1/,
  );
});

test("seeded gaps are longer at a section boundary than between phrases", () => {
  const source = plan([{id: "one", phrases: ["a", "b"]}, {id: "two", phrases: ["c"]}]);
  const bare = {
    ...source,
    sections: source.sections.map((section) => ({
      ...section,
      phrases: section.phrases.map((phrase) => ({...phrase, gapAfterMs: 0})),
    })),
  };
  const seeded = seedGaps(bare);
  assert.equal(seeded.sections[0]?.phrases[0]?.gapAfterMs, 140);
  assert.equal(seeded.sections[0]?.phrases[1]?.gapAfterMs, 340);
});
