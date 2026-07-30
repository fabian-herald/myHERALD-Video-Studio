import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  STALE_AFTER_DAYS,
  findFigures,
  libraryStock,
  librarySourceZ,
  mergeSources,
  normaliseUrl,
  type SourceLibrary,
} from "./sourceLibrary.ts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const daysBefore = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const figure = (over: Record<string, unknown> = {}) => ({
  statement: "Content professionals spend 3.4 hours each day creating content.",
  attribution: "Kontent.ai survey, 2025",
  value: 3.4,
  unit: "hours",
  context: "On average, content professionals spend 3.4 hours each day creating content.",
  ...over,
});

const library = (...sources: unknown[]): SourceLibrary => ({
  schemaVersion: 1,
  updatedAt: NOW.toISOString(),
  sources: sources.map((source) => librarySourceZ.parse(source)),
});

const page = (over: Record<string, unknown> = {}) => ({
  url: "https://kontent.ai/blog/toolbox/",
  title: "The content creator's toolbox 2025",
  via: "exa-index",
  readAt: daysBefore(2),
  figures: [figure()],
  threadIds: ["t-1"],
  firstReadAt: daysBefore(2),
  ...over,
});

// — matching ————————————————————————————————————————————————

test("a figure is found by words the page used", () => {
  const hits = findFigures(library(page()), "hours spent creating content", NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.value, 3.4);
  assert.match(hits[0]?.context ?? "", /On average/, "the quoted sentence has to come back with it");
});

test("an unrelated question finds nothing", () => {
  assert.deepEqual(findFigures(library(page()), "email open rates", NOW), []);
});

test("an empty query is not a match-everything", () => {
  // "the of and" tokenises to nothing. Returning the whole shelf for it would read as
  // "we already have this" for any question at all.
  assert.deepEqual(findFigures(library(page()), "the of and", NOW), []);
});

test("one shared word out of three is not a hit", () => {
  // Live, "email open rate" came back holding a figure about conversion rate optimisation,
  // on the strength of "rate" alone. A false hit is worse than a miss here: it tells the
  // agent to stop looking for something the studio has not got, and the number it stops on
  // is about something else entirely.
  const cro = page({
    figures: [figure({
      statement: "Conversion Rate Optimization is the second-most-used optimization tactic.",
      value: 50,
      unit: "%",
      context: "Conversion Rate Optimization is the second-most-used optimization tactic at 50%.",
    })],
  });
  assert.deepEqual(findFigures(library(cro), "email open rate", NOW), []);
});

test("a one-word question can still match on that word", () => {
  // The floor is two shared words or every word there was — otherwise a single-term
  // question could never hit anything.
  assert.equal(findFigures(library(page()), "content", NOW).length, 1);
});

test("a figure is matched on the page title too", () => {
  // The words a video uses are rarely the words the page used, and the title often carries
  // the topic that neither the statement nor the quoted sentence spells out.
  const hits = findFigures(library(page()), "toolbox", NOW);
  assert.equal(hits.length, 1);
});

// — staleness ———————————————————————————————————————————————

test("a figure read within the year is not stale", () => {
  const hits = findFigures(library(page({readAt: daysBefore(STALE_AFTER_DAYS - 1)})), "content hours", NOW);
  assert.equal(hits[0]?.stale, false);
  assert.equal(hits[0]?.ageDays, STALE_AFTER_DAYS - 1);
});

test("a figure read over a year ago is offered as stale, not withheld", () => {
  // Withholding it would send the agent to search for something we already have; the
  // owner's call is whether a year-old read still stands.
  const hits = findFigures(library(page({readAt: daysBefore(400)})), "content hours", NOW);
  assert.equal(hits.length, 1, "a stale figure must still be offered");
  assert.equal(hits[0]?.stale, true);
});

test("fresh figures rank above stale ones, however well the stale one matches", () => {
  const stale = page({
    url: "https://old.example/survey",
    readAt: daysBefore(500),
    figures: [figure({statement: "Content professionals spend 3.4 hours each day creating content."})],
  });
  const fresh = page({
    url: "https://new.example/survey",
    readAt: daysBefore(3),
    figures: [figure({statement: "Teams lose 3.1 hours a day to content.", value: 3.1})],
  });
  const hits = findFigures(library(stale, fresh), "hours each day creating content", NOW);
  assert.equal(hits[0]?.url, "https://new.example/survey");
});

test("the attribution travels with the hit, because ageDays is the wrong clock", () => {
  // How long ago we read the page says nothing about how old the study is. A 2019 survey
  // read yesterday is fresh here and stale in every way that matters, so the credit line
  // — which names the study and its year — has to reach the agent.
  const hits = findFigures(library(page()), "content hours", NOW);
  assert.match(hits[0]?.attribution ?? "", /2025/);
});

// — stock ———————————————————————————————————————————————————

test("stock counts pages, figures and how many are still fresh", () => {
  const stock = libraryStock(library(page(), page({
    url: "https://old.example/x",
    readAt: daysBefore(500),
    figures: [figure({value: 9}), figure({value: 10})],
  })), NOW);
  assert.deepEqual(stock, {pages: 2, figures: 3, fresh: 1});
});

// — identity ————————————————————————————————————————————————

test("a trailing slash and a cased host are the same page", () => {
  assert.equal(
    normaliseUrl("https://Kontent.AI/blog/toolbox/"),
    normaliseUrl("https://kontent.ai/blog/toolbox"),
  );
});

test("a query string is a different page", () => {
  // Sites paginate and filter by query. Merging those would answer confidently about a
  // page nobody read.
  assert.notEqual(
    normaliseUrl("https://example.com/stats?year=2025"),
    normaliseUrl("https://example.com/stats?year=2019"),
  );
});

test("a tracking tag is not a different page", () => {
  // Found on the first backfill: the same Orbit Media article sat on the shelf twice, once
  // bare and once carrying a hubs_content tag off a HubSpot link, and its figures came back
  // duplicated in every search.
  assert.equal(
    normaliseUrl("https://www.orbitmedia.com/blog/blogging-statistics/?hubs_content=blog.hubspot.com"),
    normaliseUrl("https://www.orbitmedia.com/blog/blogging-statistics/"),
  );
  assert.equal(
    normaliseUrl("https://example.com/x?utm_source=news&gclid=abc"),
    normaliseUrl("https://example.com/x"),
  );
});

test("a tracking tag beside a real parameter leaves the real one alone", () => {
  assert.equal(
    normaliseUrl("https://example.com/stats?utm_medium=email&year=2025"),
    normaliseUrl("https://example.com/stats?year=2025"),
  );
});

test("the same parameters in a different order are one page", () => {
  assert.equal(
    normaliseUrl("https://example.com/x?b=2&a=1"),
    normaliseUrl("https://example.com/x?a=1&b=2"),
  );
});

test("something that is not a URL still compares to itself", () => {
  assert.equal(normaliseUrl("not a url/"), normaliseUrl("not a url"));
});

// — the invariant ————————————————————————————————————————————

test("the library cannot approve anything", () => {
  // It shows figures beside their state elsewhere, which makes it look like a shortcut to
  // usable. Exactly one path sets `approved`, and it is a click in the Brand screen.
  // Writers by name, not topic words: the module *mentions* propose_facts and approval on
  // purpose, in the comment that says this is not the place for either. An assertion that
  // cannot tell a call from the sentence documenting why there is no call would force the
  // explanation out of the file to stay green.
  const source = readFileSync(new URL("./sourceLibrary.ts", import.meta.url), "utf8");
  for (const forbidden of ["writeFacts", "readFacts", "saveResearch", "saveBrief"]) {
    assert.ok(!source.includes(forbidden), `sourceLibrary.ts reaches for ${forbidden}`);
  }
  assert.ok(!/\bstate\s*[:=]/.test(source), "sourceLibrary.ts sets a state");
});

// — folding a thread's reading into the shelf ——————————————————

const read = (over: Record<string, unknown> = {}) => ({
  url: "https://kontent.ai/blog/toolbox/",
  title: "The content creator's toolbox 2025",
  via: "exa-index",
  readAt: daysBefore(2),
  figures: [figure()],
  dropped: 0,
  statements: 0,
  ...over,
});

test("a page not seen before is filed with the thread that read it", () => {
  const shelf = library();
  mergeSources(shelf, "t-1", [read()]);
  assert.equal(shelf.sources.length, 1);
  assert.deepEqual(shelf.sources[0]?.threadIds, ["t-1"]);
  assert.equal(shelf.sources[0]?.firstReadAt, shelf.sources[0]?.readAt);
});

test("the same page read again does not duplicate the entry or its figures", () => {
  const shelf = library();
  mergeSources(shelf, "t-1", [read()]);
  mergeSources(shelf, "t-2", [read({url: "https://kontent.ai/blog/toolbox", readAt: daysBefore(1)})]);
  assert.equal(shelf.sources.length, 1, "the trailing slash made it a second page");
  assert.equal(shelf.sources[0]?.figures.length, 1, "an identical figure was stored twice");
  assert.deepEqual(shelf.sources[0]?.threadIds, ["t-1", "t-2"]);
});

test("a second read that finds more keeps both sets", () => {
  // Reading a page with a different `lookingFor` mines different numbers off the same text.
  // A later read that knew less must not shrink the shelf.
  const shelf = library();
  mergeSources(shelf, "t-1", [read()]);
  mergeSources(shelf, "t-2", [read({
    readAt: daysBefore(1),
    figures: [figure({statement: "People under 35 spend about 3.7 hours per day.", value: 3.7})],
  })]);
  assert.equal(shelf.sources[0]?.figures.length, 2);
});

test("the first read is remembered even when a later one arrives first", () => {
  const shelf = library();
  mergeSources(shelf, "t-1", [read({readAt: daysBefore(1)})]);
  mergeSources(shelf, "t-2", [read({readAt: daysBefore(30)})]);
  assert.equal(shelf.sources[0]?.readAt, daysBefore(1), "an older read overwrote the newest");
  assert.equal(shelf.sources[0]?.firstReadAt, daysBefore(30));
});

test("a page that failed once and worked later is not still marked unread", () => {
  const shelf = library();
  mergeSources(shelf, "t-1", [read({figures: [], error: "Response exceeds 750 KB."})]);
  assert.equal(shelf.sources[0]?.error, "Response exceeds 750 KB.");
  mergeSources(shelf, "t-2", [read({readAt: daysBefore(1)})]);
  assert.equal(shelf.sources[0]?.error, undefined, "three figures sit under a 'not read' label");
});

test("the shelf is ordered newest first", () => {
  const shelf = library();
  mergeSources(shelf, "t-1", [read({url: "https://a.example/", readAt: daysBefore(40)})]);
  mergeSources(shelf, "t-1", [read({url: "https://b.example/", readAt: daysBefore(3)})]);
  assert.equal(shelf.sources[0]?.url, "https://b.example/");
});
