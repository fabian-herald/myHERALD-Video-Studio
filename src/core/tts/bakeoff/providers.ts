import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import WebSocket from "ws";
import {assembleNarration, type NarrationSegment} from "../../audio/master.ts";
import {arcDirection} from "../energy.ts";
import {probeDuration, run} from "../../util/exec.ts";
import {buildPrompt, buildTakePrompt, GEMINI_TTS_MODEL, renderGeminiPrompt} from "../gemini.ts";
import {
  assertCandidateLanguage,
  CARTESIA_KYLE_VOICE_ID,
  CARTESIA_THEO_VOICE_ID,
  SONIC_SNAPSHOT,
} from "./catalog.ts";
import {performanceTaggedTranscript, plainTranscript, sectionTexts, ssmlTranscript} from "./scripts.ts";
import type {BakeoffLanguage, BakeoffScript, ProviderGeneration} from "./types.ts";

export interface GenerateOptions {
  candidateId: string;
  language: BakeoffLanguage;
  script: BakeoffScript;
  outputDir: string;
  take: number;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

const STYLE = "Warm, credible, founder-to-founder. Conversational and restrained, crisp articulation, natural micro-pauses. No hype, no radio-announcer tone, no rising sell.";
const REGISTER = "one man, low-to-mid register, speaking pitch around 140 hertz";
const PRODUCTION_ENERGIES = ["settled", "quiet", "settled", "lift", "edge", "quiet", "lift"] as const;

export function qwenRunTask(taskId: string, voiceId: string) {
  return {
    header: {action: "run-task", task_id: taskId, streaming: "duplex"},
    payload: {
      task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "qwen-audio-3.0-tts-plus",
      parameters: {
        text_type: "PlainText", voice: voiceId, format: "mp3", sample_rate: 22050,
        volume: 50, rate: 1, pitch: 1, enable_ssml: false,
        language_hints: ["en"], instruction: "Natural, restrained, crisp male narration.",
      },
      input: {},
    },
  };
}

export const qwenContinueTask = (taskId: string, text: string) => ({
  header: {action: "continue-task", task_id: taskId, streaming: "duplex"},
  payload: {input: {text}},
});

export const qwenFinishTask = (taskId: string) => ({
  header: {action: "finish-task", task_id: taskId, streaming: "duplex"},
  payload: {input: {}},
});

export function sonicContinuationRequests(script: BakeoffScript, contextId: string, voiceId: string) {
  const sections = sectionTexts(script);
  return sections.map((transcript, index) => ({
    model_id: SONIC_SNAPSHOT,
    transcript,
    voice: {mode: "id", id: voiceId},
    output_format: {container: "raw", encoding: "pcm_f32le", sample_rate: 44100},
    language: script.language,
    context_id: contextId,
    continue: index < sections.length - 1,
    generation_config: {speed: 1},
  }));
}

export function sonicHttpRequest(script: BakeoffScript, voiceId: string) {
  return {
    model_id: "sonic-3.5",
    transcript: plainTranscript(script),
    voice: {mode: "id", id: voiceId},
    // Explicit language is the only addition to the supplied default example; it is
    // necessary for a controlled English/German test with one unchanged voice ID.
    language: script.language,
    output_format: {container: "wav", encoding: "pcm_s16le", sample_rate: 44100},
    generation_config: {speed: 1, volume: 1},
  };
}

export function sonicKyleRequest(script: BakeoffScript) {
  return {
    model_id: SONIC_SNAPSHOT,
    transcript: sectionTexts(script).join('<break time="550ms"/>'),
    voice: {mode: "id", id: CARTESIA_KYLE_VOICE_ID},
    language: script.language,
    output_format: {container: "wav", encoding: "pcm_s16le", sample_rate: 44100},
    generation_config: {emotion: "contemplative"},
  };
}

export async function generateCandidate(options: GenerateOptions): Promise<ProviderGeneration> {
  const item = assertCandidateLanguage(options.candidateId, options.language);
  await fs.mkdir(options.outputDir, {recursive: true});
  switch (options.candidateId) {
    case "existing-shortened": return existing(options);
    case "gemini-pause-tags": return geminiDirected(options, "Achird");
    case "gemini-production-prompt-achird": return geminiProduction(options);
    case "gemini-simple-directed-achird": return geminiSimple(options);
    case "gemini-balanced-thought-leadership-achird": return geminiBalanced(options);
    case "gemini-directed-algenib": return geminiDirected(options, "Algenib");
    case "gemini-seven-sections": return geminiSections(options);
    case "chirp-achird": return chirp(options);
    case "simba-3.2": return speechify(options, "simba-3.2");
    case "simba-3.0-de-diagnostic": return speechify(options, "simba-3.0");
    case "qwen-plus": return qwen(options);
    case "sonic-3.5": return sonic(options);
    case "sonic-3.5-http-default": return sonicHttp(options);
    case "sonic-3.5-kyle-contemplative": return sonicKyle(options);
    default: throw new Error(`No generator implemented for ${item.id}.`);
  }
}

async function existing(options: GenerateOptions): Promise<ProviderGeneration> {
  const source = path.join(
    process.cwd(), "data/videos", options.script.videoId, "narration", "take-48b5d1b2f29ff1100e8f.wav",
  );
  await fs.access(source);
  // The rejected baseline is one historical generation, not two independent samples.
  // Copy it into both take folders so the blinded layout stays balanced, but say so.
  const rawPath = path.join(options.outputDir, "raw.wav");
  await fs.copyFile(source, rawPath);
  return {
    rawPath,
    model: "existing-gemini-take",
    voiceId: "Achird",
    locale: "en-US",
    requestIds: [],
    parameters: {source: path.basename(source), offlineProcessingOnly: true},
    repeatabilityComparable: false,
  };
}

export function geminiStudioPrompt(script: BakeoffScript) {
  const language = script.language === "de" ? "German" : "English";
  const accent = script.language === "de" ? "Standard German" : "General American";
  return [
    "Read the following transcript based on the audio profile and director's note.",
    "",
    "# Audio Profile",
    "A smooth, premium editorial voice. Warm, credible, founder-to-founder.",
    "Conversational and restrained, with crisp articulation and no announcer tone.",
    `Speaker identity: ${REGISTER}. The same man speaks from the first word to the last.`,
    "",
    "# Director's note",
    "Style: Editorial thought leadership. Persuasive through conviction, never hype.",
    "Pace: Natural forward motion, concise micro-pauses, no dead air and no rushing.",
    `Accent: ${accent}. Language: ${language}.`,
    "Treat bracketed labels as performance controls. Never speak the labels or pause tags.",
    "Speak only the transcript, exactly once, and add nothing.",
    "",
    "## Scene:",
    "A quiet sound-stage booth. One founder records a considered argument straight to camera.",
    "",
    "## Sample Context:",
    "Premium editorial narration. It opens observant, becomes firmer through the argument,",
    "pulls back briefly, and ends with calm conviction.",
    "",
    "## Transcript:",
    performanceTaggedTranscript(script),
  ].join("\n");
}

export function geminiSimplePrompt(script: BakeoffScript) {
  const language = script.language === "de" ? "German" : "English";
  const accent = script.language === "de" ? "Standard German" : "General American";
  const taggedSections = sectionTexts(script).map((text, index) => {
    if (index === 0) return `[observant] ${text}`;
    if (index === 3) return `[conviction] ${text}`;
    if (index === 6) return `[confident] ${text}`;
    return text;
  });
  return [
    "Read the following transcript based on the audio profile and director's note.",
    "",
    "# Audio Profile",
    "A warm, credible male founder voice. Low-to-mid register, conversational and human.",
    "",
    "# Director's note",
    "Style: Editorial thought leadership. Natural emphasis and subtle variation, never hype.",
    "Pace: Brisk and continuous, with no dead air. Aim for about 75 seconds without sounding rushed.",
    `Accent: ${accent}. Language: ${language}.`,
    "",
    "## Scene:",
    "A founder recording a concise argument in a quiet studio.",
    "",
    "## Transcript:",
    taggedSections.join("\n\n"),
  ].join("\n");
}

export function geminiBalancedPrompt(script: BakeoffScript) {
  const language = script.language === "de" ? "German" : "English";
  const accent = script.language === "de" ? "Standard German" : "General American";
  const taggedSections = sectionTexts(script).map((text, index) => {
    if (index === 0) return `[observant] ${text}`;
    if (index === 3) return `[conviction] ${text}`;
    if (index === 6) return `[confident] ${text}`;
    return text;
  });
  return [
    "Read the following transcript based on the audio profile and director's note.",
    "",
    "# Audio Profile",
    "A warm, credible male founder voice. Low-to-mid register, conversational and human.",
    "",
    "# Director's note",
    "Style: Thought leadership with calm authority. Reflective, clear, and never commercial.",
    "Pace: Measured forward motion. Aim for around 80 seconds; never rush a paragraph transition.",
    "Let the argument breathe, especially after the opening, while avoiding dead air.",
    `Accent: ${accent}. Language: ${language}.`,
    "",
    "## Scene:",
    "A founder sharing a considered argument in a quiet studio.",
    "",
    "## Transcript:",
    taggedSections.join("\n[short pause]\n"),
  ].join("\n");
}

/** The prompt shape used by the current production one-take path, unchanged. */
export function geminiProductionPrompt(script: BakeoffScript) {
  return buildTakePrompt({
    text: plainTranscript(script),
    blocks: script.sections.map((section) => ({
      direction: "",
      lines: section.phrases.map((phrase) => phrase.text),
    })),
    intent: "thought-leadership",
    voiceId: "Achird",
    style: STYLE,
    register: REGISTER,
    arc: arcDirection([...PRODUCTION_ENERGIES]),
    language: script.language,
    outputPath: "",
  });
}

async function geminiProduction(options: GenerateOptions): Promise<ProviderGeneration> {
  const rawPath = path.join(options.outputDir, "raw.wav");
  const result = await renderGeminiPrompt(
    geminiProductionPrompt(options.script), "Achird", rawPath, options.onLog, options.signal,
    {temperature: 1},
  );
  return {
    rawPath,
    model: GEMINI_TTS_MODEL,
    voiceId: "Achird",
    locale: options.language === "de" ? "de-DE" : "en-US",
    requestIds: result.requestId ? [result.requestId] : [],
    parameters: {
      mode: "one-take", promptSchema: "current-production-buildTakePrompt",
      temperature: 1, style: STYLE, register: REGISTER,
    },
  };
}

async function geminiSimple(options: GenerateOptions): Promise<ProviderGeneration> {
  const rawPath = path.join(options.outputDir, "raw.wav");
  const result = await renderGeminiPrompt(
    geminiSimplePrompt(options.script),
    "Achird",
    rawPath,
    options.onLog,
    options.signal,
    {temperature: 1},
  );
  return {
    rawPath,
    model: GEMINI_TTS_MODEL,
    voiceId: "Achird",
    locale: options.language === "de" ? "de-DE" : "en-US",
    requestIds: result.requestId ? [result.requestId] : [],
    parameters: {
      mode: "one-take", promptSchema: "minimal-audio-profile-director-scene-v1",
      performanceTags: ["observant", "conviction", "confident"],
      pauseTags: [], targetDurationSeconds: 75, temperature: 1,
    },
  };
}

async function geminiBalanced(options: GenerateOptions): Promise<ProviderGeneration> {
  const rawPath = path.join(options.outputDir, "raw.wav");
  const result = await renderGeminiPrompt(
    geminiBalancedPrompt(options.script),
    "Achird",
    rawPath,
    options.onLog,
    options.signal,
    {temperature: 1},
  );
  return {
    rawPath,
    model: GEMINI_TTS_MODEL,
    voiceId: "Achird",
    locale: options.language === "de" ? "de-DE" : "en-US",
    requestIds: result.requestId ? [result.requestId] : [],
    parameters: {
      mode: "one-take", promptSchema: "balanced-thought-leadership-v1",
      performanceTags: ["observant", "conviction", "confident"],
      pauseTags: ["short-between-sections"], targetDurationSeconds: 80, temperature: 1,
    },
  };
}

async function geminiDirected(options: GenerateOptions, voiceId: "Achird" | "Algenib"): Promise<ProviderGeneration> {
  const rawPath = path.join(options.outputDir, "raw.wav");
  const result = await renderGeminiPrompt(
    geminiStudioPrompt(options.script),
    voiceId,
    rawPath,
    options.onLog,
    options.signal,
    {temperature: 1},
  );
  return {
    rawPath,
    model: GEMINI_TTS_MODEL,
    voiceId,
    locale: options.language === "de" ? "de-DE" : "en-US",
    requestIds: result.requestId ? [result.requestId] : [],
    parameters: {
      mode: "one-take", promptSchema: "audio-profile-director-scene-context-v1",
      performanceTags: true, pauseTags: ["short", "medium"], temperature: 1,
      style: STYLE, register: REGISTER,
    },
  };
}

async function geminiSections(options: GenerateOptions): Promise<ProviderGeneration> {
  const partDir = path.join(options.outputDir, "raw-sections");
  await fs.mkdir(partDir, {recursive: true});
  const parts: string[] = [];
  const requestIds: string[] = [];
  for (const [index, text] of sectionTexts(options.script).entries()) {
    const outputPath = path.join(partDir, `${String(index + 1).padStart(2, "0")}.wav`);
    const result = await renderGeminiPrompt(buildPrompt({
      text,
      voiceId: "Achird",
      style: STYLE,
      register: REGISTER,
      language: options.language,
      outputPath,
    }), "Achird", outputPath, options.onLog, options.signal);
    parts.push(outputPath);
    if (result.requestId) requestIds.push(result.requestId);
  }
  const rawPath = path.join(options.outputDir, "raw.wav");
  const segments: NarrationSegment[] = parts.map((part, index) => ({
    kind: "clip",
    path: part,
    gapAfterMs: index === parts.length - 1 ? 0 : 650,
  }));
  await assembleNarration(segments, rawPath);
  return {
    rawPath,
    rawParts: parts,
    model: GEMINI_TTS_MODEL,
    voiceId: "Achird",
    locale: options.language === "de" ? "de-DE" : "en-US",
    requestIds,
    parameters: {mode: "seven-section-requests", sectionCount: parts.length, style: STYLE, register: REGISTER},
  };
}

async function googleAccessToken() {
  const supplied = process.env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim();
  if (supplied) return supplied;
  const {stdout} = await run("gcloud", ["auth", "application-default", "print-access-token"])
    .catch(() => ({stdout: ""}));
  if (!stdout.trim()) {
    throw new Error("Chirp needs Google Application Default Credentials or GOOGLE_CLOUD_ACCESS_TOKEN.");
  }
  return stdout.trim();
}

async function chirp(options: GenerateOptions): Promise<ProviderGeneration> {
  const languageCode = options.language === "de" ? "de-DE" : "en-US";
  const voiceId = `${languageCode}-Chirp3-HD-Achird`;
  const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await googleAccessToken()}`,
      "Content-Type": "application/json",
      "x-goog-user-project": process.env.GOOGLE_CLOUD_PROJECT!.trim(),
    },
    body: JSON.stringify({
      input: {ssml: ssmlTranscript(options.script)},
      voice: {languageCode, name: voiceId},
      audioConfig: {
        audioEncoding: "LINEAR16", speakingRate: 0.9, volumeGainDb: -3, sampleRateHertz: 24000,
      },
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Chirp failed: ${response.status} ${(await response.text()).slice(0, 400)}`);
  const body = await response.json() as {audioContent?: string};
  if (!body.audioContent) throw new Error("Chirp returned no audioContent.");
  const rawPath = path.join(options.outputDir, "raw.wav");
  await fs.writeFile(rawPath, Buffer.from(body.audioContent, "base64"));
  return {
    rawPath,
    model: "Chirp3-HD",
    voiceId,
    locale: languageCode,
    requestIds: [response.headers.get("x-request-id")].filter((id): id is string => Boolean(id)),
    parameters: {
      input: "ssml", speakingRate: 0.9, volumeGainDb: -3,
      sampleRateHertz: 24000, audioEncoding: "LINEAR16",
    },
  };
}

async function speechify(options: GenerateOptions, model: "simba-3.2" | "simba-3.0"): Promise<ProviderGeneration> {
  const voiceId = model === "simba-3.2"
    ? process.env.SIMBA_32_VOICE_ID?.trim() || "dominic_32"
    : process.env.SIMBA_30_VOICE_ID?.trim() || "dominic";
  const response = await fetch("https://api.speechify.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SPEECHIFY_API_KEY!.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: plainTranscript(options.script),
      voice_id: voiceId,
      audio_format: "wav",
      model,
      language: options.language === "de" ? "de-DE" : "en-US",
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Speechify ${model} failed: ${response.status} ${(await response.text()).slice(0, 400)}`);
  const rawPath = path.join(options.outputDir, "raw.wav");
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json() as {audio_data?: string; request_id?: string};
    if (!body.audio_data) throw new Error(`Speechify ${model} returned no audio_data.`);
    await fs.writeFile(rawPath, Buffer.from(body.audio_data, "base64"));
    return {
      rawPath,
      model,
      voiceId,
      locale: options.language === "de" ? "de-DE" : "en-US",
      requestIds: body.request_id ? [body.request_id] : [],
      parameters: {input: "plain-text", audioFormat: "wav", language: options.language === "de" ? "de-DE" : "en-US"},
    };
  }
  await fs.writeFile(rawPath, Buffer.from(await response.arrayBuffer()));
  return {
    rawPath,
    model,
    voiceId,
    locale: options.language === "de" ? "de-DE" : "en-US",
    requestIds: [response.headers.get("x-request-id")].filter((id): id is string => Boolean(id)),
    parameters: {input: "plain-text", audioFormat: "wav", language: options.language === "de" ? "de-DE" : "en-US"},
  };
}

async function qwen(options: GenerateOptions): Promise<ProviderGeneration> {
  const apiKey = process.env.DASHSCOPE_API_KEY!.trim();
  const endpoint = process.env.DASHSCOPE_WS_URL?.trim()
    || "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference";
  const voiceId = process.env.QWEN_VOICE_ID?.trim() || "longanlingxi";
  const taskId = randomUUID();
  const mp3Path = path.join(options.outputDir, "raw.mp3");
  const chunks: Buffer[] = [];
  let billedCharacters = 0;

  await websocketRun(endpoint, {Authorization: `bearer ${apiKey}`, "X-DashScope-DataInspection": "enable"}, (ws, done, fail) => {
    ws.on("message", (data, binary) => {
      if (binary) {
        chunks.push(Buffer.from(data as Buffer));
        return;
      }
      const event = JSON.parse(data.toString()) as {
        header?: {event?: string; error_message?: string};
        payload?: {usage?: {characters?: number}};
      };
      if (event.header?.event === "task-started") {
        for (const text of sectionTexts(options.script)) {
          ws.send(JSON.stringify(qwenContinueTask(taskId, text)));
        }
        ws.send(JSON.stringify(qwenFinishTask(taskId)));
      } else if (event.header?.event === "task-finished") {
        billedCharacters = event.payload?.usage?.characters ?? plainTranscript(options.script).length;
        done();
      } else if (event.header?.event === "task-failed") {
        fail(new Error(`Qwen failed: ${event.header.error_message ?? "unknown error"}`));
      }
    });
    ws.send(JSON.stringify(qwenRunTask(taskId, voiceId)));
  }, options.signal);
  if (!chunks.length) throw new Error("Qwen returned no audio frames.");
  await fs.writeFile(mp3Path, Buffer.concat(chunks));
  const rawPath = path.join(options.outputDir, "raw.wav");
  await convertToWav(mp3Path, rawPath);
  return {
    rawPath,
    rawParts: [mp3Path],
    model: "qwen-audio-3.0-tts-plus",
    voiceId,
    locale: "en-US",
    requestIds: [taskId],
    billedCharacters,
    parameters: {
      transport: "one-persistent-websocket-task", sectionInputs: 7, format: "mp3", sampleRate: 22050,
      volume: 50, rate: 1, pitch: 1, instruction: "Natural, restrained, crisp male narration.",
    },
  };
}

async function sonic(options: GenerateOptions): Promise<ProviderGeneration> {
  const apiKey = process.env.CARTESIA_API_KEY!.trim();
  const voiceId = process.env.CARTESIA_VOICE_ID?.trim() || CARTESIA_THEO_VOICE_ID;
  const contextId = randomUUID();
  const endpoint = new URL("wss://api.cartesia.ai/tts/websocket");
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("cartesia_version", "2026-03-01");
  const chunks: Buffer[] = [];

  await websocketRun(endpoint.toString(), {}, (ws, done, fail) => {
    ws.on("message", (data, binary) => {
      if (binary) {
        chunks.push(Buffer.from(data as Buffer));
        return;
      }
      const event = JSON.parse(data.toString()) as {
        type?: string; data?: string; audio?: string; title?: string; message?: string; context_id?: string;
      };
      const encoded = event.data ?? event.audio;
      if (event.type === "chunk" && encoded) chunks.push(Buffer.from(encoded, "base64"));
      else if (event.type === "done") done();
      else if (event.type === "error") fail(new Error(`Cartesia failed: ${event.title ?? "error"}: ${event.message ?? ""}`));
    });
    sonicContinuationRequests(options.script, contextId, voiceId)
      .forEach((request) => ws.send(JSON.stringify(request)));
  }, options.signal);
  if (!chunks.length) throw new Error("Cartesia returned no audio chunks.");
  const pcmPath = path.join(options.outputDir, "raw.f32le");
  await fs.writeFile(pcmPath, Buffer.concat(chunks));
  const rawPath = path.join(options.outputDir, "raw.wav");
  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "f32le", "-ar", "44100", "-ac", "1", "-i", pcmPath,
    "-c:a", "pcm_s16le", rawPath,
  ]);
  return {
    rawPath,
    rawParts: [pcmPath],
    model: "sonic-3.5",
    modelSnapshot: SONIC_SNAPSHOT,
    voiceId,
    locale: options.language,
    requestIds: [contextId],
    billedCharacters: plainTranscript(options.script).length,
    parameters: {
      transport: "one-websocket-context-with-continuations", sectionInputs: 7,
      encoding: "pcm_f32le", sampleRate: 44100, speed: 1, language: options.language,
    },
  };
}

async function sonicHttp(options: GenerateOptions): Promise<ProviderGeneration> {
  const voiceId = process.env.CARTESIA_VOICE_ID?.trim() || CARTESIA_THEO_VOICE_ID;
  const response = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Cartesia-Version": "2026-03-01",
      "X-API-Key": process.env.CARTESIA_API_KEY!.trim(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sonicHttpRequest(options.script, voiceId)),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Cartesia HTTP failed: ${response.status} ${(await response.text()).slice(0, 400)}`);
  }
  const rawPath = path.join(options.outputDir, "raw.wav");
  await fs.writeFile(rawPath, Buffer.from(await response.arrayBuffer()));
  if (await probeDuration(rawPath) <= 0) throw new Error("Cartesia HTTP returned no decodable audio.");
  return {
    rawPath,
    model: "sonic-3.5",
    voiceId,
    locale: options.language,
    requestIds: [response.headers.get("x-request-id")].filter((id): id is string => Boolean(id)),
    billedCharacters: plainTranscript(options.script).length,
    parameters: {
      transport: "one-http-full-take", cartesiaVersion: "2026-03-01",
      container: "wav", encoding: "pcm_s16le", sampleRate: 44100,
      speed: 1, volume: 1, language: options.language,
    },
  };
}

async function sonicKyle(options: GenerateOptions): Promise<ProviderGeneration> {
  const request = sonicKyleRequest(options.script);
  const response = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Cartesia-Version": "2026-03-01",
      "X-API-Key": process.env.CARTESIA_API_KEY!.trim(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Cartesia Kyle failed: ${response.status} ${(await response.text()).slice(0, 400)}`);
  }
  const rawPath = path.join(options.outputDir, "raw.wav");
  await fs.writeFile(rawPath, Buffer.from(await response.arrayBuffer()));
  if (await probeDuration(rawPath) <= 0) throw new Error("Cartesia Kyle returned no decodable audio.");
  return {
    rawPath,
    model: "sonic-3.5",
    modelSnapshot: SONIC_SNAPSHOT,
    voiceId: CARTESIA_KYLE_VOICE_ID,
    locale: options.language,
    requestIds: [response.headers.get("x-request-id")].filter((id): id is string => Boolean(id)),
    billedCharacters: request.transcript.length,
    parameters: {
      transport: "one-http-full-take", cartesiaVersion: "2026-03-01",
      container: "wav", encoding: "pcm_s16le", sampleRate: 44100,
      emotion: "contemplative", sectionBreakMs: 550, sectionBreakCount: 6,
      speedControl: "omitted", volumeControl: "omitted", language: options.language,
    },
  };
}

async function websocketRun(
  url: string,
  headers: Record<string, string>,
  start: (ws: WebSocket, done: () => void, fail: (error: Error) => void) => void,
  signal?: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, {headers});
    const timer = setTimeout(() => finish(new Error("WebSocket synthesis timed out after 180 seconds.")), 180_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error("Narration cancelled."));
    signal?.addEventListener("abort", abort, {once: true});
    ws.once("open", () => start(ws, () => finish(), finish));
    ws.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.once("unexpected-response", (_request, response) => finish(new Error(`WebSocket handshake failed: ${response.statusCode}`)));
  });
}

async function convertToWav(inputPath: string, outputPath: string) {
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", inputPath,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outputPath,
  ]);
  if (await probeDuration(outputPath) <= 0) throw new Error(`Could not decode ${path.basename(inputPath)}.`);
}
