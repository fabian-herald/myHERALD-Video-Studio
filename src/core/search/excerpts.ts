import type {SearchHit} from "./provider.ts";

/**
 * Page text a provider already handed over, kept for the life of the process.
 *
 * This is what makes `read_source` cheap: Exa returns the text of a page in the search
 * response, so a URL the agent picked out of a result list can often be mined for figures
 * without a second request to anywhere. The owner chose that trade explicitly — see the
 * accepted-risk note in `provider.ts` — and its consequence is that this text has passed
 * none of `knowledge/fetch.ts`'s controls. It is capped twice: once in
 * `normalizeExaResponse`, once again in `figures.ts`.
 *
 * Deliberately not a `SearchProvider` method. A `read(url)` on the interface would be a
 * sanctioned way to fetch a page without the address guard, which is exactly the thing the
 * guard stops being a control the moment it exists. This only remembers what a search
 * *already* returned; it cannot go and get anything.
 *
 * In memory, not on disk. Nothing here is evidence — the source note a fact carries is
 * written when the owner approves it, and it survives a restart because it is a fact.
 */

/** Enough for a long session of searching. Insertion order is recency; the oldest go first. */
const MAX_ENTRIES = 200;

/**
 * Below this, fetching the page is the better answer.
 *
 * An excerpt is highlights joined, so a short one means the provider found little to
 * highlight rather than that the page is short. Two hundred characters cannot hold a figure
 * and the sentence around it plus who it belongs to.
 */
export const MIN_USEFUL_CHARS = 300;

export interface RememberedExcerpt {
  url: string;
  title: string;
  text: string;
  /** Which provider indexed it, so `read_source` can say where its text came from. */
  provider: string;
}

const remembered = new Map<string, RememberedExcerpt>();

/** Called by `search_web` once results have been shown to the agent, not by an adapter. */
export function rememberExcerpts(hits: readonly SearchHit[]): void {
  for (const hit of hits) {
    if (!hit.excerpt) continue;
    // Delete before set so a repeated URL moves to the back of the queue rather than
    // keeping its original position and ageing out while it is still being used.
    remembered.delete(hit.url);
    remembered.set(hit.url, {url: hit.url, title: hit.title, text: hit.excerpt, provider: hit.provider});
  }
  while (remembered.size > MAX_ENTRIES) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

/**
 * The remembered text for a URL, if there is enough of it to be worth reading.
 *
 * Exact URL match only. No normalising, no trailing-slash tolerance, no host-level lookup:
 * a near-match would mean handing over one page's text as another page's, which is a
 * misattributed source and the worst thing this could do.
 */
export function usableExcerptFor(url: string): RememberedExcerpt | undefined {
  const entry = remembered.get(url);
  return entry && entry.text.length >= MIN_USEFUL_CHARS ? entry : undefined;
}

/** For tests, and for anything that wants a clean slate. */
export const forgetExcerpts = () => remembered.clear();
