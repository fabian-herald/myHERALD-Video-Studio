import assert from "node:assert/strict";
import {test} from "node:test";
import {MIN_USEFUL_CHARS, forgetExcerpts, rememberExcerpts, usableExcerptFor} from "./excerpts.ts";
import type {SearchHit} from "./provider.ts";

const hit = (url: string, excerpt?: string): SearchHit => ({
  title: `Page at ${url}`,
  url,
  snippet: "a snippet",
  provider: excerpt ? "exa" : "brave",
  ...(excerpt ? {excerpt} : {}),
});

const long = (marker: string) => `${marker} `.repeat(MIN_USEFUL_CHARS);

test("text a provider indexed is remembered against its exact URL", () => {
  forgetExcerpts();
  rememberExcerpts([hit("https://example.test/a", long("figures"))]);

  const found = usableExcerptFor("https://example.test/a");
  assert.equal(found?.provider, "exa");
  assert.ok(found?.text.startsWith("figures"));

  // Exact match only, deliberately. A trailing-slash tolerance would mean handing over one
  // page's text as another page's, which is a misattributed source.
  assert.equal(usableExcerptFor("https://example.test/a/"), undefined);
  assert.equal(usableExcerptFor("https://example.test/b"), undefined);
});

test("a hit with no page text is not remembered as if it had some", () => {
  forgetExcerpts();
  // Brave never sets `excerpt`. If this ever passed, read_source would mine Brave's own
  // description of a page and report it as the page's text.
  rememberExcerpts([hit("https://example.test/brave")]);
  assert.equal(usableExcerptFor("https://example.test/brave"), undefined);
});

test("too little text falls through to fetching instead", () => {
  forgetExcerpts();
  rememberExcerpts([hit("https://example.test/thin", "7.7% of revenue.")]);
  // Present but unusable: read_source treats this as a cache miss and goes through the
  // address guard, which is what keeps the guarded path live rather than dead code.
  assert.equal(usableExcerptFor("https://example.test/thin"), undefined);
});

test("a re-seen URL keeps its place at the back of the queue", () => {
  forgetExcerpts();
  rememberExcerpts([hit("https://example.test/first", long("first"))]);
  rememberExcerpts([hit("https://example.test/second", long("second"))]);
  rememberExcerpts([hit("https://example.test/first", long("again"))]);

  // Refreshed rather than left ageing in its original slot — the URL the agent keeps
  // searching for is the one it is about to read.
  assert.ok(usableExcerptFor("https://example.test/first")?.text.startsWith("again"));
  assert.ok(usableExcerptFor("https://example.test/second"));
});

test("the store does not grow without bound", () => {
  forgetExcerpts();
  // 250 URLs through a cap of 200. This runs for the life of the server process, so an
  // unbounded map would be a slow leak holding attacker-authored text.
  for (let index = 0; index < 250; index++) {
    rememberExcerpts([hit(`https://example.test/${index}`, long(`page${index}`))]);
  }
  assert.equal(usableExcerptFor("https://example.test/0"), undefined, "the oldest went first");
  assert.ok(usableExcerptFor("https://example.test/249"), "the newest is still there");
  forgetExcerpts();
});
