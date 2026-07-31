export const BAKEOFF_LANGUAGES = ["en", "de"] as const;
export type BakeoffLanguage = (typeof BAKEOFF_LANGUAGES)[number];

export interface BakeoffPhrase {
  id: string;
  text: string;
}

export interface BakeoffSection {
  id: string;
  phrases: BakeoffPhrase[];
}

export interface BakeoffScript {
  videoId: string;
  language: BakeoffLanguage;
  sections: BakeoffSection[];
}

export interface ProviderCapability {
  id: string;
  label: string;
  provider: string;
  languages: readonly BakeoffLanguage[];
  model: string;
  modelSnapshot?: string;
  defaultVoiceId?: string;
  requiredEnv: readonly string[];
  /** List-price estimate. The resulting manifest marks it as estimated. */
  pricing: {unit: "characters" | "seconds" | "baseline"; usdPerUnit: number};
  diagnostic?: boolean;
  /** Retained for reproducibility, but omitted from new default runs after rejection. */
  retired?: boolean;
  /** Runnable only when named explicitly; omitted from the standard full matrix. */
  optIn?: boolean;
}

export interface ProviderGeneration {
  rawPath: string;
  model: string;
  modelSnapshot?: string;
  voiceId: string;
  locale: string;
  requestIds: string[];
  billedCharacters?: number;
  rawParts?: string[];
  /** Non-secret request controls needed to reproduce the generation. */
  parameters: Record<string, unknown>;
  repeatabilityComparable?: boolean;
}

export interface AutomaticQuality {
  passed: boolean;
  reasons: string[];
  transcriptWer: number;
  alignmentConfidence: number;
  durationMs: number;
  peakDb: number | null;
  terminalFadeDb: number | null;
  maxControlledGapMs: number;
  pace: {
    language: BakeoffLanguage;
    words: number;
    characters: number;
    totalSeconds: number;
    articulationSeconds: number;
    wordsPerSecond: number;
    articulationWordsPerSecond: number;
  };
}

export interface CandidateRecord {
  id: string;
  candidateId: string;
  candidateLabel: string;
  language: BakeoffLanguage;
  take: number;
  status: "pending" | "skipped" | "failed" | "rejected" | "needs-listening";
  reason?: string;
  rawPath?: string;
  controlledPath?: string;
  listeningPath?: string;
  provider?: string;
  model?: string;
  modelSnapshot?: string;
  voiceId?: string;
  locale?: string;
  requestIds?: string[];
  parameters?: Record<string, unknown>;
  rawParts?: string[];
  costUsd?: number;
  costKind?: "estimated" | "baseline";
  transcriptModel?: string;
  quality?: AutomaticQuality;
  repeatabilityComparable?: boolean;
  timingProvenance?: {
    method: "provider-native-continuous";
    withinSectionGapMs: number;
    betweenSectionGapMs: number;
    slices: Array<{
      sectionId: string;
      phraseId: string;
      sourceStartMs: number;
      sourceDurationMs: number;
      gapAfterMs: number;
    }>;
  };
}

export interface BakeoffManifest {
  schemaVersion: 1;
  videoId: string;
  createdAt: string;
  candidates: CandidateRecord[];
}
