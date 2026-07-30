import assert from "node:assert/strict";
import {test} from "node:test";
import {normalizeBraveResponse} from "./brave.ts";

/** Shaped after a real response, trimmed to the fields the adapter reads. */
const CANNED = {
  web: {
    results: [
      {
        title: "CMO Spend Survey 2024",
        url: "https://example.test/report",
        description: "Marketing budgets fell to 7.7% of revenue.",
        extra_snippets: ["Down from 9.1% the year before.", "Based on 395 respondents."],
      },
      {title: "A page with no description", url: "https://example.test/bare"},
    ],
  },
};

test("a canned response normalises to hits attributed to brave", () => {
  const hits = normalizeBraveResponse(CANNED);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.provider, "brave");
  assert.equal(hits[0]?.url, "https://example.test/report");
  assert.match(hits[0]?.snippet ?? "", /7\.7% of revenue/);
});

test("Brave never produces an excerpt", () => {
  // The single most important assertion in this file. Brave does not index page text, and an
  // excerpt a caller cannot tell apart from a snippet is one nobody can judge the weight of.
  // `extra_snippets` are Brave's own summaries and belong in `snippet`, appended.
  for (const hit of normalizeBraveResponse(CANNED)) {
    assert.equal(hit.excerpt, undefined, `${hit.url} carries an excerpt`);
    assert.equal(hit.publishedDate, undefined, "Brave does not date its results");
  }
  assert.match(normalizeBraveResponse(CANNED)[0]?.snippet ?? "", /395 respondents/,
    "extra_snippets must reach the snippet, not be dropped");
});

test("a result missing description yields an empty snippet, not the word undefined", () => {
  // `description` is genuinely optional in Brave's shape. Letting `undefined` through renders
  // as the literal string "undefined" once the hit is JSON.stringified into a tool payload.
  const hits = normalizeBraveResponse(CANNED);
  assert.equal(hits[1]?.snippet, "");
  assert.ok(!JSON.stringify(hits).includes("undefined"));
});

test("a result with no url is dropped rather than carried as an empty link", () => {
  // A hit the agent cannot act on is worse than one fewer hit: it will try to read it.
  const hits = normalizeBraveResponse({web: {results: [{title: "orphan"}, {url: "https://ok.test"}]}});
  assert.deepEqual(hits.map((hit) => hit.url), ["https://ok.test"]);
});

test("a shape that is not a Brave response yields no hits rather than throwing", () => {
  // An error page, a rate-limit body, or a changed API all arrive here as some other JSON.
  // Returning nothing lets the tool say "no results"; throwing makes it look like a bug.
  for (const payload of [null, undefined, {}, {web: {}}, {web: {results: "nope"}}, []]) {
    assert.deepEqual(normalizeBraveResponse(payload), []);
  }
});

test("a snippet is capped, so one verbose result cannot dominate the payload", () => {
  const long = {web: {results: [{
    title: "t", url: "https://example.test/x",
    description: "x".repeat(400),
    extra_snippets: ["y".repeat(400), "z".repeat(400)],
  }]}};
  assert.ok((normalizeBraveResponse(long)[0]?.snippet.length ?? 0) <= 500);
});

test("Brave's own match markup is removed from the snippet", () => {
  // Measured against a real response: Brave wraps matched query terms in <strong>, so a
  // description arrives as `plateaued at <strong>7.7%</strong>`. Readability only — see the
  // comment on stripMatchMarkup for why this is deliberately not a sanitiser.
  const hits = normalizeBraveResponse({web: {results: [{
    title: "t", url: "https://example.test/x",
    description: "plateaued at <strong>7.7%</strong> of revenue",
  }]}});
  assert.equal(hits[0]?.snippet, "plateaued at 7.7% of revenue");
});

test("other markup in a snippet is left alone", () => {
  // Pins the narrowness. If this ever starts stripping <script> it will read as a security
  // control, and the next person will rely on it as one.
  const hits = normalizeBraveResponse({web: {results: [{
    title: "t", url: "https://example.test/x", description: "<em>x</em> <script>y</script>",
  }]}});
  assert.equal(hits[0]?.snippet, "<em>x</em> <script>y</script>");
});
