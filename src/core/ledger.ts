import fs from "node:fs/promises";
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
});

export type LedgerEntry = z.infer<typeof ledgerEntryZ>;

const LEDGER_PATH = path.join(VIDEOS_DIR, "index.json");

/**
 * The studio's memory. Deliberately not the chat transcript: a conversation gets
 * compacted and loses exactly the detail that prevents making the same video twice,
 * whereas a structured query does not.
 */
export async function readLedger(): Promise<LedgerEntry[]> {
  const raw = await fs.readFile(LEDGER_PATH, "utf8").catch(() => "[]");
  const parsed = z.array(ledgerEntryZ).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

export async function upsertLedgerEntry(entry: LedgerEntry): Promise<void> {
  const entries = await readLedger();
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);

  await fs.mkdir(path.dirname(LEDGER_PATH), {recursive: true});
  await fs.writeFile(LEDGER_PATH, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
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
  for (const entry of await readLedger()) {
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
  const entries = await readLedger();
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
