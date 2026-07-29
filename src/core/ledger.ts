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
