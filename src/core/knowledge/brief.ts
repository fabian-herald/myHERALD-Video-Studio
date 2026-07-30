import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {DATA_DIR} from "../paths.ts";
import {figureZ} from "./figures.ts";

/**
 * The research trail for one thread: what was searched, what was read, what came back, and
 * the brief the agent wrote over the top of it.
 *
 * Keyed by **thread**, not by video, and that is the whole reason this file exists rather
 * than a field on the plan. Research happens before there is a video — the agent searches,
 * reads, proposes facts, and only then does anyone say "make it". A record hanging off the
 * video would start empty at exactly the moment the interesting part had already happened.
 *
 * Two kinds of content, kept apart:
 *
 * - The **trail** is written by the tools as they run, so it cannot be lost by an agent
 *   deciding not to mention something. Every query, including the ones that found nothing.
 * - The **brief** is written by the agent on purpose, and is a claim rather than a record:
 *   this is the question, this is what the sources support, this is what they did not.
 *
 * Nothing here is evidence and nothing here is approved. A figure in this file is a figure
 * some page printed; it reaches a prompt only after the owner approves it as a fact. The
 * text is attacker-authored — page titles, sentences off a page — and is rendered by React,
 * which escapes it. Do not put it through `dangerouslySetInnerHTML`.
 */

export const RESEARCH_DIR = path.join(DATA_DIR, "research");

/** A search that was run. Recorded whether or not it found anything worth reading. */
export const researchQueryZ = z.object({
  at: z.string(),
  query: z.string(),
  provider: z.string(),
  hits: z.number(),
});

/** A page that was read, and what came off it. */
export const researchSourceZ = z.object({
  url: z.string(),
  title: z.string().default(""),
  /** `exa-index`, `fetched`, or whichever provider's index the text came from. */
  via: z.string().default(""),
  readAt: z.string(),
  figures: z.array(figureZ).default([]),
  /** Figures the page did not support, so a thin read is visible as thin. */
  dropped: z.number().default(0),
  /** Statement candidates, when the page was read by research_web rather than read_source. */
  statements: z.number().default(0),
  error: z.string().optional(),
});

/**
 * What the agent says its research came to.
 *
 * `gaps` is not politeness. The failure mode this whole subsystem exists to prevent is a
 * confident number nobody can source, so "I could not find this" has to be as easy to record
 * as a finding — otherwise the honest answer is the one with nowhere to go.
 */
export const briefZ = z.object({
  question: z.string().min(8).max(300),
  findings: z.array(z.string().min(8).max(400)).max(10).default([]),
  gaps: z.array(z.string().min(4).max(300)).max(6).default([]),
  writtenAt: z.string(),
});

export const researchRecordZ = z.object({
  schemaVersion: z.literal(1),
  threadId: z.string(),
  updatedAt: z.string(),
  queries: z.array(researchQueryZ).default([]),
  sources: z.array(researchSourceZ).default([]),
  brief: briefZ.optional(),
});

export type ResearchRecord = z.infer<typeof researchRecordZ>;
export type ResearchSource = z.infer<typeof researchSourceZ>;
export type ResearchQuery = z.infer<typeof researchQueryZ>;
export type Brief = z.infer<typeof briefZ>;

/**
 * Ceilings, because an agent in a loop is a file that grows until something breaks. The
 * newest entries win: a trail is most useful about what just happened.
 */
const MAX_QUERIES = 120;
const MAX_SOURCES = 60;

const recordPath = (threadId: string) => path.join(RESEARCH_DIR, `${sane(threadId)}.json`);

/**
 * Thread ids come from our own store, not from a request, but this is a filename.
 *
 * Rejected rather than sanitised, which is the correction a test forced: stripping the unsafe
 * characters out of `../../etc/passwd` leaves `etcpasswd`, a perfectly valid id for a
 * different record. The traversal was neutralised and the request silently became a question
 * about some other file — safe, and wrong. Every id we issue already matches this, so
 * anything that does not is not an id and has no record to read.
 */
const ID = /^[A-Za-z0-9_-]+$/;

function sane(threadId: string): string {
  if (!ID.test(threadId)) throw new Error(`"${threadId}" is not a usable thread id.`);
  return threadId;
}

const empty = (threadId: string): ResearchRecord => ({
  schemaVersion: 1,
  threadId,
  updatedAt: new Date().toISOString(),
  queries: [],
  sources: [],
});

export async function loadResearch(threadId: string): Promise<ResearchRecord | null> {
  const raw = await fs.readFile(recordPath(threadId), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = researchRecordZ.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * In-flight writes per thread, so two tool calls in one turn cannot lose each other's work.
 *
 * The agent is free to run tools in parallel, and read-modify-write on a JSON file is a race
 * the moment it does: two `read_source` calls finishing together would each load the record
 * as it was before either, and whichever wrote second would erase the other's page. Chaining
 * per thread costs nothing here — these writes are tiny and rare — and removes the class.
 */
const writing = new Map<string, Promise<ResearchRecord>>();

async function update(
  threadId: string,
  mutate: (record: ResearchRecord) => ResearchRecord,
): Promise<ResearchRecord> {
  const previous = writing.get(threadId) ?? Promise.resolve(empty(threadId));
  const next = previous
    // A failed write must not poison the chain: the following call should try again from
    // whatever is actually on disk rather than inherit the rejection.
    .catch(() => empty(threadId))
    .then(async () => {
      const current = (await loadResearch(threadId)) ?? empty(threadId);
      const updated = mutate(current);
      const trimmed: ResearchRecord = {
        ...updated,
        updatedAt: new Date().toISOString(),
        queries: updated.queries.slice(-MAX_QUERIES),
        sources: updated.sources.slice(-MAX_SOURCES),
      };
      await fs.mkdir(RESEARCH_DIR, {recursive: true});
      await fs.writeFile(recordPath(threadId), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
      return trimmed;
    });

  writing.set(threadId, next);
  void next.catch(() => {}).finally(() => {
    // Only clear the slot if nothing queued behind this one, or the next writer would find
    // an already-settled promise and race the one still to come.
    if (writing.get(threadId) === next) writing.delete(threadId);
  });
  return next;
}

export const recordQuery = (threadId: string, entry: Omit<ResearchQuery, "at">) =>
  update(threadId, (record) => ({
    ...record,
    queries: [...record.queries, {...entry, at: new Date().toISOString()}],
  }));

/** A page read twice replaces its earlier entry — the same URL is one source, not two. */
export const recordSource = (threadId: string, entry: Omit<ResearchSource, "readAt">) =>
  update(threadId, (record) => ({
    ...record,
    sources: [
      ...record.sources.filter((source) => source.url !== entry.url),
      {...entry, readAt: new Date().toISOString()},
    ],
  }));

export const saveBrief = (threadId: string, brief: Omit<Brief, "writtenAt">) =>
  update(threadId, (record) => ({
    ...record,
    brief: {...brief, writtenAt: new Date().toISOString()},
  }));

/** Every figure in the trail, flattened, for anything that wants to match them against facts. */
export const briefFigures = (record: ResearchRecord) =>
  record.sources.flatMap((source) => source.figures.map((figure) => ({...figure, url: source.url})));
