import {searchFetch} from "./http.ts";
import {registerSearchProvider, type SearchHit, type SearchProvider, type SearchQuery} from "./provider.ts";

/**
 * Brave: an independent index, search only.
 *
 * It returns titles, URLs and its own descriptions — no page text and no per-result date.
 * That is a real limitation for sourcing a figure and it is modelled honestly rather than
 * papered over: `indexesPageText` is false and `excerpt` is never set. The compensation is
 * reach. A neural index tends to rank an article *about* a statistic above the government
 * table that published it; Brave often has the table.
 */

/** A literal, not configuration. Nothing attacker-influenced reaches this URL. */
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Brave allows 20. Ten is already more sources than an agent should read in one turn. */
const MAX_COUNT = 10;
const DEFAULT_COUNT = 6;

/** Brave's own freshness codes. An unrecognised value must be omitted, never forwarded. */
const FRESHNESS = {day: "pd", week: "pw", month: "pm", year: "py"} as const;

/** How much `extra_snippets` may add to a description before it stops being a description. */
const MAX_SNIPPET_CHARS = 500;

/**
 * Brave wraps the query's matched terms in `<strong>`, which arrives verbatim in the
 * description — a real response contained `plateaued at <strong>7.7%`.
 *
 * Removed for readability, and only that. This is **not** a sanitiser and must not be
 * mistaken for one: it drops exactly Brave's own emphasis tags and leaves every other
 * character alone. What protects the agent from a hostile snippet is the injection fence on
 * the tool's output; what protects the browser is React escaping. Widening this into
 * general tag-stripping would provide neither while looking like it provided both.
 */
const stripMatchMarkup = (text: string) => text.replace(/<\/?strong>/gi, "");

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  extra_snippets?: unknown;
}

/**
 * Pure, and split from the network for the reason `extractPage` was: a normaliser is
 * testable against a captured response, and a normaliser reached only through `fetch` is
 * testable against nothing.
 */
export function normalizeBraveResponse(payload: unknown): SearchHit[] {
  const results = (payload as {web?: {results?: unknown}})?.web?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry: BraveResult) => {
    const url = typeof entry.url === "string" ? entry.url : "";
    const title = typeof entry.title === "string" ? entry.title : "";
    if (!url) return [];

    // `description` is genuinely optional in Brave's shape. Floor to "" rather than letting
    // `undefined` through and rendering as the string "undefined" in a tool payload.
    const parts = [typeof entry.description === "string" ? entry.description : ""];
    if (Array.isArray(entry.extra_snippets)) {
      // Appended to the description, deliberately NOT promoted to `excerpt`. These are still
      // Brave's own summaries of the page, and calling them an excerpt would be exactly the
      // pretence that `indexesPageText: false` exists to prevent.
      parts.push(...entry.extra_snippets.filter((snippet): snippet is string => typeof snippet === "string"));
    }

    return [{
      title,
      url,
      snippet: stripMatchMarkup(parts.filter(Boolean).join(" … ")).slice(0, MAX_SNIPPET_CHARS),
      provider: "brave",
    } satisfies SearchHit];
  });
}

export const braveSearch: SearchProvider = {
  id: "brave",
  label: "Brave Search",
  keyEnvVar: "BRAVE_SEARCH_API_KEY",
  indexesPageText: false,

  configured: () => Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),

  async search(request: SearchQuery) {
    const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!key) {
      throw new Error("BRAVE_SEARCH_API_KEY is not set. Add it to .env.local, from brave.com/search/api.");
    }

    const params = new URLSearchParams({
      q: request.query,
      // Clamped here, not only in the tool's zod schema. A `.max()` there tells the model
      // what to ask for; this is what actually holds when something else calls it.
      count: String(Math.min(Math.max(request.count ?? DEFAULT_COUNT, 1), MAX_COUNT)),
    });

    const freshness = request.freshness ? FRESHNESS[request.freshness] : undefined;
    if (freshness) params.set("freshness", freshness);
    if (request.country) params.set("country", request.country.slice(0, 2).toUpperCase());

    const payload = await searchFetch(`${ENDPOINT}?${params}`, {
      headers: {
        "X-Subscription-Token": key,
        accept: "application/json",
      },
      signal: request.signal,
    });

    // Brave bills per query on a plan, not per call in the response, so there is nothing
    // truthful to report here. Zero rather than a guess — the cost ledger distinguishes
    // "free" from "unknown" and an invented figure would corrupt both.
    return {hits: normalizeBraveResponse(payload), costUsd: 0};
  },
};

registerSearchProvider(braveSearch);
