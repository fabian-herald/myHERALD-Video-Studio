import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {combineComposeResults} from "./run.ts";
import type {ComposeResult} from "../gen/composer.ts";

test("a failed format family is recorded before the run throws", () => {
  const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const catchFamily = source.indexOf("familyFailures.push({family, message})");
  const provenance = source.indexOf("await writeProvenance");
  const ledger = source.indexOf("await upsertLedgerEntry");
  const finalFailure = source.indexOf("if (familyFailures.length)", ledger);

  assert.ok(catchFamily >= 0, "the family loop does not retain a failed family");
  assert.ok(provenance > catchFamily, "provenance is not written after a family failure");
  assert.ok(ledger > provenance, "the ledger is not written after partial provenance");
  assert.ok(finalFailure > ledger, "the run throws before completed sibling outputs are recorded");
});

test("a partial family run can never be recorded as ready", () => {
  const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const status = source.slice(source.indexOf("status:"), source.indexOf("spokenScript:"));
  assert.match(status, /familyFailures\.length === 0/);
  assert.match(status, /outputs\.length > 0/);
});

test("a repair that changes nothing stops the loop instead of spending the budget", () => {
  const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const flow = source.slice(source.indexOf("export async function composeWithRepair"));

  // The fingerprint has to bracket the model call alone. Taken any later — after an
  // auto-fix pass edits the same three files — a stagnant composer reads as productive.
  const before = flow.indexOf("const before = attempt === 1 ? null : await compositionFingerprint");
  const modelCall = flow.indexOf("await composer.compose(context)");
  const stagnation = flow.indexOf("before === await compositionFingerprint", modelCall);

  assert.ok(before >= 0, "the repair loop does not fingerprint before the model call");
  assert.ok(modelCall > before, "the fingerprint is taken after the composer already ran");
  assert.ok(stagnation > modelCall, "the composition is never re-fingerprinted after repair");

  // Only repairs can stagnate; attempt 1 has nothing to compare against.
  assert.match(flow.slice(before, modelCall), /attempt === 1 \? null/);

  // The artefact must survive for inspection, exactly as the exhausted-budget path does.
  const freeze = flow.indexOf("await freezeAttempt", stagnation);
  const thrown = flow.indexOf("throw new Error", stagnation);
  assert.ok(freeze > stagnation && freeze < thrown, "the stagnant attempt is not frozen first");
});

test("stagnation and an exhausted budget stay distinguishable failures", () => {
  const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const flow = source.slice(source.indexOf("export async function composeWithRepair"));

  assert.match(flow, /was unchanged by repair attempt/);
  assert.match(flow, /still failed validation after/);

  // Neither path may quietly substitute the diagnostic baseline for the model's work.
  const stagnation = flow.indexOf("was unchanged by repair attempt");
  const afterStagnation = flow.slice(stagnation, stagnation + 400);
  assert.doesNotMatch(afterStagnation, /writeBaselineComposition|usedBaseline: true/);
});

test("no field of a compose result is dropped when a review pass is combined in", () => {
  // The guard, not the fix. combineComposeResults used to list every field explicitly, so a
  // field added to ComposeResult silently vanished the moment a visual review ran — and
  // stayed invisible until someone read a provenance file weeks later. This asserts the
  // property rather than the implementation: whatever the interface grows, it survives.
  const authored: ComposeResult = {
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    turns: 3,
    actions: 11,
    costUsd: 0,
    notes: "authored",
  };
  const reviewed: ComposeResult = {
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    turns: 2,
    actions: 4,
    costUsd: 0,
    notes: "reviewed",
  };

  const combined = combineComposeResults(authored, reviewed) as unknown as Record<string, unknown>;
  for (const key of Object.keys(authored)) {
    assert.ok(key in combined, `combineComposeResults dropped "${key}"`);
    assert.notEqual(combined[key], undefined, `combineComposeResults blanked "${key}"`);
  }

  // Only the genuinely cumulative fields add up; identity fields take the reviewer's value.
  assert.equal(combined.turns, 5);
  assert.equal(combined.actions, 15);
  assert.equal(combined.notes, "authored\nreviewed");
  assert.equal(combined.effort, "xhigh");
});

test("an authored result that never existed leaves the review untouched", () => {
  const reviewed: ComposeResult = {
    provider: "claude", model: "claude-opus-5", effort: "maxTurns:90",
    turns: 7, actions: 20, costUsd: 1.5, notes: "only pass",
  };
  assert.deepEqual(combineComposeResults(null, reviewed), reviewed);
});

test("a composition that was never written reads as empty rather than throwing", async () => {
  // The live failure this guards: an xhigh Codex session was killed by the idle timeout
  // before it wrote anything, and the next attempt's stagnation fingerprint threw ENOENT
  // and took the whole format family down with it. An attempt that produced nothing is a
  // real state the repair loop has to be able to reason about.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-empty-"));
  try {
    const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /await fs\.readFile\(path\.join\(dir, file\), "utf8"\)\.catch\(\(\) => ""\)/,
      "readComposition must tolerate a missing file",
    );
    // And the same for the auto-fix snapshot, which reads the same three files.
    const autofix = readFileSync(new URL("../render/autofix.ts", import.meta.url), "utf8");
    assert.match(autofix, /\.catch\(\(\) => ""\)/, "autofix must tolerate a missing file");
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test("the Codex idle budget outlasts the reasoning it pays for", () => {
  const source = readFileSync(new URL("../gen/codexComposer.ts", import.meta.url), "utf8");
  const budget = Number(/CODEX_IDLE_TIMEOUT_MS = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, ""));
  // An xhigh compose went silent for over 300s while writing and was killed mid-file.
  assert.ok(budget > 300_000, `idle budget ${budget}ms is not longer than a measured xhigh silence`);
});
