import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {masterNarration} from "./master.ts";
import {run} from "../util/exec.ts";

/**
 * Real ffmpeg, real files, deliberately.
 *
 * The bug this file exists for was not in any logic — it was in whether an ffmpeg call
 * happened at all. Mocked out, the test would assert the mock and pass either way; what
 * has to be true is that the audio on disk is the audio that was asked for.
 */
async function tone(file: string, seconds: number): Promise<void> {
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:a", "pcm_s16le", file,
  ]);
}

const near = (actual: number, expected: number, slack = 0.35) =>
  Math.abs(actual - expected) <= slack;

test("a second narration is not given the first one's audio", async (t) => {
  // The shipped bug, reduced. masterNarration skipped whenever the output merely existed,
  // and the output name is fixed per video — so re-narrating handed back the previous
  // take, along with its duration, which the caller then retimed the whole plan against.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "master-"));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const first = path.join(dir, "first.wav");
  const second = path.join(dir, "second.wav");
  const master = path.join(dir, "narration.m4a");

  await tone(first, 2);
  await tone(second, 5);

  const one = await masterNarration(first, master);
  assert.ok(near(one, 2), `first master should be ~2s, got ${one}`);

  const two = await masterNarration(second, master);
  assert.ok(near(two, 5), `the master still held the first take: ${two}s instead of ~5s`);
  assert.ok(near(await probe(master), 5), "the file on disk is still the old audio");
});

test("the same input twice does not re-encode", async (t) => {
  // The reason the skip exists. Re-running the pipeline over unchanged narration should
  // not burn an ffmpeg pass, and the file must be left exactly as it was.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "master-"));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const input = path.join(dir, "in.wav");
  const master = path.join(dir, "narration.m4a");
  await tone(input, 2);

  await masterNarration(input, master);
  const first = await fs.stat(master);
  await masterNarration(input, master);
  const second = await fs.stat(master);

  assert.equal(second.mtimeMs, first.mtimeMs, "the master was re-encoded for no reason");
});

test("a requested end hold is materialised in the mastered audio", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "master-"));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const input = path.join(dir, "in.wav");
  const master = path.join(dir, "narration.m4a");
  await tone(input, 2);

  const duration = await masterNarration(input, master, 1, 2_650);
  assert.ok(duration >= 2.6, `the 650ms landing space was cut to ${duration.toFixed(3)}s`);
});

test("the same audio at a different volume is re-encoded", async (t) => {
  // The input file is identical, so hashing it alone would say "already done" and hand back
  // a master mixed at the wrong level.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "master-"));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const input = path.join(dir, "in.wav");
  const master = path.join(dir, "narration.m4a");
  await tone(input, 2);

  await masterNarration(input, master, 1);
  const loud = await fs.stat(master);
  await masterNarration(input, master, 0.2);
  const quiet = await fs.stat(master);

  assert.notEqual(quiet.mtimeMs, loud.mtimeMs, "the level change was skipped as a cache hit");
});

async function probe(file: string): Promise<number> {
  const {stdout} = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return Number(stdout.trim());
}
