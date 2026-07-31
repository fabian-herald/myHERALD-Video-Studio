import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateLanguage, BAKEOFF_CANDIDATES, CARTESIA_KYLE_VOICE_ID,
  CARTESIA_THEO_VOICE_ID, SONIC_SNAPSHOT,
} from "./catalog.ts";
import {
  geminiBalancedPrompt, geminiProductionPrompt, geminiSimplePrompt, geminiStudioPrompt,
  qwenContinueTask, qwenFinishTask, qwenRunTask,
  sonicContinuationRequests, sonicHttpRequest, sonicKyleRequest,
} from "./providers.ts";
import {loadBakeoffScript, pauseTaggedTranscript, performanceTaggedTranscript, ssmlTranscript} from "./scripts.ts";

test("both language scripts preserve seven sections and 27 phrase identities", async () => {
  const [english, german] = await Promise.all([
    loadBakeoffScript("thought-leadership-7e83b7", "en"),
    loadBakeoffScript("thought-leadership-7e83b7", "de"),
  ]);
  assert.equal(english.sections.length, 7);
  assert.equal(german.sections.length, 7);
  assert.deepEqual(
    german.sections.flatMap((section) => section.phrases.map((phrase) => `${section.id}/${phrase.id}`)),
    english.sections.flatMap((section) => section.phrases.map((phrase) => `${section.id}/${phrase.id}`)),
  );
  assert.equal(english.sections.flatMap((section) => section.phrases).length, 27);
  assert.match(pauseTaggedTranscript(english), /\[short pause\]/);
  assert.match(performanceTaggedTranscript(english), /^\[observant\]/);
  assert.match(ssmlTranscript(german), /<break time="650ms"\/>/);
});

test("Gemini directed voices share the exact Studio-style prompt", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "en");
  const prompt = geminiStudioPrompt(script);
  assert.match(prompt, /# Audio Profile/);
  assert.match(prompt, /# Director's note/);
  assert.match(prompt, /## Scene:/);
  assert.match(prompt, /## Sample Context:/);
  assert.match(prompt, /## Transcript:\n\[observant\]/);
  assert.ok(prompt.trimEnd().endsWith("Publish the thought, not the attempt."));
  const directed = BAKEOFF_CANDIDATES.filter((item) => item.id === "gemini-pause-tags" || item.id === "gemini-directed-algenib");
  assert.deepEqual(directed.map((item) => item.defaultVoiceId), ["Achird", "Algenib"]);
});

test("Gemini production candidate preserves the current prompt for a prompt-only A/B", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "en");
  const prompt = geminiProductionPrompt(script);
  assert.match(prompt, /^Read the following transcript/);
  assert.match(prompt, /# Audio Profile/);
  assert.match(prompt, /Thought leadership with calm authority/);
  assert.match(prompt, /Aim for around 80 seconds/);
  assert.match(prompt, /## Transcript:/);
  assert.equal(prompt.match(/\[short pause\]/g)?.length, 6);
  assert.doesNotMatch(prompt, /## Sample Context:/);
  const candidate = BAKEOFF_CANDIDATES.find((item) => item.id === "gemini-production-prompt-achird");
  assert.equal(candidate?.defaultVoiceId, "Achird");
  assert.equal(candidate?.optIn, true);
});

test("Gemini simplified prompt keeps only three expression tags and a direct pace target", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "en");
  const prompt = geminiSimplePrompt(script);
  assert.match(prompt, /Pace: Brisk and continuous, with no dead air\. Aim for about 75 seconds/);
  assert.doesNotMatch(prompt, /## Sample Context:|\[(?:short|medium) pause\]/);
  assert.deepEqual(prompt.match(/\[(?:observant|conviction|confident)\]/g), [
    "[observant]", "[conviction]", "[confident]",
  ]);
  assert.ok(prompt.trimEnd().endsWith("Publish the thought, not the attempt."));
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "gemini-simple-directed-achird")?.optIn, true);
});

test("Gemini balanced prompt restores calm authority and only pauses between sections", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "en");
  const prompt = geminiBalancedPrompt(script);
  assert.match(prompt, /Thought leadership with calm authority/);
  assert.match(prompt, /Aim for around 80 seconds; never rush a paragraph transition/);
  assert.equal(prompt.match(/\[short pause\]/g)?.length, 6);
  assert.equal(prompt.match(/\[(?:observant|conviction|confident)\]/g)?.length, 3);
  assert.doesNotMatch(prompt, /## Sample Context:|\[medium pause\]/);
  assert.ok(prompt.trimEnd().endsWith("Publish the thought, not the attempt."));
  assert.equal(
    BAKEOFF_CANDIDATES.find((item) => item.id === "gemini-balanced-thought-leadership-achird")?.optIn,
    true,
  );
});

test("unsupported provider-language combinations fail at the capability gate", () => {
  assert.throws(() => assertCandidateLanguage("simba-3.2", "de"), /no API request was made/);
  assert.throws(() => assertCandidateLanguage("qwen-plus", "de"), /no API request was made/);
  assert.doesNotThrow(() => assertCandidateLanguage("sonic-3.5", "de"));
});

test("MiniMax is reserve-only, not an executable candidate", () => {
  assert.equal(BAKEOFF_CANDIDATES.some((item) => item.id.includes("minimax")), false);
});

test("rejected Chirp remains reproducible but is retired from default runs", () => {
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "chirp-achird")?.retired, true);
});

test("Sonic uses one context, one voice, and seven pinned continuation inputs", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "de");
  const requests = sonicContinuationRequests(script, "one-context", "one-voice");
  assert.equal(requests.length, 7);
  assert.deepEqual(new Set(requests.map((request) => request.context_id)), new Set(["one-context"]));
  assert.deepEqual(new Set(requests.map((request) => request.voice.id)), new Set(["one-voice"]));
  assert.deepEqual(new Set(requests.map((request) => request.model_id)), new Set([SONIC_SNAPSHOT]));
  assert.deepEqual(requests.map((request) => request.continue), [true, true, true, true, true, true, false]);
});

test("Sonic defaults to the resolved Theo voice", () => {
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "sonic-3.5")?.defaultVoiceId, CARTESIA_THEO_VOICE_ID);
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "sonic-3.5")?.retired, true);
});

test("Sonic HTTP candidate reproduces the supplied defaults and adds only language", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "de");
  const request = sonicHttpRequest(script, CARTESIA_THEO_VOICE_ID);
  assert.equal(request.model_id, "sonic-3.5");
  assert.equal(request.voice.id, CARTESIA_THEO_VOICE_ID);
  assert.deepEqual(request.output_format, {container: "wav", encoding: "pcm_s16le", sample_rate: 44100});
  assert.deepEqual(request.generation_config, {speed: 1, volume: 1});
  assert.equal(request.language, "de");
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "sonic-3.5-http-default")?.optIn, true);
});

test("Sonic Kyle uses supported contemplative emotion and sparse section breaks", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "en");
  const request = sonicKyleRequest(script);
  assert.equal(request.model_id, SONIC_SNAPSHOT);
  assert.equal(request.voice.id, CARTESIA_KYLE_VOICE_ID);
  assert.deepEqual(request.generation_config, {emotion: "contemplative"});
  assert.equal(request.transcript.match(/<break time="550ms"\/>/g)?.length, 6);
  assert.doesNotMatch(request.transcript, /\[natural\]|<natural>/i);
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "sonic-3.5-kyle-contemplative")?.optIn, true);
  assert.equal(BAKEOFF_CANDIDATES.find((item) => item.id === "sonic-3.5-kyle-contemplative")?.retired, true);
});

test("Qwen keeps one task id across run, seven inputs, and finish", async () => {
  const script = await loadBakeoffScript("thought-leadership-7e83b7", "en");
  const id = "one-task";
  const messages = [
    qwenRunTask(id, "one-voice"),
    ...script.sections.map((section) => qwenContinueTask(id, section.phrases.map((phrase) => phrase.text).join(" "))),
    qwenFinishTask(id),
  ];
  assert.equal(messages.length, 9);
  assert.deepEqual(new Set(messages.map((message) => message.header.task_id)), new Set([id]));
  assert.equal(messages[0]?.header.action, "run-task");
  assert.equal(messages.at(-1)?.header.action, "finish-task");
});
