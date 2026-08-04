import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {adaptationFraming} from "../gen/composer.ts";

const run = () => readFileSync(new URL("./run.ts", import.meta.url), "utf8");

/**
 * A video wanted on LinkedIn and on Instagram used to be two independent compose passes on
 * one script, which produced two different videos that happened to say the same words — and
 * a visual correction to one did nothing for the other. That is the opposite of the thing
 * the owner asked for: author and correct once, publish everywhere.
 *
 * One authored composition cannot serve both shapes; a five-row vertical stack is a squat
 * band at 1920×1080. So the second family is still authored, but from the first one.
 */

test("the reference family is composed before the family that re-lays it", () => {
  const source = run();
  // Map order follows plan.formats, so a plan listing 16x9 first would otherwise adapt
  // portrait from landscape — backwards, since portrait is the authored reference format.
  assert.match(source, /const families = \[\.\.\.byFamily\(plan\.formats\)\]/);
  assert.match(source, /\.sort\(\(\[a\], \[b\]\) =>/);
  assert.match(source, /adaptFrom: composedReference \?\? undefined/);
});

test("the source composition is copied in before the composer runs", () => {
  // Not attached to the prompt as text. A composer that can Read and Edit the real files
  // makes a smaller, truer change — and if it stops early, what is on disk is the source
  // composition at the wrong size rather than nothing at all.
  const flow = run().slice(run().indexOf("export async function composeWithRepair"));
  assert.match(flow, /for \(const file of COMPOSITION_FILES\) \{\s*await fs\.copyFile\(/);
  assert.match(flow, /re-laying the \$\{adaptFrom\.family\} composition/);
});

test("an adaptation is told to keep the timings, the copy and the motion", () => {
  const framing = adaptationFraming({fromFamily: "portrait", fromWidth: 1080, fromHeight: 1920});
  assert.match(framing, /1080×1920/);
  assert.match(framing, /re-lay that composition for this canvas, not to design a new one/);
  // The three things that must not drift, because the narration is already cut to them.
  assert.match(framing, /every `data-start` and `data-duration` stays exactly as it is/);
  assert.match(framing, /same on-screen copy/);
  assert.match(framing, /Keep the motion/);
  // And the one thing a wider canvas invites: fewer, bigger elements.
  assert.match(framing, /Density must not drop/);
});

test("an adaptation is not pointed at the exemplar", () => {
  // The exemplar is a reference for a *different* video. Showing it to a pass whose job is
  // to stay faithful to this one invites exactly the drift the adaptation exists to prevent.
  for (const file of ["../gen/codexComposer.ts", "../gen/claudeComposer.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /context\.adaptation \? adaptationFraming\(context\.adaptation\) : EXEMPLAR_FRAMING/,
      file,
    );
  }
});
