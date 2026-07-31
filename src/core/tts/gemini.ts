import {GoogleGenAI} from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import {languageName} from "../plan/language.ts";
import {exists, probeDuration, run} from "../util/exec.ts";
import {registerTtsProvider, type SynthesisRequest, type SynthesisResult, type TakeRequest, type TtsProvider, type TtsVoice} from "./provider.ts";
import {NARRATION_PROFILES, intentNarrationProfile} from "./intent-profile.ts";
import {
  NARRATION_PROFILE_IDS,
  type NarrationProfileId,
  type VideoPlan,
} from "../plan/schema.ts";

export const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";

/** Prebuilt Gemini voices. None of these are clones — Gemini TTS has no cloning. */
export const GEMINI_VOICES = [
  "Achird", "Achernar", "Algenib", "Alnilam", "Aoede", "Autonoe", "Callirrhoe",
  "Charon", "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus",
  "Kore", "Laomedeia", "Leda", "Orus", "Puck", "Pulcherrima", "Rasalgethi",
  "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel", "Vindemiatrix",
  "Zephyr", "Zubenelgenubi",
] as const;

const PCM_SAMPLE_RATE = 24_000;

/**
 * Directions first, transcript last and fenced.
 *
 * The fence is not decoration. A delivery direction written as prose has been read
 * aloud before now, turning an eight-word line into 17.6 seconds of audio, so the
 * boundary between "how to say it" and "what to say" has to be unmistakable. Everything
 * outside the fence is a setting; only what is inside is spoken.
 *
 * The register line is the other half. Each request carries one sentence and no other
 * context, and the model decides who is speaking from that alone — measured across one
 * script it produced readings from 104 to 200 Hz under an identical prompt. Naming the
 * register cut the spread from 10.6 semitones to 7.3 and the ceiling from 205 Hz to
 * 145. Handing it the whole script as context scored better still, right up until the
 * durations showed why: it was reading the context aloud, 43 seconds for a seven-word
 * line.
 */
export function buildPrompt(request: SynthesisRequest): string {
  const style = request.style.trim().replace(/\s+/g, " ") || "Natural, unhurried, credible.";
  const register = request.register.trim().replace(/\s+/g, " ");
  return [
    "Read the fenced transcript below as audio.",
    `Language: ${languageName(request.language)}.`,
    `Voice profile: ${style}`,
    // The invariance claim lives here rather than in the brand kit: the kit describes
    // the narrator, this says the narrator is the same one as in every other clip.
    ...(register ? [
      `Speaker: ${register}`,
      "The same speaker reads every line of this piece, so the register does not change",
      "from line to line.",
    ] : []),
    "Speak at a natural pace. Do not rush and do not pad.",
    "Everything above is a setting, not words to say. Speak only what is between the",
    "fences, exactly once, and add nothing.",
    "",
    "<<<TRANSCRIPT",
    request.text.trim(),
    "TRANSCRIPT",
  ].join("\n");
}

/**
 * The whole script, directed as one performance.
 *
 * The transcript block follows the form the model's own playground emits, because that
 * form demonstrably works and the forms invented here did not. What carries it is the
 * `## Transcript:` header and directions written as plain instructions ending in a colon
 * on the line above what they govern. Quoting the spoken lines was tried and is not
 * needed — the same script reads identically without it — so it is not done.
 *
 * That form is also what restores the energy curve. Bracket labels on individual lines
 * were inaudible, which is why an arc for the whole performance was tried instead; here
 * a direction per section is heard, so the curve is stated where it applies and the arc
 * only has to set the overall frame.
 *
 * Nothing here asks for speed. Asking for quicker measured 1.77 words per second against
 * 2.33 for asking nothing, and "momentum over polish" took a take from 52.8 seconds to
 * 59.7. Slow is the one direction that works, so only `quiet` uses it. Pace is checked
 * on the result instead — see `tooSlow` in narrate.ts.
 */
export function buildTakePrompt(request: TakeRequest): string {
  // Every current video intent has its own performance profile. The generic prompt stays
  // only for older callers that do not yet provide intent provenance.
  const intent = request.intent as VideoPlan["intent"] | undefined;
  const requestedProfile = NARRATION_PROFILE_IDS.includes(request.profileId as NarrationProfileId)
    ? request.profileId as NarrationProfileId
    : undefined;
  if (intent) return buildIntentTakePrompt(request, intent, requestedProfile);

  const style = request.style.trim().replace(/\s+/g, " ") || "Natural, unhurried, credible.";
  const register = request.register.trim().replace(/\s+/g, " ");
  const arc = request.arc.trim().replace(/\s+/g, " ");

  const transcript: string[] = [];
  for (const block of request.blocks) {
    if (block.direction) transcript.push(`${block.direction}:`);
    for (const line of block.lines) transcript.push(line.trim());
  }

  return [
    "Scene: a quiet studio, one narrator recording a short piece straight to camera.",
    `Language: ${languageName(request.language)}.`,
    "Director's notes:",
    style,
    ...(register ? [`He is ${register}, and it is the same man from the first line to the last.`] : []),
    "He is arguing something he believes to someone whose judgement he respects. He is",
    "thinking forward, not reading aloud. Conviction, never enthusiasm: no announcing,",
    "no selling.",
    ...(arc ? [arc] : []),
    "",
    "## Transcript:",
    ...transcript,
  ].join("\n");
}

/** The listener-approved thought-leadership profile, retained as a named entry point. */
export function buildThoughtLeadershipTakePrompt(request: TakeRequest): string {
  return buildIntentTakePrompt(request, "thought-leadership");
}

export function buildIntentTakePrompt(
  request: TakeRequest,
  intent: VideoPlan["intent"],
  profileId?: NarrationProfileId,
): string {
  const profile = intentNarrationProfile(intent, profileId);
  const style = request.style.trim().replace(/\s+/g, " ")
    || "Warm, credible, founder-to-founder. Conversational and restrained.";
  const register = request.register.trim().replace(/\s+/g, " ");
  const wordCount = request.text.trim().split(/\s+/).filter(Boolean).length;
  const targetSeconds = Math.max(10, Math.round((wordCount / profile.promptTargetWps) / 5) * 5);
  const middle = Math.floor(request.blocks.length / 2);
  const transcript = request.blocks.map((block, index) => {
    const tag = index === 0
      ? `[${profile.tags[0]}]`
      : index === request.blocks.length - 1
        ? `[${profile.tags[2]}]`
        : index === middle
          ? `[${profile.tags[1]}]`
          : "";
    return [tag, ...block.lines.map((line) => line.trim())].filter(Boolean).join(" ");
  }).join("\n[short pause]\n");

  return [
    "Read the following transcript based on the audio profile and director's note.",
    "",
    "# Audio Profile",
    style,
    ...(register ? [`Speaker: ${register}. The same man speaks from the first word to the last.`] : []),
    "",
    "# Director's note",
    profile.style,
    profile.pace(targetSeconds),
    profile.transition,
    `Language: ${languageName(request.language)}.`,
    "",
    "## Scene:",
    profile.scene,
    "",
    "## Transcript:",
    transcript,
  ].join("\n");
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Narration cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Narration cancelled."));
    }, {once: true});
  });

/** Honour the quota backoff Gemini reports rather than guessing. */
function retryDelay(error: unknown, attempt: number) {
  const reported = String(error).match(/retry in ([\d.]+)s/i);
  return reported?.[1] ? Math.ceil((Number(reported[1]) + 1) * 1000) : attempt * 1500;
}

export interface GeminiPromptResult extends SynthesisResult {
  /** Provider request identifier when the SDK exposes one. */
  requestId?: string;
}

async function synthesizePcm(
  prompt: string,
  voiceId: string,
  onLog?: (line: string) => void,
  signal?: AbortSignal,
  temperature?: number,
): Promise<{audio: Buffer; requestId?: string}> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env.local.");

  const client = new GoogleGenAI({apiKey});
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal?.aborted) throw new Error("Narration cancelled.");
    try {
      const response = await client.models.generateContent({
        model: GEMINI_TTS_MODEL,
        contents: [{parts: [{text: prompt}]}],
        config: {
          ...(temperature === undefined ? {} : {temperature}),
          responseModalities: ["AUDIO"],
          speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: voiceId}}},
        },
      });
      const encoded = response.candidates?.[0]?.content?.parts
        ?.find((part) => part.inlineData?.data)?.inlineData?.data;
      if (!encoded) throw new Error("Gemini returned no audio bytes.");
      const metadata = response as unknown as {responseId?: string};
      return {audio: Buffer.from(encoded, "base64"), requestId: metadata.responseId};
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      const delay = retryDelay(error, attempt);
      onLog?.(`Gemini quota busy; retrying in ${(delay / 1000).toFixed(1)}s (${attempt}/4).`);
      await wait(delay, signal);
    }
  }
  throw lastError;
}

export const geminiTts: TtsProvider = {
  id: "gemini",
  label: "Google Gemini TTS",
  supportsCloning: false,

  async voices(): Promise<TtsVoice[]> {
    return GEMINI_VOICES.map((id) => ({id, label: id, cloned: false}));
  },

  async synthesizeTake(request, onLog, signal): Promise<SynthesisResult> {
    return renderGeminiPrompt(
      buildTakePrompt(request),
      request.voiceId,
      request.outputPath,
      onLog,
      signal,
      request.intent && (request.profileId ? request.profileId in NARRATION_PROFILES : true)
        ? {temperature: 1}
        : {},
    );
  },

  async synthesize(request, onLog, signal): Promise<SynthesisResult> {
    return renderGeminiPrompt(buildPrompt(request), request.voiceId, request.outputPath, onLog, signal);
  },
};

/** One prompt to one WAV, cached by path. The two entry points differ only in the prompt. */
export async function renderGeminiPrompt(
  prompt: string,
  voiceId: string,
  outputPath: string,
  onLog?: (line: string) => void,
  signal?: AbortSignal,
  options: {temperature?: number} = {},
): Promise<GeminiPromptResult> {
  const result = async (requestId?: string) => ({
    outputPath,
    durationMs: Math.round(await probeDuration(outputPath) * 1000),
    // Gemini TTS is billed by generated audio tokens. The bake-off replaces this
    // placeholder with its duration-based list-price estimate in its provenance.
    costUsd: 0,
    model: GEMINI_TTS_MODEL,
    requestId,
  });
  if (await exists(outputPath)) return result();

  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const pcmPath = `${outputPath}.pcm`;
  const generated = await synthesizePcm(prompt, voiceId, onLog, signal, options.temperature);
  await fs.writeFile(pcmPath, generated.audio);
  await run("ffmpeg", [
    "-y",
    "-f", "s16le", "-ar", String(PCM_SAMPLE_RATE), "-ac", "1",
    "-i", pcmPath,
    "-c:a", "pcm_s16le",
    outputPath,
  ]);
  await fs.rm(pcmPath, {force: true});
  return result(generated.requestId);
}

registerTtsProvider(geminiTts);
