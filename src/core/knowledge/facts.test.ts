import assert from "node:assert/strict";
import test from "node:test";
import {approvedStatements, isUsableFact, type ProductFact} from "./facts.ts";

/**
 * The research exemption, and the four things that must hold at once for it to apply.
 *
 * Why it exists: `make_video` refuses to run until research has happened, `propose_facts`
 * writes everything as `proposed`, and there is no moment between the two where the owner can
 * approve. So every figure a video's own research found was unavailable to that video by
 * construction — 25 proposals had piled up unused when this was found. Measured over the first
 * 48 facts in this library: 15 of 32 `capability` facts were rejected and not one `problem` or
 * `proof` ever was, so the gate was doing real work on product claims and none on research.
 *
 * The narrowness is the safety. A product claim cannot be relabelled `problem` to skip
 * approval, because it would then have to cite a stranger's page to qualify.
 */

const BRAND = "myherald.io";

const fact = (over: Partial<ProductFact> = {}): ProductFact => ({
  id: "f1",
  kind: "problem",
  statement: "25% of marketers knowingly publish off-brand AI content.",
  evidence: "“Optimizely has published research showing that 25%…”",
  state: "proposed",
  source: "https://cmotech.news/story/optimizely-study",
  updatedAt: "",
  ...over,
});

test("third-party research is usable while still only proposed", () => {
  assert.equal(isUsableFact(fact(), BRAND), true);
  assert.equal(isUsableFact(fact({kind: "proof"}), BRAND), true);
});

test("a rejected fact stays rejected, whatever kind it is", () => {
  // Rejection is the owner overruling every other rule here, and it is final.
  assert.equal(isUsableFact(fact({state: "rejected"}), BRAND), false);
});

test("a product claim cannot skip approval by being labelled a problem", () => {
  // The load-bearing case: kind alone is not the discriminator, the source host is.
  assert.equal(isUsableFact(fact({source: "https://myherald.io/data"}), BRAND), false);
  assert.equal(isUsableFact(fact({source: "https://www.myherald.io/data"}), BRAND), false);
});

test("product-shaped kinds still need approval even from an external page", () => {
  // A `capability` sourced to someone else's write-up is still a claim about this product.
  for (const kind of ["capability", "audience", "outcome"] as const) {
    assert.equal(isUsableFact(fact({kind}), BRAND), false, `${kind} must stay gated`);
  }
});

test("research without evidence or without a real source stays gated", () => {
  assert.equal(isUsableFact(fact({evidence: "  "}), BRAND), false);
  assert.equal(isUsableFact(fact({source: ""}), BRAND), false);
  assert.equal(isUsableFact(fact({source: "Optimizely survey, 2026"}), BRAND), false);
});

test("with no brand host the exemption does not apply at all", () => {
  // An empty host compares unequal to every host, so a missing brand would otherwise let
  // everything through — including facts on the brand's own domain. `claims.test.ts` caught
  // exactly this before the check existed.
  assert.equal(isUsableFact(fact()), false);
  assert.equal(isUsableFact(fact(), ""), false);
});

test("approval still works the old way for every kind", () => {
  assert.equal(isUsableFact(fact({kind: "capability", state: "approved"}), BRAND), true);
  assert.equal(isUsableFact(fact({kind: "capability", state: "approved"})), true);
});

test("approvedStatements admits research and still withholds an unevidenced figure", async () => {
  const statements = await approvedStatements([
    fact(),
    fact({id: "f2", statement: "Teams cut drafting time by 40%.", evidence: "", state: "approved"}),
  ], BRAND);
  assert.equal(statements.length, 1, "the evidenced research statement, not the bare figure");
  assert.match(statements[0] ?? "", /25%/);
});
