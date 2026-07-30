import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {FROZEN_PSNR_DB, MAX_SAMPLED_WINDOWS, describeFrozen, framePsnr, parsePsnr} from "./motionGate.ts";
import {SAMPLE_SPACING_MS, type StillWindow} from "../compose/still.ts";
import {run} from "../util/exec.ts";

const window: StillWindow = {sectionId: "urteil", fromMs: 62_100, toMs: 64_180, kind: "gap", text: ""};

test("identical frames report inf, and inf is the answer rather than a parse failure", () => {
  // ffmpeg prints `average:inf` for a pixel-perfect match. Parsed as a plain number that
  // becomes NaN, which compares false against every threshold — so the one unambiguous
  // freeze there is would be the one case that sails through.
  assert.equal(parsePsnr("[Parsed_psnr_0 @ 0x1] PSNR r:inf g:inf b:inf average:inf min:inf max:inf"),
    Number.POSITIVE_INFINITY);
});

test("a real reading is parsed as a number", () => {
  assert.equal(
    parsePsnr("[Parsed_psnr_0 @ 0x1] PSNR r:13.96 g:14.47 b:13.99 average:14.137494 min:14.1 max:14.1"),
    14.137494,
  );
});

test("output with no PSNR line is NaN, not zero", () => {
  // Zero would read as "completely different" and quietly pass every frozen window in the
  // video. NaN fails the comparison and the window is skipped, which is the honest answer
  // when the measurement did not happen.
  assert.ok(Number.isNaN(parsePsnr("ffmpeg version 7.1\nConversion failed!")));
  assert.ok(Number.isNaN(parsePsnr("")));
});

test("ffmpeg measures two real images the way the calibration assumed", async () => {
  // Against ffmpeg itself, not a fixture: the whole threshold rests on what this command
  // returns, so a version that changed the output format has to fail here rather than turn
  // every window into a skipped measurement.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-gate-"));
  try {
    const grey = path.join(dir, "grey.png");
    const greyish = path.join(dir, "greyish.png");
    const black = path.join(dir, "black.png");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=64x64", "-frames:v", "1", "-y", grey]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x818181:s=64x64", "-frames:v", "1", "-y", greyish]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64", "-frames:v", "1", "-y", black]);

    assert.equal(await framePsnr(grey, grey), Number.POSITIVE_INFINITY, "identical files are not reported as identical");

    const barelyDifferent = await framePsnr(grey, greyish);
    assert.ok(barelyDifferent > FROZEN_PSNR_DB,
      `one level of difference reads as ${barelyDifferent}dB, below the frozen threshold`);

    const veryDifferent = await framePsnr(grey, black);
    assert.ok(veryDifferent < FROZEN_PSNR_DB,
      `mid-grey against black reads as ${veryDifferent}dB, above the frozen threshold`);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test("the threshold sits in the gap the calibration measured", () => {
  // 37.5 was the highest reading from a composition that passed the post-render freeze
  // check; 38.6 was the lowest from one that failed it. Moving this number in either
  // direction costs something real — down, a repair pass spent on work that was fine; up,
  // a render paid for before the defect is found — so the range is asserted, not the value.
  assert.ok(FROZEN_PSNR_DB > 37.5, "a composition that passed QC would now be sent back for repair");
  assert.ok(FROZEN_PSNR_DB <= 38.6, "the compositions that actually froze would no longer be caught");
});

test("a frozen finding names the scene, the reading and the frames to look at", () => {
  const message = describeFrozen({
    window,
    psnrDb: 44.1,
    frames: ["/w/.motion-check/frame-04-at-62.85s.png", "/w/.motion-check/frame-05-at-63.35s.png"],
  });
  assert.match(message, /scene-urteil/);
  assert.match(message, /44\.1dB/);
  assert.match(message, /frame-04-at-62\.85s\.png/, "the composer is not told which frames to open");
  assert.match(message, /frame-05-at-63\.35s\.png/);
  assert.match(message, new RegExp(`${SAMPLE_SPACING_MS / 1000}s apart`));
  assert.match(message, /area/, "the finding does not say what kind of motion registers");
});

test("pixel-identical frames are described as such, not as a decibel figure", () => {
  // `Infinity.toFixed(1)` is the string "Infinity", which reads as a measurement and is not
  // one. The clearest case has to produce the clearest sentence.
  const message = describeFrozen({window, psnrDb: Number.POSITIVE_INFINITY, frames: ["a.png", "b.png"]});
  assert.match(message, /pixel-identical/);
  assert.ok(!/Infinity/.test(message));
});

test("a browser that will not start is a warning, never a failed composition", () => {
  // Every other gate reads a file that is certainly there. This one drives headless Chrome,
  // and a machine without one is not a fault in the work — reporting it as an error would
  // send the composer off to repair something it did not do, and the repair budget is the
  // thing being protected here.
  const source = readFileSync(new URL("./check.ts", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("async function checkMotion"));
  const body = gate.slice(0, gate.indexOf("\nasync function"));
  assert.match(body, /catch\(/, "a snapshot failure propagates and fails the whole check");
  const failure = body.slice(body.indexOf("instanceof Error"), body.indexOf("sample.frozen"));
  assert.match(failure, /severity: "warning"/);
  assert.ok(!/severity: "error"/.test(failure));
});

test("a frame set that came back short is a failure, not zero freezes", () => {
  // How this gate first shipped broken, and it looked like it worked. The snapshot output
  // path was relative, the CLI resolved it against the composition instead of the project,
  // the frames landed somewhere nothing read, and every window was skipped for want of an
  // image — so three compositions with known freezes came back "0 frozen" and passed.
  const source = readFileSync(new URL("./motionGate.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.match(code, /frames\.length !== times\.length/, "a short frame set is treated as no findings");
  assert.match(code, /throw new Error/, "the shortfall is recorded rather than raised");
  assert.match(code, /unmeasured/, "a window ffmpeg could not read is silently counted as moving");
});

test("the snapshot output path is resolved before the CLI sees it", () => {
  // The CLI runs with `cwd` set to the composition, so a relative --output is taken
  // relative to *that* and the project prefix is repeated. Every caller would have to
  // remember; resolving once here is what makes it impossible to get wrong.
  const source = readFileSync(new URL("./hyperframes.ts", import.meta.url), "utf8");
  const snapshot = source.slice(source.indexOf("export async function renderSnapshots"));
  assert.match(snapshot, /path\.resolve\(outputDir\)/);
  const code = snapshot.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.ok(!/"--output", outputDir/.test(code), "the unresolved path still reaches the CLI");
});

test("the sampling cap is stated when it bites, not applied silently", () => {
  // A gate that quietly stops looking reads exactly like a gate that found nothing. Long
  // videos with short phrases are the case: a hundred windows is possible.
  const source = readFileSync(new URL("./motionGate.ts", import.meta.url), "utf8");
  assert.ok(MAX_SAMPLED_WINDOWS >= 40, "the cap is tighter than any measured video needs");
  assert.match(source, /skipped/, "nothing reports how many windows went unsampled");
  assert.match(source, /sort\(\(a, b\) => windowMs\(b\) - windowMs\(a\)\)/,
    "the cap drops arbitrary windows rather than keeping the longest");
});
