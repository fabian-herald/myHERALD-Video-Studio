import type {BakeoffLanguage, ProviderCapability} from "./types.ts";

export const SONIC_SNAPSHOT = "sonic-3.5-2026-05-04";
export const CARTESIA_THEO_VOICE_ID = "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e";
export const CARTESIA_KYLE_VOICE_ID = "c961b81c-a935-4c17-bfb3-ba2239de8c2f";

/**
 * Capability declarations are the gate in front of every provider call.
 * Adding a locale to a prompt without adding it here cannot accidentally reach an API.
 */
export const BAKEOFF_CANDIDATES: readonly ProviderCapability[] = [
  {
    id: "existing-shortened",
    label: "Rejected take, silence shortened",
    provider: "existing",
    languages: ["en"],
    model: "existing-gemini-take",
    requiredEnv: [],
    pricing: {unit: "baseline", usdPerUnit: 0},
  },
  {
    id: "gemini-pause-tags",
    label: "Gemini directed full take — Achird",
    provider: "gemini",
    languages: ["en", "de"],
    model: "gemini-3.1-flash-tts-preview",
    defaultVoiceId: "Achird",
    requiredEnv: ["GEMINI_API_KEY"],
    pricing: {unit: "seconds", usdPerUnit: 0.0005},
  },
  {
    id: "gemini-production-prompt-achird",
    label: "Gemini current production prompt — Achird",
    provider: "gemini",
    languages: ["en", "de"],
    model: "gemini-3.1-flash-tts-preview",
    defaultVoiceId: "Achird",
    requiredEnv: ["GEMINI_API_KEY"],
    pricing: {unit: "seconds", usdPerUnit: 0.0005},
    optIn: true,
  },
  {
    id: "gemini-simple-directed-achird",
    label: "Gemini simplified directed full take — Achird",
    provider: "gemini",
    languages: ["en", "de"],
    model: "gemini-3.1-flash-tts-preview",
    defaultVoiceId: "Achird",
    requiredEnv: ["GEMINI_API_KEY"],
    pricing: {unit: "seconds", usdPerUnit: 0.0005},
    optIn: true,
  },
  {
    id: "gemini-balanced-thought-leadership-achird",
    label: "Gemini balanced thought-leadership take — Achird",
    provider: "gemini",
    languages: ["en", "de"],
    model: "gemini-3.1-flash-tts-preview",
    defaultVoiceId: "Achird",
    requiredEnv: ["GEMINI_API_KEY"],
    pricing: {unit: "seconds", usdPerUnit: 0.0005},
    optIn: true,
  },
  {
    id: "gemini-directed-algenib",
    label: "Gemini directed full take — Algenib",
    provider: "gemini",
    languages: ["en", "de"],
    model: "gemini-3.1-flash-tts-preview",
    defaultVoiceId: "Algenib",
    requiredEnv: ["GEMINI_API_KEY"],
    pricing: {unit: "seconds", usdPerUnit: 0.0005},
  },
  {
    id: "gemini-seven-sections",
    label: "Gemini seven sections, fixed profile",
    provider: "gemini",
    languages: ["en", "de"],
    model: "gemini-3.1-flash-tts-preview",
    defaultVoiceId: "Achird",
    requiredEnv: ["GEMINI_API_KEY"],
    pricing: {unit: "seconds", usdPerUnit: 0.0005},
  },
  {
    id: "chirp-achird",
    label: "Chirp 3 HD Achird",
    provider: "google-cloud-tts",
    languages: ["en", "de"],
    model: "Chirp3-HD",
    defaultVoiceId: "Achird",
    requiredEnv: ["GOOGLE_CLOUD_PROJECT"],
    pricing: {unit: "characters", usdPerUnit: 0.00003},
    retired: true,
  },
  {
    id: "simba-3.2",
    label: "Simba 3.2",
    provider: "speechify",
    languages: ["en"],
    model: "simba-3.2",
    defaultVoiceId: "dominic_32",
    requiredEnv: ["SPEECHIFY_API_KEY"],
    pricing: {unit: "characters", usdPerUnit: 0.00001},
  },
  {
    id: "qwen-plus",
    label: "Qwen-Audio 3.0 Plus",
    provider: "dashscope",
    languages: ["en"],
    model: "qwen-audio-3.0-tts-plus",
    defaultVoiceId: "longanlingxi",
    requiredEnv: ["DASHSCOPE_API_KEY"],
    pricing: {unit: "characters", usdPerUnit: 0.00002},
  },
  {
    id: "sonic-3.5",
    label: "Cartesia Sonic 3.5",
    provider: "cartesia",
    languages: ["en", "de"],
    model: "sonic-3.5",
    modelSnapshot: SONIC_SNAPSHOT,
    defaultVoiceId: CARTESIA_THEO_VOICE_ID,
    requiredEnv: ["CARTESIA_API_KEY"],
    pricing: {unit: "characters", usdPerUnit: 0.00005},
    retired: true,
  },
  {
    id: "sonic-3.5-http-default",
    label: "Cartesia Sonic 3.5 — default HTTP full take",
    provider: "cartesia",
    languages: ["en", "de"],
    model: "sonic-3.5",
    defaultVoiceId: CARTESIA_THEO_VOICE_ID,
    requiredEnv: ["CARTESIA_API_KEY"],
    pricing: {unit: "characters", usdPerUnit: 0.00005},
    optIn: true,
    retired: true,
  },
  {
    id: "sonic-3.5-kyle-contemplative",
    label: "Cartesia Sonic 3.5 — Kyle contemplative",
    provider: "cartesia",
    languages: ["en", "de"],
    model: "sonic-3.5",
    modelSnapshot: SONIC_SNAPSHOT,
    defaultVoiceId: CARTESIA_KYLE_VOICE_ID,
    requiredEnv: ["CARTESIA_API_KEY"],
    pricing: {unit: "characters", usdPerUnit: 0.00005},
    optIn: true,
    retired: true,
  },
  {
    id: "simba-3.0-de-diagnostic",
    label: "Simba 3.0 German diagnostic",
    provider: "speechify",
    languages: ["de"],
    model: "simba-3.0",
    defaultVoiceId: "dominic",
    requiredEnv: ["SPEECHIFY_API_KEY"],
    pricing: {unit: "characters", usdPerUnit: 0.00001},
    diagnostic: true,
  },
] as const;

export function candidate(id: string) {
  const found = BAKEOFF_CANDIDATES.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown bake-off candidate "${id}".`);
  return found;
}

export function assertCandidateLanguage(id: string, language: BakeoffLanguage) {
  const found = candidate(id);
  if (!found.languages.includes(language)) {
    throw new Error(`${found.label} does not support ${language}; no API request was made.`);
  }
  return found;
}

export function missingCredentials(item: ProviderCapability) {
  return item.requiredEnv.filter((name) => !process.env[name]?.trim());
}

export function estimateCost(
  item: ProviderCapability,
  characters: number,
  durationSeconds: number,
) {
  if (item.pricing.unit === "baseline") return 0;
  const units = item.pricing.unit === "characters" ? characters : durationSeconds;
  return units * item.pricing.usdPerUnit;
}
