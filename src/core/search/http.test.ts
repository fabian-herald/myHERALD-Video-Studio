import assert from "node:assert/strict";
import {afterEach, test} from "node:test";
import {searchFetch} from "./http.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a scripted sequence, recording what it was called with. */
function stubFetch(responses: (Response | (() => Response | Promise<Response>))[]) {
  const calls: {url: string; init: RequestInit}[] = [];
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(input), init: init ?? {}});
    const next = responses[Math.min(index++, responses.length - 1)];
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}, ...init});

test("a successful call returns parsed JSON", async () => {
  stubFetch([json({results: [{url: "https://ok.test"}]})]);
  const payload = await searchFetch("https://api.example.test/search", {headers: {}});
  assert.deepEqual(payload, {results: [{url: "https://ok.test"}]});
});

test("a 429 is retried, honouring Retry-After, then succeeds", async () => {
  // The one status where retrying is both correct and expected — a search vendor rate-limits
  // an interactive burst and tells you when to come back.
  const calls = stubFetch([
    () => new Response("slow down", {status: 429, headers: {"retry-after": "0"}}),
    () => json({results: []}),
  ]);
  assert.deepEqual(await searchFetch("https://api.example.test/s", {headers: {}}), {results: []});
  assert.equal(calls.length, 2);
});

test("a 5xx is retried and gives up with a message naming the host", async () => {
  const calls = stubFetch([() => new Response("boom", {status: 503})]);
  await assert.rejects(
    () => searchFetch("https://api.example.test/s", {headers: {}, attempts: 2}),
    /api\.example\.test could not be reached.*503/s,
  );
  assert.equal(calls.length, 2, "attempts must be honoured exactly");
});

test("a 400 is not retried", async () => {
  // A malformed request cannot be fixed by sending it again; retrying only spends quota
  // discovering that three times. The vendor's own error body is surfaced instead, because
  // it usually names the offending parameter.
  const calls = stubFetch([() => new Response("bad freshness value", {status: 400})]);
  await assert.rejects(
    () => searchFetch("https://api.example.test/s", {headers: {}}),
    /HTTP 400.*bad freshness value/s,
  );
  assert.equal(calls.length, 1);
});

test("a 401 is not retried either", async () => {
  const calls = stubFetch([() => new Response("invalid key", {status: 401})]);
  await assert.rejects(() => searchFetch("https://api.example.test/s", {headers: {}}), /HTTP 401/);
  assert.equal(calls.length, 1, "a bad key does not become valid on the second try");
});

test("a declared content-length over the cap rejects before reading a byte", async () => {
  stubFetch([() => new Response("{}", {status: 200, headers: {"content-length": "9000000"}})]);
  await assert.rejects(
    () => searchFetch("https://api.example.test/s", {headers: {}, maxBytes: 1_000}),
    /over the 1000 limit/,
  );
});

test("a body that streams past the cap is cancelled rather than buffered", async () => {
  // The cap that actually holds. `content-length` is a claim; a vendor streaming an unbounded
  // response — Exa with contents.text has no ceiling at source — would otherwise be read
  // into memory in full before anyone noticed.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(512)));
    },
    cancel() {
      cancelled = true;
    },
  });
  stubFetch([() => new Response(stream, {status: 200})]);

  await assert.rejects(
    () => searchFetch("https://api.example.test/s", {headers: {}, maxBytes: 2_000}),
    /exceeded the 2000 byte limit/,
  );
  assert.equal(cancelled, true, "the stream must be cancelled, not left to drain");
});

test("a caller's abort rejects promptly and does not retry", async () => {
  // An aborted agent turn should stop the search, not leave three attempts running into a
  // response nobody will read.
  const controller = new AbortController();
  const calls = stubFetch([() => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  }]);

  await assert.rejects(
    () => searchFetch("https://api.example.test/s", {headers: {}, signal: controller.signal}),
    /cancelled/,
  );
  assert.equal(calls.length, 1);
});

test("headers and body reach fetch unchanged", async () => {
  // The key travels in a header. If this plumbing were wrong the failure would look like an
  // authentication problem with the vendor rather than a bug here.
  const calls = stubFetch([json({})]);
  await searchFetch("https://api.example.test/s", {
    method: "POST",
    headers: {"x-api-key": "secret", "content-type": "application/json"},
    body: '{"query":"q"}',
  });
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["x-api-key"], "secret");
  assert.equal(calls[0]?.init.body, '{"query":"q"}');
  assert.ok(calls[0]?.init.signal, "a signal must always be attached, so no call can hang forever");
});
