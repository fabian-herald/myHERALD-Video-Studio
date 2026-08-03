import assert from "node:assert/strict";
import {test} from "node:test";
import {numbersIn} from "./numbers.ts";

const texts = (copy: string) => numbersIn(copy).map((mention) => mention.text);
const values = (copy: string) => numbersIn(copy).map((mention) => mention.value);

test("a number at the end of a sentence does not swallow the full stop", () => {
  // The bug this replaces: a greedy [\d.,]* took the punctuation, so "2019." reached an
  // anchored year test that could never match it and the gate refused a plain date.
  assert.deepEqual(texts("The tooling changed in 2019."), ["2019"]);
  assert.deepEqual(texts("In 2019, everything changed."), ["2019"]);
  assert.deepEqual(texts("We shipped 42."), ["42"]);
});

test("a comma-separated list is several numbers, not one", () => {
  assert.deepEqual(texts("We had 12, 15 and 20."), ["12", "15", "20"]);
});

test("a decimal keeps its fraction, in either notation", () => {
  assert.deepEqual(values("3.4 hours a day"), [3.4]);
  assert.deepEqual(values("3,4 Stunden pro Tag"), [3.4]);
});

test("grouped thousands are one number however they are separated", () => {
  assert.deepEqual(values("1,200 responses"), [1200]);
  assert.deepEqual(values("1 200 Antworten"), [1200]);
  // Without the space-grouped alternative first, this reads as 1 and then 200.
  assert.equal(numbersIn("1 200 Antworten").length, 1);
});

test("a scale word is part of the number it scales", () => {
  const [mention] = numbersIn("reaching 1.5 million readers");
  assert.equal(mention?.value, 1_500_000);
  // The owner has to recognise the figure in the error message, and "1.5" is not what the
  // copy said.
  assert.equal(mention?.text, "1.5 million");
  assert.deepEqual(values("over 12 thousand people"), [12_000]);
});

test("a unit is carried alongside the digits, not folded into them", () => {
  assert.deepEqual(numbersIn("Up 40%."), [{text: "40", value: 40, unit: "%"}]);
  assert.deepEqual(numbersIn("Up 2019% since launch."), [{text: "2019", value: 2019, unit: "%"}]);
  assert.equal(numbersIn("Up 40 percent.")[0]?.unit, "percent");
  assert.equal(numbersIn("Plus 12,5 Prozent.")[0]?.unit, "Prozent");
  assert.equal(numbersIn("It is 3x faster.")[0]?.unit, "x");
  assert.equal(numbersIn("€2,400,000 in year one")[0]?.unit, "€");
});

test("a bare number carries no unit", () => {
  // What makes the year carve-out expressible: this is a date, the "2019%" above is not.
  assert.equal(numbersIn("changed in 2019.")[0]?.unit, "");
  assert.equal(numbersIn("Thursday, 4pm")[0]?.unit, "");
});

test("an x that begins a word is not a multiplier", () => {
  assert.equal(numbersIn("3 xylophones")[0]?.unit, "");
});

test("prose with no digits states no numbers", () => {
  assert.deepEqual(numbersIn("roughly two thirds of teams"), []);
  assert.deepEqual(numbersIn(""), []);
});
