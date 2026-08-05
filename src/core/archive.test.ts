// First, and before anything that reads a path — see the module's own note.
import "./sandbox.testenv.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {deleteVideo, setVideoArchived} from "./archive.ts";
import {activeLedger, factUsage, ledgerEntryZ, readLedger, similarTheses, type LedgerEntry} from "./ledger.ts";
import {OUT_DIR, VIDEOS_DIR} from "./paths.ts";
import {STUDIO_THREAD_ID, THREADS_DIR, loadThread, saveThread, setThreadArchived} from "./threads.ts";

const LEDGER = path.join(VIDEOS_DIR, "index.json");

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ledgerEntryZ.parse({
  id: "x",
  title: "t",
  thesis: "the bottleneck is judgement, not volume",
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

test("an archived video stays in the ledger but leaves the studio's memory", async () => {
  await withLedger([entry({id: "t-archive-memory", factIds: ["f-1"]})], async () => {
    await setVideoArchived("t-archive-memory", true);

    assert.equal((await readLedger()).length, 1, "archiving must not delete the entry");
    assert.equal((await activeLedger()).length, 0);
    // Both halves matter: a throwaway test should not block the real video on that thesis,
    // and it should not have spent the figures it charted either.
    assert.equal((await similarTheses("judgement bottleneck volume")).length, 0);
    assert.equal((await factUsage()).has("f-1"), false);
  });
});

test("restoring puts the video back into what the planner counts as covered", async () => {
  await withLedger([entry({id: "t-archive-restore", factIds: ["f-1"]})], async () => {
    await setVideoArchived("t-archive-restore", true);
    await setVideoArchived("t-archive-restore", false);

    assert.equal((await activeLedger()).length, 1);
    assert.equal((await similarTheses("judgement bottleneck volume")).length, 1);
    assert.equal((await factUsage()).get("f-1")?.count, 1);
  });
});

test("archiving an id the ledger does not hold reports nothing rather than inventing it", async () => {
  await withLedger([], async () => {
    assert.equal(await setVideoArchived("t-archive-missing", true), null);
  });
});

test("deleting a video takes its entry, its workdir and its rendered output", async () => {
  const id = "t-archive-delete";
  const workdir = path.join(VIDEOS_DIR, id);
  const output = path.join(OUT_DIR, id);

  await withLedger([entry({id})], async () => {
    await fs.mkdir(workdir, {recursive: true});
    await fs.writeFile(path.join(workdir, "plan.json"), "{}", "utf8");
    await fs.mkdir(output, {recursive: true});
    await fs.writeFile(path.join(output, "video.mp4"), "", "utf8");

    try {
      const result = await deleteVideo(id);
      assert.equal(result.removed, true);
      assert.deepEqual(result.deleted, {ledger: true, workdir: true, output: true, thread: false});
      assert.equal((await readLedger()).length, 0);
      assert.equal(await fs.stat(workdir).then(() => true, () => false), false);
      assert.equal(await fs.stat(output).then(() => true, () => false), false);
    } finally {
      await fs.rm(workdir, {recursive: true, force: true});
      await fs.rm(output, {recursive: true, force: true});
    }
  });
});

test("deleting an id the ledger does not hold is reported, not pretended", async () => {
  await withLedger([], async () => {
    assert.equal((await deleteVideo("t-archive-absent")).removed, false);
  });
});

test("archiving a thread does not restamp when it was last worked on", async () => {
  const id = "t-archive-thread";
  await saveThread({
    schemaVersion: 1,
    id,
    kind: "video",
    title: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessions: {},
    messages: [],
  });

  try {
    // saveThread stamps `updatedAt` on write, so read back what it actually recorded.
    const before = (await loadThread(id))?.updatedAt;
    const archived = await setThreadArchived(id, true);
    assert.ok(archived?.archivedAt, "the thread was not marked archived");
    assert.equal(archived?.updatedAt, before, "archiving moved the thread up the rail");

    const restored = await setThreadArchived(id, false);
    assert.equal(restored?.archivedAt, undefined);
    assert.equal((await loadThread(id))?.archivedAt, undefined, "the flag survived on disk");
  } finally {
    await fs.rm(path.join(THREADS_DIR, `${id}.json`), {force: true});
  }
});

test("the studio thread cannot be archived away", async () => {
  assert.equal(await setThreadArchived(STUDIO_THREAD_ID, true), null);
});
