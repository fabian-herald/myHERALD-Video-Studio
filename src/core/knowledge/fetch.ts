import {lookup} from "node:dns/promises";
import {isIP} from "node:net";

/**
 * A deliberately small HTTP client for one job: fetching pages the owner names, so the
 * studio can read a public website. It is not a general fetch wrapper.
 *
 * Everything here exists because this is the one place where a URL from outside the
 * machine turns into a request from inside it. A plain `fetch` would happily resolve
 * `http://169.254.169.254/` or `http://localhost:3000/admin` and hand the response back
 * as "research".
 */

const MAX_BYTES = 750_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

export interface FetchedDocument {
  finalUrl: string;
  contentType: string;
  body: string;
}

function privateAddress(address: string): boolean {
  if (address === "::1" || address === "::" || address.startsWith("fe80:")
    || address.startsWith("fc") || address.startsWith("fd")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  const [a, b] = parts as [number, number];
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Resolves the host and refuses anything that points inside the network. Re-run on
 * every redirect hop, because a public host is free to redirect to 127.0.0.1.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL. Include the scheme, e.g. https://myherald.io.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS can be fetched.");
  if (url.username || url.password) throw new Error("URLs with credentials in them are refused.");

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`${host} is a local address. Research only reads the public internet.`);
  }
  const addresses = isIP(host) ? [{address: host}] : await lookup(host, {all: true}).catch(() => []);
  if (!addresses.length) throw new Error(`${host} does not resolve.`);
  if (addresses.some(({address}) => privateAddress(address))) {
    throw new Error(`${host} resolves to a private address. Research only reads the public internet.`);
  }
  return url;
}

/** Streams with a hard byte ceiling, so a chunked endpoint cannot exhaust memory. */
async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("Response exceeds 750 KB.");
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Response exceeds 750 KB.");
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

export async function fetchPublic(
  raw: string,
  accept: readonly string[] = ["text/html", "application/xhtml+xml"],
): Promise<FetchedDocument> {
  let url = await assertPublicUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: `${accept.join(",")},*/*;q=0.1`,
        "user-agent": "myHERALD-Video-Studio/1.0 (+brand research, owner-initiated)",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === MAX_REDIRECTS) throw new Error(`${url.host} redirected more than ${MAX_REDIRECTS} times.`);
      const location = response.headers.get("location");
      if (!location) throw new Error(`${url.host} sent a redirect without a destination.`);
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) throw new Error(`${url.host} returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!accept.some((type) => contentType.includes(type))) {
      throw new Error(`${url.pathname} is ${contentType.split(";")[0] || "an unknown type"}, expected ${accept[0]}.`);
    }
    return {finalUrl: url.toString(), contentType, body: await readLimited(response)};
  }
  throw new Error(`${raw} could not be loaded.`);
}
