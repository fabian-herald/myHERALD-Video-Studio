/**
 * JSON over HTTPS to a search vendor: timeout, byte ceiling, and a retry that only retries
 * what is worth retrying.
 *
 * **This deliberately does not go through `knowledge/fetch.ts`.** That module says so itself
 * — "one job: fetching pages the owner names… not a general fetch wrapper" — and routing a
 * vendor call through it would be worse than useless here: the endpoint is a literal in our
 * source rather than attacker-influenced, so its DNS guard protects nothing, and its
 * content-type assertion rejects `application/json` outright. The guard belongs on the path
 * from a search *result* to a fetched page, which is where it stays.
 *
 * Scoped to `search/` rather than promoted to `util/http.ts`. Two sibling callers born the
 * same day with the same shape is a helper; three areas needing it would make it a utility.
 * The Gemini retry stays private for a related reason — it parses Gemini's own reported
 * delay out of an error string, where Brave and Exa report backoff in headers, and a
 * repo-wide helper would either ignore those or accumulate a parser per vendor.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Exa with `contents.text` is unbounded at source, so the ceiling is ours to set. Generous
 * next to a JSON payload of ten results and far short of a response that could exhaust
 * memory.
 */
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_ATTEMPTS = 3;

export interface SearchFetchOptions {
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Per call, because a deep search legitimately takes longer than a shallow one. */
  timeoutMs?: number;
  maxBytes?: number;
  attempts?: number;
}

export async function searchFetch(url: string, options: SearchFetchOptions): Promise<unknown> {
  const {
    method = "GET",
    headers,
    body,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    attempts = DEFAULT_ATTEMPTS,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // The caller's abort and our timeout, composed — so an aborted agent turn cancels an
    // in-flight search rather than leaving it to finish into a void.
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(url, {method, headers, body, signal: composed});
    } catch (cause) {
      // A caller-initiated abort is a decision, not a failure to retry into.
      if (signal?.aborted) throw new Error("Search cancelled.");
      lastError = cause as Error;
      if (attempt === attempts) break;
      await wait(backoffMs(null, attempt), signal);
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`${new URL(url).host} returned HTTP ${response.status}.`);
      if (attempt === attempts) break;
      await wait(backoffMs(response, attempt), signal);
      continue;
    }

    // Anything else is the vendor telling us the request was wrong. Retrying a 400 or a 401
    // cannot fix it and spends quota finding that out three times.
    if (!response.ok) {
      throw new Error(
        `${new URL(url).host} returned HTTP ${response.status}. ${await errorDetail(response)}`.trim(),
      );
    }

    return JSON.parse(await readLimited(response, maxBytes)) as unknown;
  }

  throw new Error(`${new URL(url).host} could not be reached: ${lastError?.message ?? "unknown"}`);
}

/**
 * Honour the vendor's own backoff when it sends one.
 *
 * `Retry-After` is seconds or an HTTP date; Brave and Exa both use the seconds form. Falling
 * back to a linear ramp rather than exponential because a search is interactive — the owner
 * is watching a run log, and a 16-second third attempt reads as a hang.
 */
function backoffMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
  return attempt * 1200;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Search cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Search cancelled."));
    }, {once: true});
  });

/** A few hundred characters of the vendor's error body, which usually says what was wrong. */
async function errorDetail(response: Response): Promise<string> {
  return response.text().then((text) => text.slice(0, 300).replace(/\s+/g, " ").trim()).catch(() => "");
}

/**
 * Read with a hard ceiling, cancelling the stream rather than buffering past it.
 *
 * Same shape as `readLimited` in `knowledge/fetch.ts`. Checking the declared length first is
 * the cheap path; streaming with a running total is the one that actually holds, because
 * `content-length` is a claim.
 */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`Response is ${declared} bytes, over the ${maxBytes} limit.`);
  }

  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${maxBytes} byte limit.`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}
