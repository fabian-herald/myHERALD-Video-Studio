import type {ContentLanguage} from "../core/plan/language.ts";

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  at: string;
  tool?: string;
}

export interface Thread {
  id: string;
  kind: "studio" | "video";
  title: string;
  videoId?: string;
  updatedAt: string;
  messages: ThreadMessage[];
}

export interface LedgerEntry {
  id: string;
  title: string;
  thesis: string;
  intent: string;
  formats: string[];
  createdAt: string;
  status: string;
  outputs: {format: string; path: string}[];
}

export interface PlanPhrase {
  id: string;
  text: string;
  startMs: number;
  durationMs: number;
  gapAfterMs: number;
}

export type Energy = "quiet" | "settled" | "lift" | "edge";

export interface PlanEditPayload {
  sectionId: string;
  onScreen?: string;
  energy?: Energy;
  setPhrases?: {id?: string; text: string; gapAfterMs?: number}[];
  trailingGapMs?: number;
  remove?: boolean;
}

export interface PlanSection {
  id: string;
  kind: string;
  intentNote: string;
  energy: Energy;
  onScreen: string;
  startMs: number;
  durationMs: number;
  phrases: PlanPhrase[];
  mediaId?: string;
  screen?: {
    mediaId: string;
    fit: "contain" | "device-frame" | "browser-chrome";
    focus: {atMs: number; rect: [number, number, number, number]; label: string}[];
  };
  data?: {
    shape: "bars" | "line" | "counter" | "share";
    unit: string;
    caption: string;
    points: {label: string; value: number; factId: string}[];
  };
  slot?: {kind: string; style: string};
}

export interface VideoPlan {
  id: string;
  title: string;
  thesis: string;
  intent: string;
  formats: string[];
  language: string;
  sections: PlanSection[];
  alternates: {thesis: string; angle: string; why: string}[];
  narration: {provider: string; voice: string; profile?: string; style: string};
  cta?: {label: string; url: string};
}

export interface QcEntry {
  format: string;
  report: {
    passed: boolean;
    media: Record<string, unknown>;
    captions: Record<string, unknown>;
    checks: Record<string, boolean>;
    diagnostics: {failed: string[]; freezeEvents: string[]; blackEvents: string[]};
  };
}

export interface VideoDetail {
  videoId: string;
  plan: VideoPlan | null;
  provenance: Record<string, unknown> | null;
  qc: QcEntry[];
  files: {name: string; url: string}[];
}

/**
 * The research trail for a thread. Every string in here except `factState` was written by a
 * web page or by the agent reading one — data, not markup. React escapes it; keep it that way.
 */
export interface ThreadResearch {
  threadId: string;
  updatedAt?: string;
  brief: {question: string; findings: string[]; gaps: string[]; writtenAt: string} | null;
  queries: {at: string; query: string; provider: string; hits: number}[];
  sources: {
    url: string;
    title: string;
    via: string;
    readAt: string;
    dropped: number;
    statements: number;
    error?: string;
    figures: {
      statement: string;
      attribution: string;
      value: number;
      unit: string;
      context: string;
      /** Null until the agent proposes it as a fact. Only the Brand screen can approve one. */
      factState: "proposed" | "approved" | null;
    }[];
  }[];
}

export interface AgentEvent {
  type: "message" | "event" | "done" | "error";
  text: string;
  tool?: string;
  videoId?: string;
  cost?: {chargedUsd: number; apiEquivalentUsd: number; billingMode: string};
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {"Content-Type": "application/json", ...init?.headers},
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({error: response.statusText}));
    throw new Error((body as {error?: string}).error ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  threads: () => request<Thread[]>("/api/threads"),
  thread: (id: string) => request<Thread>(`/api/threads/${id}`),
  createThread: (title: string, brief = "", videoId?: string) =>
    request<Thread>("/api/threads", {method: "POST", body: JSON.stringify({title, brief, videoId})}),
  threadResearch: (id: string) => request<ThreadResearch>(`/api/threads/${id}/research`),
  videos: () => request<LedgerEntry[]>("/api/videos"),
  video: (id: string) => request<VideoDetail>(`/api/videos/${id}`),
  revealVideo: (id: string) =>
    request<{ok: boolean; path?: string; error?: string}>(`/api/videos/${id}/reveal`, {method: "POST"}),
  applyEdits: (id: string, edits: unknown[]) =>
    request<{durationChanged: boolean; needsCompose: string[]; outputs: {format: string; qcPassed: boolean}[]}>(
      `/api/videos/${id}/apply`,
      {method: "POST", body: JSON.stringify({edits})},
    ),
  brand: () => request<{kit: Record<string, unknown>; contrastFailures: unknown[]}>("/api/brand"),
  saveBrand: (kit: unknown) =>
    request<{kit: Record<string, unknown>}>("/api/brand", {method: "PUT", body: JSON.stringify(kit)}),
  media: () => request<{items: Record<string, unknown>[]; presets: Record<string, unknown>[]}>("/api/media"),
  facts: () => request<Record<string, unknown>[]>("/api/facts"),
  saveFacts: (facts: unknown[]) =>
    request<unknown[]>("/api/facts", {method: "PUT", body: JSON.stringify(facts)}),
  research: (urls: string[]) =>
    request<ResearchResult>("/api/research", {method: "POST", body: JSON.stringify({urls})}),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) =>
    request<Settings>("/api/settings", {method: "PUT", body: JSON.stringify(settings)}),
};

export interface Settings {
  contentLanguage: ContentLanguage;
  composer: "claude" | "codex";
}

export interface ResearchResult {
  pages: {url: string; title: string; summary: string; blocks: number}[];
  facts: {kind: string; statement: string; sourceUrl: string; needsEvidence: boolean}[];
  colors: {
    hex: string;
    count: number;
    role: "surface" | "text" | "accent";
    suggestedToken: string;
    matchesToken?: string;
    onSurface: number;
  }[];
  fonts: {stack: string; count: number; matchesStack?: string}[];
  errors: string[];
  saved: {added: number; skipped: number};
}

/** Stream one agent turn. `onEvent` fires as each tool call and message lands. */
export async function sendMessage(
  threadId: string,
  text: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/threads/${threadId}/message`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({text}),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`The studio did not respond (${response.status}).`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const payload = frame.replace(/^data: /, "").trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as AgentEvent);
      } catch {
        // A partial frame; the next chunk completes it.
      }
    }
  }
}
