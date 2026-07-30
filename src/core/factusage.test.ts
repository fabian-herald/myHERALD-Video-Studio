import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {VIDEOS_DIR} from "./paths.ts";
import {readFileSync} from "node:fs";
import {amendLedgerEntry, factUsage, ledgerEntryZ, readLedger, upsertLedgerEntry, type LedgerEntry} from "./ledger.ts";

const LEDGER = path.join(VIDEOS_DIR, "index.json");

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ledgerEntryZ.parse({
  id: "x",
  title: "t",
  thesis: "th",
  intent: "thought-leadership",
  formats: ["9x16"],
  language: "en",
  createdAt: "2026-07-01T00:00:00.000Z",
  status: "ready",
  ...over,
});

/** Runs `body` against a temporary ledger, restoring the real one afterwards. */
async function withLedger(entries: LedgerEntry[], body: () => Promise<void>): Promise<void> {
  const original = await fs.readFile(LEDGER, "utf8").catch(() => null);
  await fs.mkdir(path.dirname(LEDGER), {recursive: true});
  await fs.writeFile(LEDGER, JSON.stringify(entries, null, 2), "utf8");
  try {
    await body();
  } finally {
    if (original === null) await fs.rm(LEDGER, {force: true});
    else await fs.writeFile(LEDGER, original, "utf8");
  }
}

test("an entry written before factIds existed still loads", async () => {
  // The ledger on disk predates this field. A default rather than a migration, because a
  // ledger that fails to parse loses the memory that prevents duplicate videos.
  await withLedger([], async () => {
    await fs.writeFile(LEDGER, JSON.stringify([{
      id: "old", title: "t", thesis: "th", intent: "thought-leadership",
      formats: ["9x16"], language: "en", createdAt: "2026-01-01T00:00:00.000Z", status: "ready",
    }]), "utf8");
    const entries = await readLedger();
    assert.equal(entries.length, 1, "an older entry was dropped instead of defaulted");
    assert.deepEqual(entries[0]?.factIds, []);
  });
});

test("nothing charted, nothing spent", async () => {
  await withLedger([entry({id: "a"})], async () => {
    assert.equal((await factUsage()).size, 0);
  });
});

test("a fact charted by two videos counts twice and keeps the later date", async () => {
  await withLedger([
    entry({id: "a", factIds: ["f-1"], createdAt: "2026-07-01T00:00:00.000Z"}),
    entry({id: "b", factIds: ["f-1", "f-2"], createdAt: "2026-07-20T00:00:00.000Z"}),
  ], async () => {
    const usage = await factUsage();
    assert.deepEqual(usage.get("f-1"), {count: 2, lastAt: "2026-07-20T00:00:00.000Z"});
    assert.deepEqual(usage.get("f-2"), {count: 1, lastAt: "2026-07-20T00:00:00.000Z"});
  });
});

test("the later date wins even when the ledger is out of order", async () => {
  await withLedger([
    entry({id: "b", factIds: ["f-1"], createdAt: "2026-07-20T00:00:00.000Z"}),
    entry({id: "a", factIds: ["f-1"], createdAt: "2026-07-01T00:00:00.000Z"}),
  ], async () => {
    assert.equal((await factUsage()).get("f-1")?.lastAt, "2026-07-20T00:00:00.000Z");
  });
});

test("a failed run does not spend a figure", async () => {
  // Nobody saw it. Retiring a number over a render that produced no file would quietly
  // shrink an already small pool.
  await withLedger([entry({id: "a", factIds: ["f-1"], status: "failed"})], async () => {
    assert.equal((await factUsage()).has("f-1"), false);
  });
});

test("re-running a video does not double-count its figures", async () => {
  // upsert replaces by id, so a rebuild of the same video must not read as two videos
  // having charted the number.
  await withLedger([], async () => {
    await upsertLedgerEntry(entry({id: "a", factIds: ["f-1"]}));
    await upsertLedgerEntry(entry({id: "a", factIds: ["f-1"], createdAt: "2026-07-25T00:00:00.000Z"}));
    assert.deepEqual((await factUsage()).get("f-1"), {count: 1, lastAt: "2026-07-25T00:00:00.000Z"});
  });
});

test("an edit that repairs a video clears its failed status", async () => {
  // The bug this half of the file exists for. `applyPlanEdits` re-narrates, re-renders and
  // re-runs QC, and wrote none of it back — so a video that failed its first render and was
  // then fixed by an edit read `failed` for good. Four of twelve entries said so while the
  // files on disk were fine, which is a failure rate the owner was treating as real.
  await withLedger([entry({id: "a", status: "failed"})], async () => {
    const amended = await amendLedgerEntry("a", {status: "ready"});
    assert.equal(amended?.status, "ready");
    assert.equal((await readLedger())[0]?.status, "ready");
  });
});

test("an edit never re-stamps the creation date", async () => {
  // The date is what factUsage reports as "last charted" and what the planner prints as how
  // recently a figure was spent. Moving it on a wording change would make an old video look
  // fresh and retire figures that were still free.
  await withLedger([entry({id: "a", factIds: ["f-1"], createdAt: "2026-01-05T00:00:00.000Z"})], async () => {
    await amendLedgerEntry("a", {status: "ready", spokenScript: "rewritten"});
    assert.equal((await readLedger())[0]?.createdAt, "2026-01-05T00:00:00.000Z");
    assert.equal((await factUsage()).get("f-1")?.lastAt, "2026-01-05T00:00:00.000Z");
  });
});

test("an edit leaves every other entry alone", async () => {
  await withLedger([entry({id: "a"}), entry({id: "b", title: "untouched"})], async () => {
    await amendLedgerEntry("a", {status: "stale"});
    const entries = await readLedger();
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.title, "untouched");
    assert.equal(entries[1]?.status, "ready");
  });
});

test("dropping the section that carried a figure releases it", async () => {
  // factIds are recomputed from the edited plan rather than merged. An edit that removes
  // the only chart using a number must give it back to the pool, or the figure stays
  // retired over a video that no longer shows it.
  await withLedger([entry({id: "a", factIds: ["f-1", "f-2"]})], async () => {
    await amendLedgerEntry("a", {factIds: ["f-2"]});
    const usage = await factUsage();
    assert.equal(usage.has("f-1"), false);
    assert.equal(usage.get("f-2")?.count, 1);
  });
});

test("amending a video the ledger has never seen changes nothing and says so", async () => {
  // A video made before the ledger existed. Inventing an entry would give it a creation
  // date that is simply wrong, and everything downstream would then use it as if it were real.
  await withLedger([entry({id: "a"})], async () => {
    assert.equal(await amendLedgerEntry("missing", {status: "ready"}), null);
    assert.equal((await readLedger()).length, 1);
  });
});

test("an edit that outruns the composition is stale, not ready", async () => {
  // The files render and may well pass QC, but the composition no longer says what the plan
  // says. Reporting that as ready is the same lie one step further along.
  const source = readFileSync(new URL("./pipeline/apply.ts", import.meta.url), "utf8");
  const record = source.slice(source.indexOf("async function recordEdit"));
  assert.match(record, /needsCompose\.length \? "stale" : "ready"/);
  assert.match(record, /!passed \? "failed"/, "a video that fails QC after an edit is not recorded as failed");
});
