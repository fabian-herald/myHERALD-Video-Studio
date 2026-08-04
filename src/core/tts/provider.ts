export interface TtsVoice {
  id: string;
  label: string;
  /** True when the voice is a clone of a real person rather than a stock voice. */
  cloned: boolean;
  previewUrl?: string;
}

export interface SynthesisRequest {
  text: string;
  voiceId: string;
  /** Free-text delivery direction. Providers that cannot honour it ignore it. */
  style: string;
  /**
   * Who is speaking, held identical across every clip in a video.
   *
   * Separate from `style` because style is allowed to vary by section and this is not.
   * Providers with a fixed speaker embedding can ignore it; generative ones need it,
   * because they decide the speaker afresh on every request.
   */
  register: string;
  language: string;
  /**
   * Fixes which narrator the model produces, where the provider supports it.
   *
   * Stating the register in words narrowed the spread and did not close it — twenty-seven
   * takes still landed across 4.6 semitones. Measured on Gemini, five takes at one seed
   * gave 121, 121, 121, 121, 114 Hz against 138, 127, 113, 138, 123 without. Zero or
   * absent means the provider chooses, as before.
   */
  seed?: number;
  /** Absolute path the provider must write a WAV file to. */
  outputPath: string;
}

/**
 * A whole script read in one go, rather than a phrase read on its own.
 *
 * The reason this exists at all: a generative TTS model decides who is speaking on
 * every request, so sixteen requests for one voice produced sixteen readings spanning
 * an octave, one of them female. Read in one pass it is one performance and the question
 * never arises. What it costs is the free per-phrase timing, which `align.ts` recovers.
 */
export interface TakeRequest extends Omit<SynthesisRequest, "style"> {
  /** Content intent, so a provider can use an approved intent-specific performance profile. */
  intent?: string;
  /** More specific delivery within an intent, such as social promotion or performance ad. */
  profileId?: string;
  /** The brand's narration style, without any per-section direction appended. */
  style: string;
  /** Where the performance opens, turns and lands. See `arcDirection`. */
  arc: string;
  /**
   * The script in the shape the model reads it: one direction per stretch, then the
   * lines that stretch covers. `text` remains the plain script, for hashing and for the
   * fallback path.
   */
  blocks: readonly {direction: string; lines: readonly string[]}[];
}

export interface SynthesisResult {
  outputPath: string;
  durationMs: number;
  /** What the run actually cost, in USD. Local/subscription providers report 0. */
  costUsd: number;
  model: string;
}

/**
 * Every voice backend implements this. Adding ElevenLabs, HeyGen or a future
 * Chirp clone is a new file plus a registry entry — nothing else changes.
 */
export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  readonly supportsCloning: boolean;
  voices(): Promise<TtsVoice[]>;
  synthesize(request: SynthesisRequest, onLog?: (line: string) => void, signal?: AbortSignal): Promise<SynthesisResult>;
  /**
   * Optional: a provider whose speaker is a fixed embedding gains nothing from reading
   * the script in one pass, and narration falls back to a clip per phrase without it.
   */
  synthesizeTake?(request: TakeRequest, onLog?: (line: string) => void, signal?: AbortSignal): Promise<SynthesisResult>;
}

const registry = new Map<string, TtsProvider>();

export function registerTtsProvider(provider: TtsProvider) {
  registry.set(provider.id, provider);
}

export function ttsProvider(id: string): TtsProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new Error(
      `Unknown narration provider "${id}". Registered: ${[...registry.keys()].join(", ") || "none"}.`,
    );
  }
  return provider;
}

export const listTtsProviders = () => [...registry.values()];
