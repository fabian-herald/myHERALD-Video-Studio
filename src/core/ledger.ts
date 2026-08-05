import fs from "node:fs/promises";
import {writeJsonFile} from "./util/writeJson.ts";
import path from "node:path";
import {z} from "zod";
import {VIDEOS_DIR} from "./paths.ts";
import {INTENTS} from "./plan/schema.ts";
import {OUTPUT_FORMATS} from "./plan/formats.ts";

export const ledgerEntryZ = z.object({
  id: z.string(),
  title: z.string(),
  thesis: z.string(),
  intent: z.enum(INTENTS),
  formats: z.array(z.enum(OUTPUT_FORMATS)),
  language: z.string(),
  createdAt: z.string(),
  status: z.enum(["draft", "ready", "failed", "awaiting-presenter", "stale"]),
  spokenScript: z.string().default(""),
  mediaIds: z.array(z.string()).default([]),
  /**
   * The facts this video charted, by id.
   *
   * Here rather than derived from the plan on demand, for the reason the ledger exists at
   * all: a question about the whole body of work should not require opening every plan on
   * disk. It is what stops the same three statistics turning up in nine videos — the
   * planner is shown which figures are already spent, and how recently.
   */
  factIds: z.array(z.string()).default([]),
  outputs: z.array(z.object({format: z.string(), path: z.string()})).default([]),
  /**
   * When the owner retired this video, or absent while it counts.
   *
   * A separate field rather than a `status`, because it answers a different question:
   * `status` is what the pipeline made of it, and archiving is what the owner made of it.
   * A test that rendered perfectly is still `ready` — and still not something the studio
   * should remember, which is the second half of what this field does. Archived entries
   * leave `similarTheses` and `factUsage`, so a throwaway test neither blocks the real
   * video on that thesis nor retires the figures it charted.
   */
  archivedAt: z.string().optional(),
});

export type LedgerEntry = z.infer<typeof ledgerEntryZ>;

const LEDGER_PATH = path.join(VIDEOS_DIR, "index.json");

/**
 * The studio's memory. Deliberately not the chat transcript: a conversation gets
 * compacted and loses exactly the detail that prevents making the same video twice,
 * whereas a structured query does not.
 */
export async function readLedger(): Promise<LedgerEntry[]> {
  const raw = await fs.readFile(LEDGER_PATH, "utf8").catch(() => "");
  // A missing ledger and an empty one both mean "nothing recorded yet". Only the missing
  // case was handled, so a zero-byte file threw out of `JSON.parse` instead — and that
  // throw reaches the route, so the Videos screen answered 500 rather than "nothing yet".
  // `readSettings` has always read its file this way; this is the same reading.
  const parsed = z.array(ledgerEntryZ).safeParse(JSON.parse(raw.trim() || "[]"));
  return parsed.success ? parsed.data : [];
}

/** The ledger as the studio's memory: everything the owner has not retired. */
export async function activeLedger(): Promise<LedgerEntry[]> {
  return (await readLedger()).filter((entry) => !entry.archivedAt);
}

/** Retire a video from the studio's memory, or bring it back. Returns null if unknown. */
export async function setLedgerArchived(id: string, archived: boolean): Promise<LedgerEntry | null> {
  return amendLedgerEntry(id, {archivedAt: archived ? new Date().toISOString() : undefined});
}

export async function removeLedgerEntry(id: string): Promise<boolean> {
  const entries = await readLedger();
  const remaining = entries.filter((entry) => entry.id !== id);
  if (remaining.length === entries.length) return false;
  await writeLedger(remaining);
  return true;
}

export async function upsertLedgerEntry(entry: LedgerEntry): Promise<void> {
  const entries = await readLedger();
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);

  await writeLedger(entries);
}

/**
 * Update what an edit actually changed about a video, and nothing else.
 *
 * `applyPlanEdits` re-narrates, re-renders and re-runs QC, and wrote none of it back — so
 * a video that failed its first render and was then repaired by an edit went on reading
 * `failed` for good. Four of twelve entries said `failed` while the files on disk were
 * fine, and that is a failure rate the owner was reading as real.
 *
 * `id` and `createdAt` are excluded by the type rather than left to discipline. An edit is
 * not a new video: the date is what `factUsage` reports as "last charted" and what the
 * planner prints as how recently a figure was spent, so re-stamping it on a wording change
 * would make an old video look fresh and quietly retire figures that were still free.
 *
 * Returns null when there is nothing to amend — a video made before the ledger existed.
 * The caller reports that rather than inventing an entry, because a fabricated one would
 * carry a creation date that is simply wrong and would then be used as if it were real.
 */
export async function amendLedgerEntry(
  id: string,
  patch: Partial<Omit<LedgerEntry, "id" | "createdAt">>,
): Promise<LedgerEntry | null> {
  const entries = await readLedger();
  const index = entries.findIndex((entry) => entry.id === id);
  const existing = entries[index];
  if (!existing) return null;

  const amended: LedgerEntry = {...existing, ...patch, id: existing.id, createdAt: existing.createdAt};
  entries[index] = amended;
  await writeLedger(entries);
  return amended;
}

/** Exported for the one-off rename migration; the pipeline goes through upsert/amend. */
export async function writeLedger(entries: readonly LedgerEntry[]): Promise<void> {
  await writeJsonFile(LEDGER_PATH, entries);
}

/** How often a fact has been charted, and when it was last used. */
export interface FactUse {
  count: number;
  lastAt: string;
}

/**
 * Which figures are already spent, from the ledger.
 *
 * The point of the whole sourcing loop is that a number reaching a video is one somebody
 * checked, and the cost of that is a small pool of them. A small pool plus no memory is how
 * the same three statistics end up in nine videos — each one individually justified, the
 * body of work repeating itself. So the planner is told what has been used and how recently,
 * and prefers a figure that has not.
 *
 * A count, never a ban. Sometimes the number *is* the video, and the second piece about it
 * is the better one. That is the owner's call and the planner's judgement, not a rule.
 */
export async function factUsage(): Promise<Map<string, FactUse>> {
  const usage = new Map<string, FactUse>();
  for (const entry of await activeLedger()) {
    // A failed run charted nothing anyone saw. Counting it would retire a figure over a
    // render that never produced a file.
    if (entry.status === "failed") continue;
    for (const id of entry.factIds) {
      const seen = usage.get(id);
      if (!seen) usage.set(id, {count: 1, lastAt: entry.createdAt});
      else usage.set(id, {count: seen.count + 1, lastAt: later(seen.lastAt, entry.createdAt)});
    }
  }
  return usage;
}

const later = (a: string, b: string): string => (a > b ? a : b);

/**
 * Cheap lexical overlap against prior theses. Good enough to surface "you already
 * made this" before spending a planning call, and it needs no embedding store.
 */
export async function similarTheses(query: string, limit = 5): Promise<LedgerEntry[]> {
  const entries = await activeLedger();
  const terms = tokenise(query);
  if (!terms.size) return [];

  return entries
    .map((entry) => ({entry, score: overlap(terms, tokenise(`${entry.thesis} ${entry.title}`))}))
    .filter((scored) => scored.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.entry);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "for", "on", "with", "is", "it",
  "that", "this", "your", "you", "der", "die", "das", "und", "oder", "für", "mit", "ist",
  "ein", "eine", "den", "dem", "im", "auf", "von", "zu", "dass", "sich", "nicht",
]);

function tokenise(value: string): Set<string> {
  return new Set(
    value.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
