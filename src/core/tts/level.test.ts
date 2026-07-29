import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test, before, after} from "node:test";
import {promisify} from "node:util";
import {fadedOut, measureFade, MAX_FADE_DB} from "./level.ts";

const run = promisify(execFile);
let dir = "";

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "level-"));
});
after(async () => {
  await fs.rm(dir, {recursive: true, force: true});
});

/*
 * Levels chosen against the speech gate, not by eye. ffmpeg's `sine` is not full scale:
 * volume=1.0 lands at −21 dBFS and volume=0.35 at −30, which brackets real narration
 * (around −23) and keeps both sides above the 0.02 gate. An earlier version used 0.3 and
 * 0.1 — the quiet half fell to −41, under the gate, so it was discarded as silence and
 * the loud half was compared against itself for a reading of 0.0 dB.
 */
const LOUD = 1.0;
const QUIET = 0.35;

/** A tone at a given amplitude for a given number of seconds. */
const tone = (amp: number, seconds: number) =>
  ({input: `sine=f=200:d=${seconds}:r=24000`, filter: `volume=${amp}`});
const silence = (seconds: number) =>
  ({input: `anullsrc=r=24000:cl=mono:d=${seconds}`, filter: "volume=1"});

/** Build a wav by concatenating segments, so levels are exact rather than sampled. */
async function build(name: string, parts: {input: string; filter: string}[]) {
  const file = path.join(dir, `${name}.wav`);
  const inputs = parts.flatMap((part) => ["-f", "lavfi", "-i", part.input]);
  const chain = parts.map((part, i) => `[${i}:a]${part.filter}[s${i}]`).join(";");
  const concat = `${parts.map((_, i) => `[s${i}]`).join("")}concat=n=${parts.length}:v=0:a=1`;
  await run("ffmpeg", ["-y", "-v", "error", ...inputs,
    "-filter_complex", `${chain};${concat}`, "-ac", "1", file]);
  return file;
}

test("a level that holds reads as no fade", async () => {
  const file = await build("steady", [tone(LOUD, 6), tone(LOUD, 6)]);
  const fade = await measureFade(file);
  assert.ok(fade);
  assert.ok(Math.abs(fade.fadeDb) < 0.5, `expected ~0 dB, got ${fade.fadeDb.toFixed(2)}`);
  assert.equal(fadedOut(fade), false);
});

test("a level that drops is measured and flagged", async () => {
  // −21 to −30 dBFS: a 9 dB drop, comfortably past the threshold, both sides audible.
  const file = await build("fading", [tone(LOUD, 6), tone(QUIET, 6)]);
  const fade = await measureFade(file);
  assert.ok(fade);
  assert.ok(fade.fadeDb > 7 && fade.fadeDb < 11, `expected ~9 dB, got ${fade.fadeDb.toFixed(2)}`);
  assert.equal(fadedOut(fade), true);
});

test("trailing silence is not mistaken for fading out", async () => {
  // The regression this file exists for. Measuring fixed time windows averages silence
  // in with speech, so a take that simply pauses more toward the end reads as quieter
  // when the voice never changed — that measures pacing and calls it fading. Only frames
  // above the speech gate are compared, so this must come back flat.
  const file = await build("trailing", [tone(LOUD, 8), silence(4)]);
  const fade = await measureFade(file);
  assert.ok(fade);
  assert.ok(Math.abs(fade.fadeDb) < 0.5,
    `speech level never changed, but fade read ${fade.fadeDb.toFixed(2)} dB`);
  assert.equal(fadedOut(fade), false);
});

test("a rise is not a fade", async () => {
  // Only the direction that hurts counts. Getting louder is not a defect to re-roll.
  const file = await build("rising", [tone(QUIET, 6), tone(LOUD, 6)]);
  const fade = await measureFade(file);
  assert.ok(fade);
  assert.ok(fade.fadeDb < 0, "a rise must be negative");
  assert.equal(fadedOut(fade), false);
});

test("too little speech is unmeasurable rather than a guess", async () => {
  const file = await build("tiny", [tone(LOUD, 0.4), silence(0.2)]);
  assert.equal(await measureFade(file), null);
  assert.equal(fadedOut(null), false, "an unmeasurable take must not be treated as failed");
});

test("the threshold sits just outside what this model has ever done", () => {
  // Twenty-five real takes measured over speech frames: median drift under 2 dB, widest
  // 3.5 dB, none flagged. This is a tripwire for a change in behaviour, not a fix for a
  // defect — an earlier draft of this test claimed it caught a take a listener objected
  // to, which was false: that take is flat to a tenth of a decibel.
  assert.ok(MAX_FADE_DB > 3.5, "must clear the widest drift observed, or it fires on normal takes");
  assert.ok(MAX_FADE_DB < 6, "must still be tight enough to catch a real regression");
});
