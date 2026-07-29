import path from "node:path";
import {assembleNarration, masterNarration, AUDIO_MASTERING_VERSION, type NarrationSegment} from "../audio/master.ts";
import {retimeFromTake, retimePlan, SILENT_SECTION_MIN_MS, type MeasuredPhrase} from "../plan/retime.ts";
import {allPhrases, type VideoPlan} from "../plan/schema.ts";
import {alignPhrases, verifyAlignment} from "./align.ts";
import {arcDirection, deliveryFor, SAY_DIRECTION} from "./energy.ts";
import {centreHz, closestToCentre, medianF0, pitchOutlier, semitones} from "./pitch.ts";
import {implausibleClip} from "./plausible.ts";
import {ttsProvider, type SynthesisRequest, type TtsProvider} from "./provider.ts";
import {transcribeWords, transcriptionCostUsd} from "./transcribe.ts";
import {hash, mapLimit} from "../util/exec.ts";

/** Gemini's free tier throttles hard above this; higher concurrency just triggers backoff. */
const TTS_CONCURRENCY = 2;

/**
 * How many more times to ask for a phrase that came back in the wrong voice.
 *
 * Two. The drift is random, so most outliers land in range on the first retry; a phrase
 * that misses three times in a row is usually systematically low rather than unlucky —
 * one line in the test set came back at 111, 108 and 107 Hz against a 138 Hz track — and
 * asking a fourth time buys nothing.
 */
const PITCH_RETRIES = 2;

export interface NarrationResult {
  /** Plan with every timestamp rebuilt from the audio that was actually produced. */
  plan: VideoPlan;
  /** Mastered, continuous narration track (AAC, −16 LUFS). */
  masterPath: string;
  durationMs: number;
  costUsd: number;
  model: string;
  clipCount: number;
  cachedCount: number;
}

interface Clip {
  sectionId: string;
  phraseId: string;
  durationMs: number;
  path: string;
  gapAfterMs: number;
  text: string;
  request: SynthesisRequest;
}

/**
 * Make every clip sound like the same person, by asking again where it does not.
 *
 * Runs after all the clips exist, because the target is the track's own median and
 * there is no way to know that before hearing the whole thing. Mutates `clips` in place
 * so the caller keeps measuring the files it will actually assemble — a re-rolled clip
 * has a different duration, and the plan is retimed from these numbers.
 *
 * A phrase that will not come back in range is left alone and reported. The alternative
 * was pitch-shifting it into the middle, which measured beautifully and sounded broken.
 */
async function holdOneVoice(
  clips: Clip[],
  provider: ReturnType<typeof ttsProvider>,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const pitches = await mapLimit(clips, 4, (clip) => medianF0(clip.path));
  const centre = centreHz(pitches);
  if (centre === null) return 0;

  let costUsd = 0;
  let rerolled = 0;
  let stubborn = 0;

  for (const [index, clip] of clips.entries()) {
    const outlier = pitchOutlier(pitches[index] ?? null, centre);
    if (!outlier) continue;

    const attempts: {path: string; durationMs: number; pitch: number | null}[] = [
      {path: clip.path, durationMs: clip.durationMs, pitch: pitches[index] ?? null},
    ];
    for (let take = 2; take <= PITCH_RETRIES + 1; take++) {
      // A distinct path per attempt, or the provider's own cache returns the take we
      // are trying to replace.
      const result = await provider.synthesize(
        {...clip.request, outputPath: clip.request.outputPath.replace(/\.wav$/, `-take${take}.wav`)},
        onLog,
        signal,
      );
      costUsd += result.costUsd;
      // A retry is still speech that has to match its own line; a runaway one is worse
      // than the wrong pitch, so it never becomes a candidate.
      if (implausibleClip(clip.text, result.durationMs)) continue;
      const pitch = await medianF0(result.outputPath);
      attempts.push({path: result.outputPath, durationMs: result.durationMs, pitch});
      if (!pitchOutlier(pitch, centre)) break;
    }

    // `attempts` always holds the original take, so there is always something to pick.
    const best = attempts[closestToCentre(attempts, centre)] ?? attempts[0]!;
    if (best.path !== clip.path) {
      clip.path = best.path;
      clip.durationMs = best.durationMs;
      rerolled += 1;
    }
    if (pitchOutlier(best.pitch, centre)) {
      stubborn += 1;
      onLog(
        `narration    ${clip.sectionId}/${clip.phraseId} stays ${outlier.st > 0 ? "sharp" : "flat"} `
        + `at ${best.pitch?.toFixed(0) ?? "?"} Hz against ${centre.toFixed(0)} Hz after `
        + `${PITCH_RETRIES} retries; shipping it rather than pitch-shifting it`,
      );
    }
  }

  if (rerolled || stubborn) {
    onLog(
      `narration    voice held at ${centre.toFixed(0)} Hz · ${rerolled} re-rolled`
      + `${stubborn ? ` · ${stubborn} still off` : ""}`,
    );
  }
  return costUsd;
}

/**
 * Synthesise one clip per phrase, measure each, then rebuild the plan's timing
 * from those measurements. Nothing downstream ever guesses a duration again.
 */
export async function narrate(
  plan: VideoPlan,
  workDir: string,
  onLog: (line: string) => void = () => {},
  signal?: AbortSignal,
): Promise<NarrationResult> {
  const provider = ttsProvider(plan.narration.provider);
  if (!allPhrases(plan).length) throw new Error("The plan contains no spoken phrases.");

  // One take is the preferred path and a clip per phrase is the fallback, which is the
  // reverse of how this started. A generative model decides who is speaking on every
  // request, so sixteen requests gave sixteen readings across an octave and one of them
  // was a woman; read in one pass it is one performance and the question cannot arise.
  // The fallback stays because the take has to be located before it can be used, and an
  // alignment that cannot be verified must not become a video.
  if (provider.synthesizeTake) {
    try {
      const take = await narrateAsTake(plan, workDir, provider, onLog, signal);
      if (take) return take;
    } catch (error) {
      if (signal?.aborted) throw error;
      onLog(`narration    one-take path failed: ${String(error).slice(0, 160)}`);
    }
    onLog("narration    falling back to a clip per phrase");
  }
  return narrateAsClips(plan, workDir, onLog, signal);
}

/**
 * The whole script in one request, then located inside the result.
 *
 * Returns nothing when the take cannot be trusted — wrong register after a retry, or an
 * alignment that does not verify — so the caller falls back rather than shipping a video
 * whose captions drift a little further with every scene.
 */
async function narrateAsTake(
  plan: VideoPlan,
  workDir: string,
  provider: TtsProvider,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<NarrationResult | null> {
  const entries = allPhrases(plan);
  const script = entries.map(({phrase}) => phrase.text).join("\n");
  // Only sections that are spoken shape the arc. A wordless signature card carries an
  // energy like any other section, and left in it decides how the piece lands — which
  // sent one take out on "level and plain" when the last thing actually said was a lift.
  const arc = arcDirection(
    plan.sections.filter((section) => section.phrases.length).map((section) => section.energy),
  );
  // One block per section, so a direction is stated exactly where the energy changes
  // rather than once for the whole piece or once per line.
  const blocks = plan.sections
    .filter((section) => section.phrases.length)
    .map((section) => ({
      direction: SAY_DIRECTION[section.energy],
      lines: section.phrases.map((phrase) => phrase.text),
    }));

  const request = {
    text: script,
    blocks,
    voiceId: plan.narration.voice,
    style: plan.narration.style,
    register: plan.narration.register,
    arc,
    language: plan.language,
    outputPath: "",
  };

  let costUsd = 0;
  let take: {outputPath: string; durationMs: number; model: string} | null = null;

  // Two attempts. The second exists because the whole take can come back in the wrong
  // voice, which is the one failure that survives reading the script in a single pass,
  // and because the pace varies by roughly 15% between identical requests. A third buys
  // little: this is a lottery rather than a correction, so the odds do not improve.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const key = hash({...request, outputPath: undefined, attempt, mastering: AUDIO_MASTERING_VERSION});
    const outputPath = path.join(workDir, "narration", `take-${key}.wav`);
    const result = await provider.synthesizeTake!({...request, outputPath}, onLog, signal);
    costUsd += result.costUsd;

    const off = await registerMiss(result.outputPath, plan.narration.register);
    const slow = tooSlow(script, result.durationMs);
    if (!off && !slow) {
      take = result;
      break;
    }
    // Wrong voice disqualifies a take outright. Merely slow does not — it stays as a
    // candidate, because a slow take in the right voice still beats no take at all.
    if (!off && (!take || result.durationMs < take.durationMs)) take = result;

    onLog(
      `narration    take came back ${off
        ? `at ${off.hz.toFixed(0)} Hz against the brand's ${off.targetHz.toFixed(0)} Hz`
        : `at ${slow!.wordsPerSecond.toFixed(2)} words per second`}`
      + `${attempt === 1 ? "; asking again" : ""}`,
    );
  }
  if (!take) return null;

  const {words, billedSeconds, model: asrModel} = await transcribeWords(
    take.outputPath, plan.language, path.join(workDir, "narration"), onLog, signal,
  );
  costUsd += transcriptionCostUsd(billedSeconds);

  const aligned = alignPhrases(words, entries.map(({section, phrase}) => ({
    sectionId: section.id, phraseId: phrase.id, text: phrase.text,
  })));
  const verdict = verifyAlignment(aligned, take.durationMs);
  if (!verdict.ok) {
    for (const reason of verdict.reasons.slice(0, 3)) onLog(`narration    ${reason}`);
    return null;
  }

  const masterPath = path.join(workDir, `narration-${AUDIO_MASTERING_VERSION}.m4a`);
  const durationSeconds = await masterNarration(take.outputPath, masterPath);
  onLog(
    `narration    one take · ${entries.length} phrases located · ${provider.label} · `
    + `${plan.narration.voice} · ${asrModel}`,
  );

  return {
    plan: retimeFromTake(plan, aligned),
    masterPath,
    durationMs: Math.round(durationSeconds * 1000),
    costUsd,
    model: take.model,
    clipCount: 1,
    cachedCount: 0,
  };
}

/**
 * Words per second below which a listener called the reading not engaging.
 *
 * Measured, not chosen. The take a listener picked ran 2.33 words per second; the ones
 * called slow ran 1.77 and 1.59. The floor sits just under the good one because the same
 * prompt varies by about 15% between requests, and a threshold above that variance would
 * reject good takes as often as bad ones.
 */
const SLOWEST_ENGAGING_WPS = 2.0;

/**
 * Is this take slow enough to be worth asking again?
 *
 * Checked rather than instructed, because instructing it does not work. Asking for a
 * quicker read produced 1.77 words per second against 2.33 for asking nothing at all,
 * and adding "momentum over polish" took a take from 52.8 seconds to 59.7. Every attempt
 * to steer the pace from inside the prompt has made it slower.
 */
function tooSlow(script: string, durationMs: number): {wordsPerSecond: number} | null {
  if (durationMs <= 0) return null;
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  const wordsPerSecond = words / (durationMs / 1000);
  return wordsPerSecond < SLOWEST_ENGAGING_WPS ? {wordsPerSecond} : null;
}

/**
 * Did the take come back as the narrator the brand describes?
 *
 * The target is read out of the register text, which already says something like "around
 * 140 hertz". Written down once by a person, it is a better anchor than anything that
 * could be inferred at runtime — and when no figure is stated there is nothing to check
 * against, so nothing is checked rather than a number being invented.
 */
async function registerMiss(
  file: string,
  register: string,
): Promise<{hz: number; targetHz: number} | null> {
  const stated = register.match(/(\d{2,3})\s*(?:hz|hertz)/i)?.[1];
  if (!stated) return null;
  const targetHz = Number(stated);
  const hz = await medianF0(file);
  // Five semitones is wide on purpose. The point is to catch a take that reads as a
  // different person, not to police a narrator who happened to sit low that day.
  if (hz === null || Math.abs(semitones(targetHz, hz)) <= 5) return null;
  return {hz, targetHz};
}

/** One clip per phrase: the original arrangement, kept for when a take cannot be located. */
async function narrateAsClips(
  plan: VideoPlan,
  workDir: string,
  onLog: (line: string) => void = () => {},
  signal?: AbortSignal,
): Promise<NarrationResult> {
  const provider = ttsProvider(plan.narration.provider);
  const clipDir = path.join(workDir, "narration");
  const entries = allPhrases(plan);

  let cachedCount = 0;
  let costUsd = 0;
  let model = provider.id;

  const clips = await mapLimit(entries, TTS_CONCURRENCY, async ({section, phrase}) => {
    // Delivery varies per section, so it has to be part of the cache key: the same
    // sentence read quiet and read with a lift are two different clips.
    const style = deliveryFor(plan.narration.style, section.energy);
    const cacheKey = hash({
      provider: provider.id,
      voice: plan.narration.voice,
      style,
      // In the key because it changes the audio: edit the brand's narrator and every
      // clip has to be re-synthesised, not served from the take that predates the edit.
      register: plan.narration.register,
      language: plan.language,
      text: phrase.text,
      mastering: AUDIO_MASTERING_VERSION,
    });
    const outputPath = path.join(clipDir, `${section.id}-${phrase.id}-${cacheKey}.wav`);

    const before = Date.now();
    let result = await provider.synthesize(
      {
        text: phrase.text,
        voiceId: plan.narration.voice,
        style,
        register: plan.narration.register,
        language: plan.language,
        outputPath,
      },
      onLog,
      signal,
    );
    // A sub-50ms turnaround can only be a cache hit, not a network round-trip.
    if (Date.now() - before < 50) cachedCount += 1;
    costUsd += result.costUsd;

    // A clip far longer than its words allow contains speech nobody asked for —
    // almost always the delivery direction, read aloud. Retry once with the brand
    // voice alone, which removes the only thing that could have been mistaken for
    // transcript, and refuse to ship the video if that does not fix it.
    let overrun = implausibleClip(phrase.text, result.durationMs);
    if (overrun) {
      onLog(
        `narration    ${section.id}/${phrase.id} ran ${(overrun.measuredMs / 1000).toFixed(1)}s for `
        + `${overrun.words} words; retrying without the delivery direction`,
      );
      result = await provider.synthesize(
        {
          text: phrase.text,
          voiceId: plan.narration.voice,
          style: plan.narration.style,
          // The register stays even here. What is dropped is the per-section direction,
          // which is the only thing long enough to be mistaken for more transcript.
          register: plan.narration.register,
          language: plan.language,
          outputPath: outputPath.replace(/\.wav$/, "-plain.wav"),
        },
        onLog,
        signal,
      );
      costUsd += result.costUsd;
      overrun = implausibleClip(phrase.text, result.durationMs);
      if (overrun) {
        throw new Error(
          `Narration for ${section.id}/${phrase.id} is ${(overrun.measuredMs / 1000).toFixed(1)}s long `
          + `for ${overrun.words} words, about ${overrun.extraWords} words more than the line contains. `
          + "The voice is saying something that is not in the script; shipping it would put that in the video.",
        );
      }
    }

    model = result.model;
    if (!result.durationMs) {
      throw new Error(`Narration for ${section.id}/${phrase.id} produced no audible audio.`);
    }
    return {
      sectionId: section.id,
      phraseId: phrase.id,
      durationMs: result.durationMs,
      path: result.outputPath,
      gapAfterMs: phrase.gapAfterMs,
      text: phrase.text,
      request: {
        text: phrase.text,
        voiceId: plan.narration.voice,
        style,
        register: plan.narration.register,
        language: plan.language,
        outputPath,
      } satisfies SynthesisRequest,
    };
  });

  onLog(
    `narration    ${clips.length} phrases · ${provider.label} · ${plan.narration.voice}`
    + `${cachedCount ? ` · ${cachedCount} cached` : ""}`,
  );

  costUsd += await holdOneVoice(clips, provider, onLog, signal);

  const measured: MeasuredPhrase[] = clips.map(({sectionId, phraseId, durationMs}) =>
    ({sectionId, phraseId, durationMs}));
  const retimed = retimePlan(plan, measured);

  // Walk the plan, not the clip list, so a wordless section becomes real silence in
  // the right place instead of quietly shortening the track.
  const byPhrase = new Map(clips.map((clip) => [`${clip.sectionId}/${clip.phraseId}`, clip]));
  const segments: NarrationSegment[] = [];
  for (const section of retimed.sections) {
    if (!section.phrases.length) {
      segments.push({kind: "silence", durationMs: section.durationMs || SILENT_SECTION_MIN_MS});
      continue;
    }
    for (const phrase of section.phrases) {
      const clip = byPhrase.get(`${section.id}/${phrase.id}`);
      if (!clip) throw new Error(`Missing narration clip for ${section.id}/${phrase.id}.`);
      segments.push({kind: "clip", path: clip.path, gapAfterMs: phrase.gapAfterMs});
    }
  }

  const rawPath = path.join(workDir, "narration-raw.wav");
  await assembleNarration(segments, rawPath);

  const masterPath = path.join(workDir, `narration-${AUDIO_MASTERING_VERSION}.m4a`);
  const durationSeconds = await masterNarration(rawPath, masterPath);

  return {
    plan: retimed,
    masterPath,
    durationMs: Math.round(durationSeconds * 1000),
    costUsd,
    model,
    clipCount: clips.length,
    cachedCount,
  };
}
