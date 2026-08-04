import fs from "node:fs/promises";
import path from "node:path";
import {randomBytes, randomUUID} from "node:crypto";
import {loadLocalEnv} from "../src/core/env.ts";
import {ROOT} from "../src/core/paths.ts";
import {exists, probeDuration} from "../src/core/util/exec.ts";
import {alignPhrases, verifyAlignment} from "../src/core/tts/align.ts";
import {measureFade, MAX_FADE_DB} from "../src/core/tts/level.ts";
import {transcribeWords} from "../src/core/tts/transcribe.ts";
import {BAKEOFF_CANDIDATES, candidate, estimateCost, missingCredentials} from "../src/core/tts/bakeoff/catalog.ts";
import {generateCandidate} from "../src/core/tts/bakeoff/providers.ts";
import {
  averageConfidence, controlledSlices, masterListeningFile, peakDb,
  unexplainedSilences, wordErrorRate, BETWEEN_SECTION_GAP_MS, WITHIN_SECTION_GAP_MS,
} from "../src/core/tts/bakeoff/quality.ts";
import {alignmentTargets, BAKEOFF_SCRIPT_ID, loadBakeoffScript, plainTranscript} from "../src/core/tts/bakeoff/scripts.ts";
import type {
  AutomaticQuality, BakeoffLanguage, BakeoffManifest, CandidateRecord, ProviderGeneration,
} from "../src/core/tts/bakeoff/types.ts";

await loadLocalEnv();

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const reprocess = has("reprocess");
const screening = has("screening");
const videoId = flag("video") ?? BAKEOFF_SCRIPT_ID;
const takes = Math.max(1, Number.parseInt(flag("takes") ?? "2", 10));
const languages = parseLanguages(flag("languages") ?? "en,de");
const requested = new Set((flag("candidates") ?? BAKEOFF_CANDIDATES.filter((item) => !item.retired && !item.optIn).map((item) => item.id).join(","))
  .split(",").map((value) => value.trim()).filter(Boolean));
for (const id of requested) candidate(id);

const resumeId = flag("resume");
const runId = resumeId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const runDir = path.join(ROOT, "out/narration-bakeoff", videoId, runId);
const rawDir = path.join(runDir, "raw");
const listeningDir = path.join(runDir, "listening");
const scratchDir = path.join(runDir, "scratch");
await Promise.all([rawDir, listeningDir, scratchDir].map((dir) => fs.mkdir(dir, {recursive: true})));

const scripts = new Map<BakeoffLanguage, Awaited<ReturnType<typeof loadBakeoffScript>>>();
for (const language of languages) {
  const script = await loadBakeoffScript(videoId, language);
  scripts.set(language, script);
  await writeJson(path.join(runDir, `script-${language}.json`), script);
}

let manifest: BakeoffManifest;
if (resumeId) {
  manifest = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf8")) as BakeoffManifest;
  if (manifest.videoId !== videoId) throw new Error(`Resume run belongs to ${manifest.videoId}, not ${videoId}.`);
} else {
  const records: CandidateRecord[] = [];
  for (const language of languages) {
    for (const item of BAKEOFF_CANDIDATES) {
      if (!requested.has(item.id) || !item.languages.includes(language)) continue;
      for (let take = 1; take <= takes; take++) {
        records.push({
          id: randomUUID(), candidateId: item.id, candidateLabel: item.label,
          language, take, status: "pending",
        });
      }
    }
  }
  manifest = {schemaVersion: 1, videoId, createdAt: new Date().toISOString(), candidates: records};
}
const records = manifest.candidates;
await saveState(runDir, manifest);

if (!has("prepare")) {
  if (!screening && !process.env.GROQ_API_KEY?.trim()) {
    throw new Error("GROQ_API_KEY is required for exact-script alignment and WER gates.");
  }
  for (const record of records) {
    if (!reprocess && (record.status === "needs-listening" || record.status === "rejected") && record.quality) continue;
    const item = candidate(record.candidateId);
    const missing = missingCredentials(item);
    if (missing.length) {
      record.status = "skipped";
      record.reason = `Missing ${missing.join(", ")}. No API request was made.`;
      console.log(`skip          ${record.language} ${record.candidateLabel}: ${record.reason}`);
      await saveState(runDir, manifest);
      continue;
    }
    const script = scripts.get(record.language)!;
    const outputDir = path.join(rawDir, record.language, record.candidateId, `take-${record.take}`);
    try {
      const savedRaw = record.rawPath ? path.join(ROOT, record.rawPath) : null;
      let generated: ProviderGeneration;
      if (savedRaw && await exists(savedRaw)) {
        console.log(`reuse         ${record.language} ${record.candidateLabel} · take ${record.take}`);
        generated = {
          rawPath: savedRaw,
          rawParts: record.rawParts?.map((file) => path.join(ROOT, file)),
          model: record.model ?? item.model,
          modelSnapshot: record.modelSnapshot,
          voiceId: record.voiceId ?? item.defaultVoiceId ?? "unknown",
          locale: record.locale ?? record.language,
          requestIds: record.requestIds ?? [],
          parameters: record.parameters ?? {resumed: true},
          repeatabilityComparable: record.repeatabilityComparable,
        };
      } else {
        console.log(`generate      ${record.language} ${record.candidateLabel} · take ${record.take}`);
        generated = await generateCandidate({
          candidateId: record.candidateId,
          language: record.language,
          script,
          outputDir,
          take: record.take,
          onLog: (line) => console.log(`              ${line}`),
        });
      }
      record.reason = undefined;
      record.quality = undefined;
      const rawDurationSeconds = await probeDuration(generated.rawPath);
      record.rawPath = relative(generated.rawPath);
      record.provider = item.provider;
      record.model = generated.model;
      record.modelSnapshot = generated.modelSnapshot;
      record.voiceId = generated.voiceId;
      record.locale = generated.locale;
      record.requestIds = generated.requestIds;
      record.parameters = generated.parameters;
      record.rawParts = generated.rawParts?.map(relative);
      record.repeatabilityComparable = generated.repeatabilityComparable ?? true;
      record.costUsd = estimateCost(item, generated.billedCharacters ?? plainTranscript(script).length, rawDurationSeconds);
      record.costKind = item.pricing.unit === "baseline" ? "baseline" : "estimated";

      if (screening) {
        const listeningName = `${record.language}-${randomBytes(5).toString("hex")}.wav`;
        const listeningPath = path.join(listeningDir, listeningName);
        await masterListeningFile(generated.rawPath, listeningPath);
        delete record.controlledPath;
        delete record.quality;
        record.listeningPath = relative(listeningPath);
        record.status = "needs-listening";
        record.reason = "Screening only: no audio was sent to ASR and automatic gates were not run.";
        record.timingProvenance = {
          method: "provider-native-continuous",
          withinSectionGapMs: WITHIN_SECTION_GAP_MS,
          betweenSectionGapMs: BETWEEN_SECTION_GAP_MS,
          slices: [],
        };
        console.log(`screening     ${record.language} ${record.candidateLabel} · ${listeningName}`);
        await saveState(runDir, manifest);
        continue;
      }

      const transcriptPath = path.join(outputDir, "transcript.json");
      const transcript = await exists(transcriptPath)
        ? JSON.parse(await fs.readFile(transcriptPath, "utf8")) as Awaited<ReturnType<typeof transcribeWords>>
        : await transcribeWords(
          generated.rawPath,
          record.language,
          path.join(scratchDir, record.id, "transcription"),
          (line) => console.log(`              ${line}`),
        );
      if (!await exists(transcriptPath)) await writeJson(transcriptPath, transcript);
      record.transcriptModel = transcript.model;
      const targets = alignmentTargets(script);
      const aligned = alignPhrases(transcript.words, targets);
      const verdict = verifyAlignment(aligned, Math.round(rawDurationSeconds * 1000));
      const wer = wordErrorRate(plainTranscript(script), transcript.words);
      if (!verdict.ok) throw new Error(`Unsafe alignment: ${verdict.reasons.join("; ")}`);

      const slices = controlledSlices(aligned, targets, Math.round(rawDurationSeconds * 1000));
      const listeningName = `${record.language}-${randomBytes(5).toString("hex")}.wav`;
      const listeningPath = path.join(listeningDir, listeningName);
      // Keep speech continuous. The earlier phrase extraction path could land on ASR
      // word boundaries and audibly remove phonemes even when transcript WER passed.
      // Provider-native pauses remain part of the take; mastering changes only format
      // and loudness.
      const masteredDuration = await masterListeningFile(generated.rawPath, listeningPath);
      const [rawPeak, fade, longSilences] = await Promise.all([
        peakDb(generated.rawPath), measureFade(listeningPath), unexplainedSilences(listeningPath),
      ]);
      const reasons: string[] = [];
      if (wer > 0.02) reasons.push(`WER ${(wer * 100).toFixed(1)}% exceeds 2%`);
      if (rawPeak !== null && rawPeak >= -0.05) reasons.push(`raw audio clips at ${rawPeak.toFixed(2)} dBFS`);
      if (fade && fade.fadeDb > MAX_FADE_DB) reasons.push(`terminal fade is ${fade.fadeDb.toFixed(1)} dB`);
      if (longSilences.length) reasons.push(`unexplained silence reaches ${Math.max(...longSilences).toFixed(2)}s`);
      const quality: AutomaticQuality = {
        passed: reasons.length === 0,
        reasons,
        transcriptWer: wer,
        alignmentConfidence: averageConfidence(aligned),
        durationMs: Math.round(masteredDuration * 1000),
        peakDb: rawPeak,
        terminalFadeDb: fade?.fadeDb ?? null,
        maxControlledGapMs: Math.max(...slices.map((slice) => slice.gapAfterMs)),
        pace: {
          language: record.language,
          words: transcriptWords(script),
          characters: transcriptCharacters(script),
          totalSeconds: masteredDuration,
          articulationSeconds: Math.max(0.001, aligned.reduce((sum, phrase) => sum + phrase.durationMs, 0) / 1000),
          wordsPerSecond: transcriptWords(script) / masteredDuration,
          articulationWordsPerSecond: transcriptWords(script) / Math.max(
            0.001,
            aligned.reduce((sum, phrase) => sum + phrase.durationMs, 0) / 1000,
          ),
        },
      };
      delete record.controlledPath;
      record.listeningPath = relative(listeningPath);
      record.quality = quality;
      record.timingProvenance = {
        method: "provider-native-continuous",
        withinSectionGapMs: WITHIN_SECTION_GAP_MS,
        betweenSectionGapMs: BETWEEN_SECTION_GAP_MS,
        slices: slices.map((slice) => ({
          sectionId: slice.sectionId,
          phraseId: slice.phraseId,
          sourceStartMs: slice.startMs,
          sourceDurationMs: slice.durationMs,
          gapAfterMs: slice.gapAfterMs,
        })),
      };
      record.status = quality.passed ? "needs-listening" : "rejected";
      if (reasons.length) record.reason = reasons.join("; ");
      console.log(`quality       ${quality.passed ? "automatic gates passed" : "REJECT"} · WER ${(wer * 100).toFixed(1)}% · ${listeningName}`);
    } catch (error) {
      record.status = "failed";
      record.reason = error instanceof Error ? error.message : String(error);
      console.error(`failed        ${record.language} ${record.candidateLabel}: ${record.reason}`);
    }
    await saveState(runDir, manifest);
  }
}

await writeBlindFiles(runDir, records);
await writeGateFiles(runDir, records, takes);
console.log("");
console.log(`bake-off      ${relative(runDir)}`);
console.log(`generated     ${records.filter((record) => record.listeningPath).length} listening files`);
console.log(`skipped       ${records.filter((record) => record.status === "skipped").length} credential-gated candidates`);
console.log("video render  not started; narration still requires blind listening approval");

function parseLanguages(value: string): BakeoffLanguage[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const language of values) {
    if (language !== "en" && language !== "de") throw new Error(`Unsupported bake-off language ${language}.`);
  }
  return values as BakeoffLanguage[];
}

async function saveState(dir: string, state: BakeoffManifest) {
  await writeJson(path.join(dir, "manifest.json"), state);
}

async function writeBlindFiles(dir: string, state: CandidateRecord[]) {
  const completed = state.filter((record) => record.listeningPath);
  const blind = completed.map((record) => ({
    listeningId: randomBytes(2).toString("hex").toUpperCase(),
    language: record.language,
    take: record.take,
    file: path.basename(record.listeningPath!),
  })).sort(() => Math.random() - 0.5);
  await writeJson(path.join(dir, "blind-listening.json"), blind);
  await writeJson(path.join(dir, "answer-key.json"), blind.map((entry) => {
    const source = completed.find((record) => path.basename(record.listeningPath!) === entry.file)!;
    return {...entry, candidateId: source.candidateId, candidateLabel: source.candidateLabel};
  }));
  await writeJson(path.join(dir, "review-sheet.json"), blind.map((entry) => ({
    ...entry,
    intelligibleWithoutCaptions: null,
    voiceCharacter1to5: null,
    pacing1to5: null,
    identityStable: null,
    sameCharacterAcrossLanguages: null,
    preferred: null,
    notes: "",
  })));
}

async function writeGateFiles(dir: string, state: CandidateRecord[], requiredTakes: number) {
  const groupKeys = [...new Set(state.map((record) => `${record.candidateId}/${record.language}`))];
  const groups = groupKeys.map((key) => {
    const [candidateId, language] = key.split("/");
    const records = state.filter((record) => record.candidateId === candidateId && record.language === language);
    const comparable = records.every((record) => record.repeatabilityComparable !== false);
    return {
      candidateId,
      language,
      requiredTakes,
      completedTakes: records.filter((record) => record.quality).length,
      repeatabilityComparable: comparable,
      automaticGatePassed: comparable
        && records.length >= requiredTakes
        && records.slice(0, requiredTakes).every((record) => record.quality?.passed),
      humanListeningRequired: true,
    };
  });
  await writeJson(path.join(dir, "automatic-selection-gates.json"), groups);
  await writeJson(path.join(dir, "pace-by-language.json"), ["en", "de"].map((language) => ({
    language,
    note: "Compare pace only among candidates aligned to this language-specific script.",
    candidates: state.filter((record) => record.language === language && record.quality).map((record) => ({
      listeningFile: path.basename(record.listeningPath ?? ""),
      take: record.take,
      ...record.quality!.pace,
    })),
  })));
}

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relative(file: string) {
  return path.relative(ROOT, file);
}

function transcriptWords(script: Awaited<ReturnType<typeof loadBakeoffScript>>) {
  return plainTranscript(script).split(/\s+/).filter(Boolean).length;
}

function transcriptCharacters(script: Awaited<ReturnType<typeof loadBakeoffScript>>) {
  return plainTranscript(script).replace(/\s/g, "").length;
}
