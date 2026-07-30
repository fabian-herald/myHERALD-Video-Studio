import {searchFetch} from "./http.ts";
import {registerSearchProvider, type SearchHit, type SearchProvider, type SearchQuery} from "./provider.ts";

/**
 * Exa: a neural index that returns page text inline.
 *
 * The text is what makes it the default. A hit can be judged before a fetch is spent on it —
 * does this page state a number, or does it only promise a report? — and it arrives for PDFs
 * too, which `knowledge/fetch.ts` refuses outright. On a real query it returned the primary
 * source's own PDFs where Brave returned blogs about them.
 *
 * `publishedDate` is read here because the API spec documents it, but measured against real
 * responses **it never arrived** — the field was absent from every result. It is mapped when
 * present and nothing downstream may depend on it. A statistic's year comes from the page.
 */

const ENDPOINT = "https://api.exa.ai/search";

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 6;

/**
 * The cap on `excerpt`, and it is a security control rather than a formatting choice.
 *
 * This text reaches us from Exa's host, so it never passes `knowledge/fetch.ts` — not its
 * 750 KB ceiling and not its content-type check. Roughly two screens: enough to see whether
 * a figure is on the page, far short of enough to hide a long instruction payload in.
 */
export const MAX_EXCERPT_CHARS = 1_200;

/** Exa dates content in hours. */
const FRESHNESS_HOURS = {day: 24, week: 168, month: 720, year: 8_760} as const;

interface ExaResult {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  text?: unknown;
  highlights?: unknown;
  summary?: unknown;
}

/**
 * Build the request body.
 *
 * Exported and tested on its own for one specific reason: `text` and `highlights` must be
 * nested under `contents` for `/search`. Exa's own docs call the top-level form the common
 * mistake, and it **fails silently** — you get hits with no text, which reads exactly like
 * "Exa has no text for this page" rather than like a bug in our request. A test on the shape
 * is the only cheap way to catch that.
 */
export function buildExaBody(request: SearchQuery): Record<string, unknown> {
  const numResults = Math.min(Math.max(request.count ?? DEFAULT_RESULTS, 1), MAX_RESULTS);

  const body: Record<string, unknown> = {
    query: request.query,
    type: "auto",
    numResults,
    contents: {
      // Asked for at the source as well as capped locally. Saving the bandwidth is worth it,
      // but the remote cap is the remote's promise — `normalizeExaResponse` enforces ours.
      text: {maxCharacters: MAX_EXCERPT_CHARS * 2},
      highlights: true,
    },
  };

  // Omitted when unrecognised rather than passed through: a bad parameter 422s the whole
  // call, so a typo in a freshness value would fail the search instead of widening it.
  const hours = request.freshness ? FRESHNESS_HOURS[request.freshness] : undefined;
  if (hours) body.maxAgeHours = hours;

  return body;
}

/** Pure. See `buildExaBody` and `normalizeBraveResponse` for why these are split out. */
export function normalizeExaResponse(payload: unknown): SearchHit[] {
  const results = (payload as {results?: unknown})?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry: ExaResult) => {
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!url) return [];

    const highlights = Array.isArray(entry.highlights)
      ? entry.highlights.filter((item): item is string => typeof item === "string")
      : [];
    const text = typeof entry.text === "string" ? entry.text : "";
    const summary = typeof entry.summary === "string" ? entry.summary : "";

    // Highlights beat raw text when both are present: they are the query-relevant spans, so
    // they carry more signal per character of a capped budget than the top of the page does.
    const source = highlights.length ? highlights.join(" … ") : text;

    const hit: SearchHit = {
      title: typeof entry.title === "string" ? entry.title : "",
      url,
      /*
       * Only a real summary. Falling back to the opening of `text` made the snippet an exact
       * prefix of `excerpt`, so every hit shipped the same 300 characters twice — measured on
       * a live response. Empty is honest: Exa did not summarise this one, and the excerpt
       * below is the text.
       */
      snippet: summary.slice(0, 300),
      provider: "exa",
    };

    // Truncation happens here, inside the normaliser, so that no caller anywhere can obtain
    // an untruncated excerpt — not by passing a different option and not by reaching past
    // the adapter.
    if (source) hit.excerpt = source.slice(0, MAX_EXCERPT_CHARS);
    if (typeof entry.publishedDate === "string") hit.publishedDate = entry.publishedDate;

    return [hit];
  });
}

export const exaSearch: SearchProvider = {
  id: "exa",
  label: "Exa",
  keyEnvVar: "EXA_API_KEY",
  indexesPageText: true,

  configured: () => Boolean(process.env.EXA_API_KEY?.trim()),

  async search(request: SearchQuery) {
    const key = process.env.EXA_API_KEY?.trim();
    if (!key) {
      throw new Error("EXA_API_KEY is not set. Add it to .env.local, from exa.ai.");
    }

    const payload = await searchFetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(buildExaBody(request)),
      signal: request.signal,
      // A neural search with content retrieval is legitimately slower than a keyword lookup.
      timeoutMs: 25_000,
    });

    // Exa does not report per-call cost in the response body. Zero rather than a guess, for
    // the same reason as Brave: the cost ledger distinguishes free from unknown.
    return {hits: normalizeExaResponse(payload), costUsd: 0};
  },
};

registerSearchProvider(exaSearch);
