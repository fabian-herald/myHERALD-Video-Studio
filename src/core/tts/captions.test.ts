import assert from "node:assert/strict";
import {test} from "node:test";
import {videoPlanZ, type VideoPlan} from "../plan/schema.ts";
import {buildCaptions, captionTranscript} from "./captions.ts";

const plan: VideoPlan = videoPlanZ.parse({
  schemaVersion: 1,
  id: "test-video",
  createdAt: "2026-07-28T00:00:00.000Z",
  brief: "brief",
  intent: "promotional",
  formats: ["9x16"],
  language: "en",
  title: "Test",
  thesis: "A thesis.",
  sections: [
    {
      id: "hook",
      kind: "hook",
      onScreen: "Hook",
      phrases: [
        {id: "a", text: "Your calendar is full.", startMs: 0, durationMs: 2000},
        {id: "b", text: "Your thinking is not.", startMs: 2100, durationMs: 1800},
      ],
    },
    {id: "silent", kind: "turn", onScreen: "Turn", phrases: []},
  ],
  narration: {provider: "gemini", voice: "Achird", style: ""},
});

test("page boundaries come straight from the measured clips", () => {
  const captions = buildCaptions(plan);
  assert.equal(captions.pages.length, 2, "a silent section contributes no caption page");
  assert.deepEqual(
    captions.pages.map((page) => [page.fromMs, page.toMs]),
    [[0, 2000], [2100, 3900]],
  );
});

test("word timings stay inside their page and cover it end to end", () => {
  const captions = buildCaptions(plan);
  for (const page of captions.pages) {
    const words = captions.tokens.filter((token) => token.cueIndex === page.cueIndex);
    assert.ok(words.length > 0);
    assert.equal(words[0]?.fromMs, page.fromMs, "the first word starts with the page");
    assert.equal(words.at(-1)?.toMs, page.toMs, "the last word ends with the page");
    for (const word of words) {
      assert.ok(word.fromMs >= page.fromMs && word.toMs <= page.toMs);
    }
  }
});

test("punctuation earns extra time, so a sentence end lands later", () => {
  const captions = buildCaptions(plan);
  const first = captions.tokens.filter((token) => token.cueIndex === 0);
  const spans = first.map((token) => token.toMs - token.fromMs);
  assert.ok(
    (spans.at(-1) ?? 0) > (spans[0] ?? 0),
    "'full.' should hold longer than 'Your'",
  );
});

test("the transcript is exactly what QC compares the tokens against", () => {
  const captions = buildCaptions(plan);
  assert.equal(captionTranscript(captions), "Your calendar is full. Your thinking is not.");
  assert.equal(
    captions.tokens.map((token) => token.text).join(" "),
    captionTranscript(captions),
  );
});

test("the caption record names the path the timings actually came from", () => {
  // This shipped a whole video claiming "measured TTS clips" while the plan had been
  // force-aligned to one take. The string is provenance, so it has to follow the plan.
  const aligned = buildCaptions({
    ...plan,
    narration: {...plan.narration, timing: "aligned-take"},
  });
  assert.match(aligned.alignment, /one continuous take/);
  assert.doesNotMatch(aligned.alignment, /measured TTS clips/);

  const clips = buildCaptions({
    ...plan,
    narration: {...plan.narration, timing: "measured-clips"},
  });
  assert.match(clips.alignment, /measured TTS clips/);

  // Word placement is the one approximation on both paths, so it is always disclosed.
  for (const captions of [aligned, clips]) {
    assert.match(captions.alignment, /character-and-punctuation weight/);
  }
});

test("an un-narrated plan does not claim its guesses were measured", () => {
  const captions = buildCaptions(plan);
  assert.equal(plan.narration.timing, "planned", "the schema default, before any retime");
  assert.match(captions.alignment, /no audio has been synthesised/);
});
