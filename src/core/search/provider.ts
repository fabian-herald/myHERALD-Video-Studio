/**
 * Finding a figure, as opposed to reading a page the owner named.
 *
 * The studio could already chart a number — a `data` block cites a `factId`, and
 * `assertPlanClaimsAreSourced` refuses any value that does not resolve to an approved fact
 * carrying evidence. What it could not do was find one: research meant `researchSite(urls)`
 * against URLs typed in by hand, so the only citable numbers were ones the owner already
 * knew. That is not sourcing.
 *
 * Nothing in here fetches a page or writes a fact. A provider returns hits; the agent
 * decides what is worth reading; the reading goes through the address guard; the owner
 * approves. Four steps, two of them human-visible, and this file is only the first.
 */

/** One result, as every provider can describe it. */
export interface SearchHit {
  title: string;
  url: string;
  /** The provider's own short description of the page. Never page text. */
  snippet: string;
  /**
   * A longer excerpt, only from a provider that indexes page text, truncated by the
   * adapter before the hit is returned.
   *
   * This text arrives from the provider's own host and therefore never passes
   * `knowledge/fetch.ts` — neither its 750 KB ceiling nor its content-type check applies.
   * The cap has to live in the adapter because there is nothing downstream to enforce it.
   */
  excerpt?: string;
  /** Only from a provider that dates its results. Brave does not. */
  publishedDate?: string;
  /** Which adapter produced this, so a mixed list stays attributable. */
  provider: string;
}

export interface SearchQuery {
  query: string;
  /** A request, not a guarantee — the adapter clamps it. */
  count?: number;
  /** Recency window. Each adapter maps this onto whatever its own API calls it. */
  freshness?: "day" | "week" | "month" | "year";
  /** ISO-3166 alpha-2. Providers that cannot target a country ignore it. */
  country?: string;
  signal?: AbortSignal;
}

export interface SearchResult {
  hits: SearchHit[];
  /** What the call cost in USD, or 0 when the provider does not report it. */
  costUsd: number;
}

/**
 * Every search backend implements this. Adding one is a new file plus a registry entry.
 *
 * `indexesPageText` is a declared flag rather than an optional `read?()` method, and the
 * distinction is real: Brave and Exa differ in the *shape of one response*, not in whether
 * a second call exists. A retrieval method here would have no callers — every fact-bearing
 * fetch goes through the address guard — and an unused retrieval path is precisely what
 * somebody wires up later without the byte cap and the content-type check. The guard is
 * only a real control while there is no sanctioned way around it.
 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  /** The env var holding this provider's key, used only to name it in an error. */
  readonly keyEnvVar: string;
  /**
   * True when this provider indexes page text and fills `SearchHit.excerpt`.
   *
   * Brave is search-only and must not be made to fake page text: an excerpt a caller
   * cannot tell apart from a snippet is an excerpt nobody can judge the weight of.
   */
  readonly indexesPageText: boolean;
  /** Whether the key is present. Never returns, logs, or derives from the key's value. */
  configured(): boolean;
  search(request: SearchQuery): Promise<SearchResult>;
}

const registry = new Map<string, SearchProvider>();

export function registerSearchProvider(provider: SearchProvider) {
  registry.set(provider.id, provider);
}

export function searchProviderFor(id: string): SearchProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new Error(
      `Unknown search provider "${id}". Registered: ${[...registry.keys()].join(", ") || "none"}.`,
    );
  }
  return provider;
}

export const listSearchProviders = () => [...registry.values()];

/** For a tool's zod enum, so the model is offered the ids that actually exist. */
export const SEARCH_PROVIDER_IDS = ["exa", "brave"] as const;

/**
 * Preference order when the owner did not name one, most-preferred first.
 *
 * Exa first, on measured behaviour rather than on the marketing. One query — marketing
 * budget as a share of revenue — run through both:
 *
 *   Exa    → three cmosurvey.org PDFs, with 440–1200 characters of their text inline
 *   Brave  → three blogs *about* that survey, snippets only
 *
 * So Exa found the primary source and Brave found people writing about it, which is the
 * reverse of what I expected and the reverse of the usual claim about neural indexes. It
 * also matters more here than it would elsewhere: `fetch.ts` refuses `application/pdf`, so
 * a PDF found by Brave is a URL the studio cannot open, while a PDF found by Exa arrives
 * with its text already extracted.
 *
 * One expectation did not survive contact: **Exa did not return `publishedDate` for any
 * real result** — the field was absent from the response entirely, though it appears in
 * their spec example. Do not build anything on a date from a search hit, from either
 * provider. The year in an evidence note has to come from the page.
 *
 * Brave keeps its place as fallback and second opinion. One query is not a benchmark, and a
 * keyword index will beat a neural one whenever the exact phrasing is what matters.
 */
export const SEARCH_PREFERENCE = ["exa", "brave"] as const;

/** The registered providers that have a key, in preference order. */
export function configuredSearchProviders(): SearchProvider[] {
  return SEARCH_PREFERENCE
    .map((id) => registry.get(id))
    .filter((provider): provider is SearchProvider => Boolean(provider?.configured()));
}

/**
 * The provider to use when nobody named one.
 *
 * Throws rather than returning null, because every non-tool caller wants the failure. The
 * `search_web` tool pre-checks `configuredSearchProviders()` and returns this text as a
 * normal result instead — a message the agent can relay to the owner beats an MCP error it
 * has to interpret.
 */
export function defaultSearchProvider(): SearchProvider {
  const configured = configuredSearchProviders();
  if (configured[0]) return configured[0];

  throw new Error(NO_PROVIDER_MESSAGE);
}

/**
 * The one place the owner learns what to add, so it names both variables and both sites.
 *
 * Following `tts/transcribe.ts` house style: say what is missing, say where it goes, and
 * say what still works without it, so a missing key reads as a choice not yet made rather
 * than as a broken studio.
 */
export const NO_PROVIDER_MESSAGE =
  "Web search needs a provider key and neither is set. Add EXA_API_KEY or "
  + "BRAVE_SEARCH_API_KEY to .env.local — Exa (exa.ai) indexes page text and dates its "
  + "results, which suits sourcing a figure; Brave (brave.com/search/api) has the broader "
  + "index. Without one the studio can still read URLs you name yourself.";
