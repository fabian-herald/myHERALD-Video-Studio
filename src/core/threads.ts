import fs from "node:fs/promises";
import {writeJsonFile} from "./util/writeJson.ts";
import path from "node:path";
import {z} from "zod";
import {DATA_DIR} from "./paths.ts";
import {hash} from "./util/exec.ts";

export const THREADS_DIR = path.join(DATA_DIR, "threads");
export const STUDIO_THREAD_ID = "studio";

export const threadMessageZ = z.object({
  id: z.string(),
  /** `event` is a pipeline step or tool call, rendered as a run-log line. */
  role: z.enum(["user", "assistant", "event"]),
  text: z.string(),
  at: z.string(),
  tool: z.string().optional(),
  /** Set on the message that opened a gate, so the UI can render its buttons. */
  gate: z.object({
    kind: z.string(),
    costUsd: z.number(),
    resolved: z.string().optional(),
  }).optional(),
});

export const threadZ = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  kind: z.enum(["studio", "video"]),
  title: z.string(),
  videoId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Agent SDK session, so a reopened thread keeps its context. */
  sessionId: z.string().optional(),
  /** Separate histories let the owner switch providers without one corrupting the other. */
  sessions: z.object({
    claude: z.string().optional(),
    codex: z.string().optional(),
  }).default({}),
  messages: z.array(threadMessageZ).default([]),
  /** Set when the owner retires the thread; the rail hides it, nothing deletes it. */
  archivedAt: z.string().optional(),
});

export type Thread = z.infer<typeof threadZ>;
export type ThreadMessage = z.infer<typeof threadMessageZ>;

const threadPath = (id: string) => path.join(THREADS_DIR, `${id}.json`);

export async function listThreads(): Promise<Thread[]> {
  const names = await fs.readdir(THREADS_DIR).catch(() => [] as string[]);
  const threads = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => loadThread(name.replace(/\.json$/, ""))),
  );
  return threads
    .filter((thread): thread is Thread => Boolean(thread))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadThread(id: string): Promise<Thread | null> {
  const raw = await fs.readFile(threadPath(id), "utf8").catch(() => null);
  if (!raw) return null;
  const parsed = threadZ.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function saveThread(thread: Thread): Promise<Thread> {
  const next = {...thread, updatedAt: new Date().toISOString()};
  await writeJsonFile(threadPath(next.id), threadZ.parse(next));
  return next;
}

/**
 * The studio thread is where global work happens — ideas, research, context upkeep,
 * "what have I already covered". Video threads branch off it.
 */
export async function studioThread(): Promise<Thread> {
  return await loadThread(STUDIO_THREAD_ID) ?? saveThread({
    schemaVersion: 1,
    id: STUDIO_THREAD_ID,
    kind: "studio",
    title: "Studio",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessions: {},
    messages: [],
  });
}

export async function createVideoThread(
  title: string,
  brief: string,
  videoId?: string,
): Promise<Thread> {
  // Reopening an existing video reuses its thread rather than orphaning the history.
  if (videoId) {
    const existing = (await listThreads()).find((thread) => thread.videoId === videoId);
    if (existing) return existing;
  }

  const id = `t-${hash({title, brief, videoId, at: Date.now()}, 8)}`;
  return saveThread({
    schemaVersion: 1,
    id,
    kind: "video",
    title,
    ...(videoId ? {videoId} : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessions: {},
    messages: [],
  });
}

/**
 * Retire a thread from the rail, or bring it back.
 *
 * `saveThread` is deliberately not reused: it stamps `updatedAt`, which is what the rail
 * sorts on, so archiving a year-old thread would shove it to the top of the list on its
 * way out — and un-archiving it would then lie about when it was last worked on.
 */
export async function setThreadArchived(id: string, archived: boolean): Promise<Thread | null> {
  const thread = await loadThread(id);
  if (!thread || thread.id === STUDIO_THREAD_ID) return null;

  const next: Thread = {...thread, archivedAt: archived ? new Date().toISOString() : undefined};
  await writeJsonFile(threadPath(id), threadZ.parse(next));
  return next;
}

/** Remove a thread's transcript entirely. The studio thread is not deletable. */
export async function deleteThread(id: string): Promise<boolean> {
  if (id === STUDIO_THREAD_ID) return false;
  return fs.rm(threadPath(id), {force: false}).then(() => true, () => false);
}

/** The thread a video's history lives in, if one was ever opened for it. */
export async function threadForVideo(videoId: string): Promise<Thread | null> {
  return (await listThreads()).find((thread) => thread.videoId === videoId) ?? null;
}

export function appendMessage(thread: Thread, message: Omit<ThreadMessage, "id" | "at">): Thread {
  return {
    ...thread,
    messages: [
      ...thread.messages,
      {...message, id: hash({...message, n: thread.messages.length}, 10), at: new Date().toISOString()},
    ],
  };
}

/** Trim the run-log noise a resumed session does not need to re-read. */
export function conversationOnly(thread: Thread): ThreadMessage[] {
  return thread.messages.filter((message) => message.role !== "event");
}
