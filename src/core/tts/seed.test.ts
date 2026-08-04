import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {brandKitZ} from "../brand/kit.ts";
import {videoPlanZ} from "../plan/schema.ts";

/**
 * Measured, on one script, ten takes:
 *
 *   seed 7, fixed   121, 121, 121, 121, 114 Hz   1.02 semitones apart
 *   no seed          138, 127, 113, 138, 123 Hz   3.50 semitones apart
 *
 * Four of five identical. That is what "the model makes a best effort to provide the same
 * response for repeated requests" buys, and it is the difference between two videos
 * sounding like one narrator and sounding like two.
 */

test("a brand may fix which narrator it gets, and defaults to not fixing one", () => {
  const kit = brandKitZ.parse(JSON.parse(readFileSync(
    new URL("../../../data/brand/kit.json", import.meta.url), "utf8")));
  assert.equal(typeof kit.voice.narratorSeed, "number");
  // Zero means the model chooses, which is every video made before this existed. Nothing
  // is pinned until someone has listened to the candidates and decided.
  assert.ok(kit.voice.narratorSeed >= 0);
});

test("the plan records the seed the take was requested with", () => {
  // Without it a video is not reproducible: the same script at a different seed is a
  // different performance, and provenance would be describing audio it cannot recreate.
  const plan = videoPlanZ.parse({
    schemaVersion: 1, id: "x", createdAt: "2026-08-04T00:00:00.000Z", brief: "b",
    intent: "thought-leadership", formats: ["9x16"], language: "en",
    title: "T", thesis: "t", alternates: [],
    sections: [{
        id: "hook", kind: "hook", intentNote: "", energy: "settled",
        onScreen: "A line", phrases: [{id: "p1", text: "One."}],
      }, {
        id: "payoff", kind: "hook", intentNote: "", energy: "settled",
        onScreen: "A line", phrases: [{id: "p1", text: "One."}],
      }],
    narration: {provider: "gemini", voice: "Achird", seed: 7},
  });
  assert.equal(plan.narration.seed, 7);
  assert.equal(videoPlanZ.parse({
    schemaVersion: 1, id: "x", createdAt: "2026-08-04T00:00:00.000Z", brief: "b",
    intent: "thought-leadership", formats: ["9x16"], language: "en",
    title: "T", thesis: "t", alternates: [],
    sections: [{
        id: "hook", kind: "hook", intentNote: "", energy: "settled",
        onScreen: "A line", phrases: [{id: "p1", text: "One."}],
      }, {
        id: "payoff", kind: "hook", intentNote: "", energy: "settled",
        onScreen: "A line", phrases: [{id: "p1", text: "One."}],
      }],
    narration: {provider: "gemini", voice: "Achird"},
  }).narration.seed, 0, "an older plan reads as unseeded rather than failing");
});

test("the retry re-rolls the seed instead of repeating the take", () => {
  // A fixed seed makes the second attempt return the first take, which the register check
  // would then reject identically — two requests, one outcome, and a wasted minute.
  const source = readFileSync(new URL("./narrate.ts", import.meta.url), "utf8");
  assert.match(source, /plan\.narration\.seed \? plan\.narration\.seed \+ attempt - 1 : 0/);
  // And it has to be in the cache key, or attempt two reads attempt one off disk.
  assert.match(source, /hash\(\{\.\.\.request, seed,/);
});

test("an unseeded request sends no seed at all", () => {
  // Zero is not a seed, it is the absence of one. Sending `seed: 0` would pin every brand
  // that has not chosen to whatever voice zero happens to produce.
  const gemini = readFileSync(new URL("./gemini.ts", import.meta.url), "utf8");
  assert.match(gemini, /\.\.\.\(seed \? \{seed\} : \{\}\)/);
});
