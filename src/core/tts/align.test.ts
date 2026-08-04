import assert from "node:assert/strict";
import {test} from "node:test";
import {alignPhrases, boundWeakPhrases, normalise, verifyAlignment, type TimedWord} from "./align.ts";

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

// One weak phrase used to discard a whole usable take, which bought a clip per phrase and
// with it a different speaker on every clip. These pin the narrower rule.

const weakPhrase = (confidence: number, startMs: number, durationMs: number) =>
  ({sectionId: "s", phraseId: `p${startMs}`, startMs, durationMs, confidence});

test("one weakly-matched phrase does not condemn the take", () => {
  const aligned = [
    weakPhrase(1, 0, 2_000),
    weakPhrase(0.67, 2_100, 1_800),
    weakPhrase(1, 4_000, 2_000),
    weakPhrase(1, 6_000, 2_000),
  ];
  const verdict = verifyAlignment(aligned, 20_000);
  assert.equal(verdict.ok, true, "67% of one phrase in four is a hard line, not a bad take");
  assert.equal(verdict.weak.length, 1);
  assert.match(verdict.weak[0] ?? "", /matched only 67%/);
});

test("a take that is mostly guesswork is still rejected", () => {
  const aligned = [
    weakPhrase(0.4, 0, 2_000),
    weakPhrase(0.5, 2_000, 2_000),
    weakPhrase(1, 4_000, 2_000),
    weakPhrase(1, 6_000, 2_000),
  ];
  const verdict = verifyAlignment(aligned, 20_000);
  assert.equal(verdict.ok, false, "half the take unrecognised means the audio is not the script");
  assert.match(verdict.reasons.join(" "), /2 of 4 phrases matched weakly/);
});

test("a phrase found nowhere is a hard failure, not a weak one", () => {
  const aligned = [weakPhrase(1, 0, 2_000), weakPhrase(0, 0, 0), weakPhrase(1, 4_000, 2_000)];
  const verdict = verifyAlignment(aligned, 20_000);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /was not located in the take/);
  assert.equal(verdict.weak.length, 0, "unlocated is a different kind of problem from weak");
});

test("out-of-order phrases still condemn the take however confident they are", () => {
  const aligned = [weakPhrase(1, 5_000, 2_000), weakPhrase(1, 1_000, 2_000)];
  assert.equal(verifyAlignment(aligned, 20_000).ok, false);
});

test("a weak phrase takes its boundaries from the neighbours that are certain", () => {
  const bounded = boundWeakPhrases([
    weakPhrase(1, 0, 2_000),
    weakPhrase(0.67, 2_500, 900),
    weakPhrase(1, 4_000, 2_000),
  ]);
  // It occupies the gap its neighbours prove: 2000 -> 4000, not the 2500-3400 it guessed.
  assert.equal(bounded[1]!.startMs, 2_000);
  assert.equal(bounded[1]!.durationMs, 2_000);
  // The confident neighbours are untouched.
  assert.equal(bounded[0]!.startMs, 0);
  assert.equal(bounded[2]!.startMs, 4_000);
});

test("an edge phrase keeps its own match, having only one neighbour", () => {
  const aligned = [weakPhrase(0.6, 100, 1_800), weakPhrase(1, 2_000, 2_000)];
  const bounded = boundWeakPhrases(aligned);
  assert.deepEqual(bounded[0], aligned[0], "nothing on the left to bound it with");
});

test("a weak phrase beside another weak one is left alone", () => {
  const aligned = [weakPhrase(1, 0, 2_000), weakPhrase(0.6, 2_000, 900), weakPhrase(0.5, 3_000, 900)];
  const bounded = boundWeakPhrases(aligned);
  assert.deepEqual(bounded[1], aligned[1], "an uncertain neighbour proves nothing");
});

test("neighbours that leave no room do not produce a negative span", () => {
  const bounded = boundWeakPhrases([
    weakPhrase(1, 0, 4_000),
    weakPhrase(0.6, 1_000, 500),
    weakPhrase(1, 2_000, 1_000),
  ]);
  assert.equal(bounded[1]!.durationMs, 500, "kept what the walk found rather than writing a negative");
});

test("a confident take is returned unchanged", () => {
  const aligned = [weakPhrase(1, 0, 2_000), weakPhrase(0.9, 2_000, 2_000), weakPhrase(1, 4_000, 2_000)];
  assert.deepEqual(boundWeakPhrases(aligned), aligned);
});
