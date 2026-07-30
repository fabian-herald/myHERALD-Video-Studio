import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {VIDEOS_DIR} from "./paths.ts";
import {factUsage, ledgerEntryZ, readLedger, upsertLedgerEntry, type LedgerEntry} from "./ledger.ts";

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
