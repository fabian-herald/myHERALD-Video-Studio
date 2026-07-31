import fs from "node:fs/promises";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {loadLocalEnv} from "../src/core/env.ts";
import {ROOT} from "../src/core/paths.ts";
import {probeDuration, run} from "../src/core/util/exec.ts";
import {masterListeningFile, unexplainedSilences} from "../src/core/tts/bakeoff/quality.ts";
import {buildIntentTakePrompt, GEMINI_TTS_MODEL, renderGeminiPrompt} from "../src/core/tts/gemini.ts";
import {intentNarrationProfile} from "../src/core/tts/intent-profile.ts";
import {compactSectionGaps} from "../src/core/tts/section-gaps.ts";
import type {TakeRequest} from "../src/core/tts/provider.ts";
import type {NarrationProfileId, VideoPlan} from "../src/core/plan/schema.ts";

type Intent = VideoPlan["intent"];
type TestProfile = {intent: Intent; profileId?: NarrationProfileId; title: string; sections: string[][]};
type TestSet = {
  schemaVersion: number;
  language: string;
  notice: string;
  profiles: TestProfile[];
};
type Silence = {startMs: number; endMs: number; durationMs: number};

await loadLocalEnv();

const testSetPath = path.join(ROOT, "data/narration-bakeoff/intent-profile-listening.en.json");
const testSet = JSON.parse(await fs.readFile(testSetPath, "utf8")) as TestSet;
const requestedProfiles = process.argv.find((value) => value.startsWith("--profiles="))?.split("=")[1];
const requestedIntents = process.argv.find((value) => value.startsWith("--intents="))?.split("=")[1];
const requested = new Set(
  (requestedProfiles ?? requestedIntents
    ?? testSet.profiles.map((profile) => profile.profileId ?? profile.intent).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const known = new Set(testSet.profiles.flatMap((profile) => [profile.intent, profile.profileId].filter(Boolean)));
for (const selection of requested) {
  if (!known.has(selection as Intent)) throw new Error(`Unknown listening-test profile or intent: ${selection}`);
}
const takes = Math.max(1, Number.parseInt(
  process.argv.find((value) => value.startsWith("--takes="))?.split("=")[1] ?? "1",
  10,
));
const kit = JSON.parse(await fs.readFile(path.join(ROOT, "data/brand/kit.json"), "utf8")) as {
  voice: {narrationStyle: string; narratorRegister: string};
};
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const runDir = path.join(ROOT, "out/narration-profile-listening", runId);
const rawDir = path.join(runDir, "raw");
const listeningDir = path.join(runDir, "listening");
await Promise.all([rawDir, listeningDir].map((dir) => fs.mkdir(dir, {recursive: true})));

const records = [];
for (const item of testSet.profiles.filter((profile) =>
  requested.has(requestedProfiles ? profile.profileId ?? profile.intent : profile.intent)
  || requested.has(profile.profileId ?? profile.intent))) {
  const profile = intentNarrationProfile(item.intent, item.profileId);
  for (let take = 1; take <= takes; take++) {
    const text = item.sections.flat().join(" ");
    const stem = `${profile.id}-take-${take}`;
    const request: TakeRequest = {
      text,
      voiceId: "Achird",
      style: kit.voice.narrationStyle,
      register: kit.voice.narratorRegister,
      language: testSet.language,
      intent: item.intent,
      profileId: profile.id,
      arc: "",
      blocks: item.sections.map((lines) => ({direction: "", lines})),
      outputPath: path.join(rawDir, `${stem}.wav`),
    };
    const prompt = buildIntentTakePrompt(request, item.intent, profile.id);
    const promptPath = path.join(rawDir, `${stem}.prompt.txt`);
    await fs.writeFile(promptPath, `${prompt}\n`);

    console.log(`Generating ${item.title} · take ${take}...`);
    const generated = await renderGeminiPrompt(
      prompt,
      request.voiceId,
      request.outputPath,
      (line) => console.log(`  ${line}`),
      undefined,
      {temperature: 1},
    );

  const rawDurationMs = generated.durationMs;
  const silences = await detectSilences(request.outputPath);
  const boundaries = choosePromptedSectionPauses(silences, item.sections.length - 1, profile.sectionGapMs);
  const controlledPath = path.join(rawDir, `${stem}.controlled.wav`);
  const placed = placedSections(boundaries, rawDurationMs);
  // Some prompted pauses may already be at or below the target and therefore do not
  // appear in the overlong-silence set. Compact every detected overlong marker; do not
  // require all section boundaries to need treatment.
  const controlled = boundaries.length > 0
    ? await compactSectionGaps(request.outputPath, controlledPath, placed, profile.sectionGapMs)
    : null;
  const sourceForListening = controlled?.outputPath ?? request.outputPath;
  const blindName = `${randomBytes(2).toString("hex").toUpperCase()}-${profile.id}-${take}.wav`;
  const listeningPath = path.join(listeningDir, blindName);
  const masteredDurationSeconds = await masterListeningFile(sourceForListening, listeningPath);
  const longSilences = await unexplainedSilences(listeningPath);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const rawWordsPerSecond = wordCount / (rawDurationMs / 1000);
  const [rawPaceMinimum, rawPaceMaximum] = profile.rawPaceRange;

  records.push({
    intent: item.intent,
    take,
    title: item.title,
    language: testSet.language,
    notice: testSet.notice,
    provider: "Google Gemini TTS",
    model: GEMINI_TTS_MODEL,
    voiceId: request.voiceId,
    temperature: 1,
    promptProfileId: profile.id,
    sectionGapTargetMs: profile.sectionGapMs,
    requestedSectionPauses: item.sections.length - 1,
    detectedSectionPauses: boundaries,
    controlledCuts: controlled?.cuts ?? [],
    rawDurationMs,
    rawWordsPerSecond,
    rawPaceRange: profile.rawPaceRange,
    rawPacePassed: rawWordsPerSecond >= rawPaceMinimum && rawWordsPerSecond <= rawPaceMaximum,
    masteredDurationMs: Math.round(masteredDurationSeconds * 1000),
    wordsPerSecond: wordCount / masteredDurationSeconds,
    unexplainedSilencesOver900Ms: longSilences,
    // Billing follows provider output, before local silence control and mastering.
    estimatedCostUsd: (rawDurationMs / 1000) * 0.0005,
    requestId: generated.requestId,
    promptPath: relative(promptPath),
    rawPath: relative(request.outputPath),
    controlledPath: controlled ? relative(controlled.outputPath) : null,
    listeningPath: relative(listeningPath),
  });
  }
}

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  purpose: "Internal listening check for selected Gemini intent profiles.",
  sourceScript: relative(testSetPath),
  mastering: "48 kHz mono PCM, -16 LUFS, -1.5 dBTP; no time stretching or pitch shifting.",
  records,
};
await fs.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nListening files: ${listeningDir}`);
for (const record of records) {
  console.log(`${record.intent.padEnd(18)} ${path.basename(record.listeningPath)}  ${(record.masteredDurationMs / 1000).toFixed(2)}s`);
}

async function detectSilences(file: string): Promise<Silence[]> {
  const {stderr} = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file,
    "-af", "silencedetect=noise=-42dB:d=0.55", "-f", "null", "-",
  ]);
  const events = [...stderr.matchAll(/silence_(start|end):\s*([\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/g)];
  const silences: Silence[] = [];
  let startMs: number | null = null;
  for (const event of events) {
    if (event[1] === "start") {
      startMs = Math.round(Number(event[2]) * 1000);
    } else if (startMs !== null) {
      const endMs = Math.round(Number(event[2]) * 1000);
      silences.push({startMs, endMs, durationMs: endMs - startMs});
      startMs = null;
    }
  }
  return silences;
}

function choosePromptedSectionPauses(silences: Silence[], count: number, targetMs: number) {
  return silences
    .filter((silence) => silence.durationMs >= targetMs + 200)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, count)
    .sort((a, b) => a.startMs - b.startMs);
}

function placedSections(boundaries: Silence[], durationMs: number) {
  const starts = [0, ...boundaries.map((silence) => silence.endMs)];
  const ends = [...boundaries.map((silence) => silence.startMs), durationMs];
  return starts.map((startMs, index) => ({
    sectionId: `section-${index + 1}`,
    phraseId: `section-${index + 1}`,
    text: "",
    startMs,
    durationMs: Math.max(1, ends[index]! - startMs),
  }));
}

function relative(file: string) {
  return path.relative(ROOT, file);
}
