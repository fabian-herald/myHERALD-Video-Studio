import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";

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
