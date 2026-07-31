import assert from "node:assert/strict";
import {test} from "node:test";
import {alignPhrases, normalise, verifyAlignment, type TimedWord} from "./align.ts";

/** Builds word timings at a steady rate, which is enough to test the walk itself. */
function speak(text: string, from = 0, secondsPerWord = 0.4): TimedWord[] {
  return text.split(/\s+/).map((word, index) => ({
    word,
    start: Number((from + index * secondsPerWord).toFixed(3)),
    end: Number((from + (index + 1) * secondsPerWord - 0.05).toFixed(3)),
  }));
}

const TARGETS = [
  {sectionId: "hook", phraseId: "strange-ask", text: "Your calendar asks a strange thing."},
  {sectionId: "hook", phraseId: "promise", text: "Promise Monday what you understand by Thursday."},
  {sectionId: "unit", phraseId: "slot-is", text: "A slot is a date with a deadline."},
];
const SCRIPT = TARGETS.map((t) => t.text).join(" ");

test("a clean take aligns every phrase and passes", () => {
  const aligned = alignPhrases(speak(SCRIPT), TARGETS);
  assert.equal(aligned.length, 3);
  for (const phrase of aligned) assert.equal(phrase.confidence, 1);
  assert.equal(aligned[0]!.startMs, 0);
  // Six words at 0.4s, last one ending 0.05 early.
  assert.equal(aligned[0]!.durationMs, 2_350);
  assert.ok(verifyAlignment(aligned, 20_000).ok);
});

test("phrases come out in order and do not overlap", () => {
  const aligned = alignPhrases(speak(SCRIPT), TARGETS);
  for (let i = 1; i < aligned.length; i++) {
    const previousEnd = aligned[i - 1]!.startMs + aligned[i - 1]!.durationMs;
    assert.ok(aligned[i]!.startMs >= previousEnd, `phrase ${i} starts before ${i - 1} ends`);
  }
});

test("a dropped word costs confidence but not the boundary", () => {
  // The transcriber misses "a"; the phrase still starts and ends in the right place.
  const words = speak(SCRIPT).filter((w) => w.word !== "a" || w.start > 5);
  const aligned = alignPhrases(words, TARGETS);
  assert.ok(aligned[0]!.confidence < 1, "a missed word should be visible in confidence");
  assert.ok(aligned[0]!.confidence > 0.7, "one word in six is not a failed alignment");
  assert.ok(verifyAlignment(aligned, 20_000).ok, "still safe to build on");
});

test("punctuation and case are not differences", () => {
  assert.equal(normalise("Thursday,"), "thursday");
  assert.equal(normalise("four."), "four");
  assert.equal(normalise("—"), "");
  const spoken = speak(SCRIPT.replace(/\./g, "").toUpperCase());
  assert.equal(alignPhrases(spoken, TARGETS)[0]!.confidence, 1);
});

test("a phrase that was never spoken is rejected rather than guessed", () => {
  // The take is missing its middle phrase entirely.
  const words = speak(`${TARGETS[0]!.text} ${TARGETS[2]!.text}`);
  const aligned = alignPhrases(words, TARGETS);
  assert.equal(aligned[1]!.confidence, 0);
  assert.equal(aligned[1]!.durationMs, 0);
  const verdict = verifyAlignment(aligned, 20_000);
  assert.equal(verdict.ok, false, "a video must not be built on a missing phrase");
  assert.ok(verdict.reasons.some((r) => r.includes("promise")));
});

test("a repeated word does not drag a boundary backwards", () => {
  // "A slot is a date" repeats "a"; a greedy match could pair the second phrase's
  // first word with an earlier occurrence and put the phrase before its predecessor.
  const targets = [
    {sectionId: "s", phraseId: "one", text: "A thought is a question."},
    {sectionId: "s", phraseId: "two", text: "A slot is a date."},
  ];
  const aligned = alignPhrases(speak(targets.map((t) => t.text).join(" ")), targets);
  assert.ok(aligned[1]!.startMs > aligned[0]!.startMs);
  assert.ok(verifyAlignment(aligned, 20_000).ok);
});

test("a substitution before a repeated word does not jump to the later occurrence", () => {
  const words = speak("Veröffentliche dem Gedanken nicht den Versuch");
  const [phrase] = alignPhrases(words, [
    {sectionId: "close", phraseId: "publish", text: "Veröffentliche den Gedanken, nicht den Versuch."},
  ]);
  assert.equal(phrase?.confidence, 5 / 6);
  assert.equal(phrase?.startMs, 0);
  assert.equal(phrase?.durationMs, 2350);
});

test("an alignment running past the end of the audio is rejected", () => {
  const aligned = alignPhrases(speak(SCRIPT), TARGETS);
  const verdict = verifyAlignment(aligned, 1_000);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes("after the audio")));
});
