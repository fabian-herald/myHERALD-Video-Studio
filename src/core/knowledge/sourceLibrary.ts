import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {KNOWLEDGE_DIR} from "../paths.ts";
import {RESEARCH_DIR, researchRecordZ, researchSourceZ, type ResearchSource} from "./brief.ts";

/**
 * Every page the studio has ever read for figures, in one place.
 *
 * A per-thread trail answers "how did this video get its number". This answers the other
 * question: "have we already got one". Verifying a figure costs a search, two or three
 * fetches and a model call, and the same three statistics get looked up over and over
 * because nothing remembered the last time. So `read_source` files what it finds here as
 * well as in the thread, and the agent checks stock before spending a search.
 *
 * Deliberately not `sources.json`, which `research_web` already owns. That file holds the
 * owner's *own* pages — summaries and excerpts kept so an approval can be checked against
 * the wording that produced it. Merging the two would put marketing copy from myherald.io
 * into the results of a question about third-party statistics, which is precisely the
 * confusion the sourcing rules exist to prevent.
 *
 * Nothing here is approved. A figure in the library is still a number a page printed; it
 * becomes usable by a video through `propose_facts` and a click in the Brand screen, and
 * this module holds no writer that could shorten that path.
 */
export const LIBRARY_PATH = path.join(KNOWLEDGE_DIR, "source-library.json");

export const librarySourceZ = researchSourceZ.extend({
  /** Threads that have read this page, so a figure can be traced back to its research. */
  threadIds: z.array(z.string()).default([]),
  /** The first read. `readAt` is the most recent one. */
  firstReadAt: z.string().default(""),
});

export const libraryZ = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string(),
  sources: z.array(librarySourceZ).default([]),
});

export type LibrarySource = z.infer<typeof librarySourceZ>;
export type SourceLibrary = z.infer<typeof libraryZ>;

/**
 * A year, after which a stored figure is offered as stale rather than as available.
 *
 * Measured from when the page was read, which is the only date this module actually knows.
 * It is a weaker signal than it looks: a 2019 survey read yesterday is fresh by this clock
 * and stale in every way that matters. That is why a hit carries its `attribution` — the
 * page's own credit line, usually naming the study and its year — and why the wording put
 * in front of the agent asks it to read that rather than trust the age alone.
 */
export const STALE_AFTER_DAYS = 365;

const MAX_SOURCES = 400;

/**
 * The library, built from the per-thread trails the first time it is asked for.
 *
 * The trails already hold every page ever read, so the store starts full rather than
 * empty — a source database that only knows what happened after it was installed is one
 * nobody trusts for a year. Backfill is a plain read of `data/research/`, skipped once the
 * file exists, and a corrupt trail is stepped over rather than taking the whole read down.
 */
export async function readLibrary(): Promise<SourceLibrary> {
  const raw = await fs.readFile(LIBRARY_PATH, "utf8").catch(() => null);
  if (raw) {
    const parsed = libraryZ.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  }
  return backfillFromTrails();
}

async function backfillFromTrails(): Promise<SourceLibrary> {
  const files = await fs.readdir(RESEARCH_DIR).catch(() => [] as string[]);
  const library: SourceLibrary = {schemaVersion: 1, updatedAt: new Date().toISOString(), sources: []};

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const raw = await fs.readFile(path.join(RESEARCH_DIR, file), "utf8").catch(() => null);
    if (!raw) continue;
    let record;
    try {
      record = researchRecordZ.safeParse(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!record.success) continue;
    mergeSources(library, record.data.threadId, record.data.sources);
  }
  return library;
}

/**
 * One writer, serialised.
 *
 * `read_source` takes three URLs and the agent can have two calls in flight, so a plain
 * read-modify-write on one file loses whichever page finished second. Same reasoning as
 * the per-thread trail; there is only one file here, so there is only one chain.
 */
let writing: Promise<unknown> = Promise.resolve();

export function rememberSources(
  threadId: string,
  sources: readonly ResearchSource[],
): Promise<SourceLibrary> {
  const next = writing
    // A failed write must not poison the chain: the following call should try again from
    // whatever is actually on disk rather than inherit the rejection.
    .catch(() => undefined)
    .then(async () => {
      const library = await readLibrary();
      mergeSources(library, threadId, sources);
      library.updatedAt = new Date().toISOString();
      await fs.mkdir(path.dirname(LIBRARY_PATH), {recursive: true});
      await fs.writeFile(LIBRARY_PATH, `${JSON.stringify(library, null, 2)}\n`, "utf8");
      return library;
    });

  writing = next;
  return next;
}

/**
 * Fold a thread's pages into the library, one entry per URL.
 *
 * Figures accumulate rather than replace. A page read twice with a different `lookingFor`
 * yields different numbers off the same text, and the second read knowing less than the
 * first would make the library worse the more it was used. Identical figures collapse on
 * statement and value, so re-reading the same page costs nothing.
 */
export function mergeSources(
  library: SourceLibrary,
  threadId: string,
  sources: readonly ResearchSource[],
): void {
  for (const source of sources) {
    const key = normaliseUrl(source.url);
    const existing = library.sources.find((entry) => normaliseUrl(entry.url) === key);
    if (!existing) {
      library.sources.push(librarySourceZ.parse({
        ...source,
        threadIds: [threadId],
        firstReadAt: source.readAt,
      }));
      continue;
    }

    const seen = new Set(existing.figures.map(figureKey));
    for (const figure of source.figures) {
      if (!seen.has(figureKey(figure))) existing.figures.push(figure);
    }
    if (source.readAt > existing.readAt) {
      existing.readAt = source.readAt;
      // The newest read wins on the describing fields: a title or a route that changed is
      // the current truth about the page, not a second opinion to keep alongside the old.
      if (source.title) existing.title = source.title;
      if (source.via) existing.via = source.via;
    }
    if (source.readAt < (existing.firstReadAt || source.readAt)) existing.firstReadAt = source.readAt;
    if (!existing.threadIds.includes(threadId)) existing.threadIds.push(threadId);
    // An error is only carried while the page has given us nothing. Once it has, saying
    // "not read" beside three figures off it is just wrong.
    if (existing.figures.length) delete existing.error;
    else if (source.error) existing.error = source.error;
  }

  // Newest first, then trimmed. A library that grows without limit eventually stops being
  // read at all, and the oldest reads are the ones most likely to be stale anyway.
  library.sources.sort((a, b) => b.readAt.localeCompare(a.readAt));
  library.sources.splice(MAX_SOURCES);
}

const figureKey = (figure: {statement: string; value: number}) =>
  `${figure.statement.trim().toLowerCase()}|${figure.value}`;

/**
 * Parameters that say where a visitor came from, never which page they landed on.
 *
 * Not a general query-strip. A site that paginates or filters by query serves genuinely
 * different pages, and merging those would answer confidently about one nobody read — so
 * only parameters that are known to be inert come off. The list earned its place on the
 * first backfill: the same Orbit Media page sat on the shelf twice, once bare and once
 * with a `hubs_content` tag picked up from a HubSpot link, and its figures came back
 * duplicated in every search.
 */
const TRACKING = /^(utm_|hubs_|mc_|_hs|pk_|piwik_)|^(fbclid|gclid|msclkid|dclid|yclid|twclid|igshid|ttclid|mkt_tok|_ga)$/i;

/**
 * Same page, allowing for a trailing slash, a case-insensitive host and tracking noise.
 *
 * Everything else in the query is kept, and the remainder is sorted so two links that
 * carry the same parameters in a different order are one page rather than two.
 */
export function normaliseUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const kept = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = kept.length
      ? `?${kept.map(([key, value]) => `${key}=${value}`).join("&")}`
      : "";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${query}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

export interface LibraryHit {
  url: string;
  title: string;
  readAt: string;
  ageDays: number;
  stale: boolean;
  statement: string;
  attribution: string;
  value: number;
  unit: string;
  context: string;
}

/**
 * Figures already on the shelf that bear on `query`.
 *
 * Lexical overlap, matching `similarTheses` in the ledger — good enough to answer "have we
 * got anything about this" before a search is spent, and it needs no embedding store. The
 * whole figure is scored, statement and quoted sentence and page title together, because
 * the words a video uses are rarely the words the page used.
 *
 * Pure over an already-loaded library, so the ranking is testable without touching disk.
 */
export function findFigures(
  library: SourceLibrary,
  query: string,
  now = new Date(),
  limit = 12,
): LibraryHit[] {
  const terms = tokenise(query);
  if (!terms.size) return [];

  const hits: {hit: LibraryHit; score: number}[] = [];
  for (const source of library.sources) {
    for (const figure of source.figures) {
      const {score, shared} = overlap(terms, tokenise(`${figure.statement} ${figure.context} ${source.title}`));
      // Two words, or the only word there was. One shared term out of three is how "email
      // open rate" came back holding a conversion-rate figure — a false hit here is worse
      // than a miss, because it tells the agent to stop looking for something we have not
      // got, and the number it stops on is about something else.
      if (shared < Math.min(2, terms.size)) continue;
      const ageDays = Math.max(0, Math.round(
        (now.getTime() - new Date(source.readAt).getTime()) / 86_400_000,
      ));
      hits.push({
        score,
        hit: {
          url: source.url,
          title: source.title,
          readAt: source.readAt,
          ageDays,
          stale: ageDays > STALE_AFTER_DAYS,
          statement: figure.statement,
          attribution: figure.attribution,
          value: figure.value,
          unit: figure.unit,
          context: figure.context,
        },
      });
    }
  }

  // Fresh before stale before better-matching. A stale figure that matches perfectly is
  // still the wrong thing to reach for first, and it stays in the list saying so.
  return hits
    .sort((a, b) => Number(a.hit.stale) - Number(b.hit.stale) || b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.hit);
}

/** One line for read_context: what is on the shelf, without listing it. */
export function libraryStock(library: SourceLibrary, now = new Date()) {
  const figures = library.sources.flatMap((source) =>
    source.figures.map(() => source.readAt));
  const fresh = figures.filter((readAt) =>
    (now.getTime() - new Date(readAt).getTime()) / 86_400_000 <= STALE_AFTER_DAYS);
  return {pages: library.sources.length, figures: figures.length, fresh: fresh.length};
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "for", "on", "with", "is", "it",
  "that", "this", "your", "you", "are", "was", "how", "much", "many", "per", "der", "die",
  "das", "und", "oder", "für", "mit", "ist", "ein", "eine", "den", "dem", "im", "auf",
  "von", "zu", "dass", "sich", "nicht", "wie", "viel",
]);

function tokenise(value: string): Set<string> {
  return new Set(
    value.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function overlap(a: Set<string>, b: Set<string>): {score: number; shared: number} {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return {score: shared / a.size, shared};
}
