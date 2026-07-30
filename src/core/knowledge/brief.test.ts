import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {
  RESEARCH_DIR,
  loadResearch,
  recordQuery,
  recordSource,
  researchRecordZ,
  saveBrief,
} from "./brief.ts";

/**
 * These write to the real research directory, under thread ids no thread will ever have, and
 * clean up after themselves. Mocking the filesystem here would test the mock: the whole point
 * of the module is that two concurrent writers do not lose each other's work on disk.
 */
const threadId = (name: string) => `test-brief-${name}`;

async function cleanup(name: string) {
  await fs.rm(path.join(RESEARCH_DIR, `${threadId(name)}.json`), {force: true});
}

const source = (url: string) => ({
  url,
  title: "The CMO Survey",
  via: "exa-index",
  figures: [{
    statement: "Marketing budgets sat at 7.7% of revenue.",
    attribution: "CMO Survey, 2025",
    value: 7.7,
    unit: "%",
    context: "Marketing budgets plateaued at 7.7% of company revenue.",
  }],
  dropped: 0,
  statements: 0,
});

test("a thread with no research reads as absent, not as an error", async () => {
  // The Sources tab asks for this on every thread, including ones where nobody has searched
  // for anything. Null rather than a throw, so the empty state is a normal state.
  assert.equal(await loadResearch(threadId("never-used")), null);
});

test("queries and sources accumulate, and a page read twice stays one source", async () => {
  const id = threadId("accumulate");
  await cleanup("accumulate");
  try {
    await recordQuery(id, {query: "marketing spend share of revenue", provider: "exa", hits: 4});
    await recordQuery(id, {query: "cmo survey 2025 budget", provider: "brave", hits: 0});
    await recordSource(id, source("https://cmosurvey.org/report.pdf"));
    await recordSource(id, source("https://cmosurvey.org/report.pdf"));

    const record = await loadResearch(id);
    assert.equal(record?.queries.length, 2);
    // A query that found nothing is kept. It is the part of a trail nobody writes down
    // voluntarily and the part that shows how hard a number was to find.
    assert.equal(record?.queries[1]?.hits, 0);
    assert.equal(record?.sources.length, 1, "the same URL is one source, not two");
    assert.equal(record?.sources[0]?.figures.length, 1);
  } finally {
    await cleanup("accumulate");
  }
});

test("two writes landing together do not erase each other", async () => {
  // The race this module exists to remove. The agent may run tools in parallel, and
  // read-modify-write on one JSON file means two read_source calls finishing together would
  // each load the record as it was before either — and the second write would drop the first
  // page. Not theoretical: parallel tool calls are the SDK's default behaviour.
  const id = threadId("race");
  await cleanup("race");
  try {
    await Promise.all([
      recordSource(id, source("https://one.test/a")),
      recordSource(id, source("https://two.test/b")),
      recordQuery(id, {query: "first", provider: "exa", hits: 1}),
      recordQuery(id, {query: "second", provider: "exa", hits: 2}),
      saveBrief(id, {question: "What share of revenue goes to marketing?", findings: ["7.7%, per the CMO Survey."], gaps: []}),
    ]);

    const record = await loadResearch(id);
    assert.equal(record?.sources.length, 2, "a source was lost");
    assert.equal(record?.queries.length, 2, "a query was lost");
    assert.ok(record?.brief, "the brief was lost");
  } finally {
    await cleanup("race");
  }
});

test("the brief keeps gaps as first-class content", async () => {
  const id = threadId("gaps");
  await cleanup("gaps");
  try {
    await saveBrief(id, {
      question: "How many teams ship video weekly?",
      findings: [],
      gaps: ["No survey covers weekly cadence — only monthly."],
    });
    const record = await loadResearch(id);
    // A brief that could only hold findings would have nowhere to put "I could not source
    // this", which is the sentence that stops a number being invented three weeks later.
    assert.equal(record?.brief?.findings.length, 0);
    assert.equal(record?.brief?.gaps.length, 1);
    assert.ok(record?.brief?.writtenAt);
  } finally {
    await cleanup("gaps");
  }
});

test("a thread id that is not one is refused, not cleaned up", async () => {
  // Written expecting a throw, and the first version did not throw: stripping the unsafe
  // characters left `etcpasswd`, a valid id for a different record. The traversal was
  // neutralised and the question silently became about another file — safe, and wrong.
  await assert.rejects(() => loadResearch("../../etc/passwd"), /not a usable thread id/);
  await assert.rejects(() => recordQuery("a/b", {query: "q", provider: "exa", hits: 1}), /not a usable thread id/);
});

test("a stored record round-trips through its own schema", () => {
  // The record is read back by the server and handed to the browser, so a shape change that
  // silently drops a field would show up as an empty Sources tab rather than as an error.
  const parsed = researchRecordZ.safeParse({
    schemaVersion: 1,
    threadId: "t",
    updatedAt: new Date(0).toISOString(),
    queries: [{at: new Date(0).toISOString(), query: "q", provider: "exa", hits: 1}],
    sources: [{...source("https://a.test"), readAt: new Date(0).toISOString()}],
  });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(parsed.data?.sources[0]?.figures[0]?.value, 7.7);
});
