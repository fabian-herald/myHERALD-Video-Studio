import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {editDelta, isSubstantive, SUBSTANTIVE_LINES} from "./substance.ts";

const html = (body: string) => ({"index.html": body});
const css = (body: string) => ({"styles.css": body});
const js = (body: string) => ({"animation.js": body});

test("an unchanged composition reports no edit at all", () => {
  const before = {...html("<div id=\"a\"></div>"), ...css(".a { color: red; }")};
  const delta = editDelta(before, before);
  assert.deepEqual(delta, {changedLines: 0, structural: false, files: []});
  assert.equal(isSubstantive(delta), false);
});

test("a retuned value is a real edit but not a substantive one", () => {
  // The exact case the gate exists for: the reviewer nudged one padding.
  const delta = editDelta(
    css(".scene { padding: 40px; }"),
    css(".scene { padding: 48px; }"),
  );
  assert.equal(delta.files.length, 1);
  assert.equal(delta.structural, false);
  assert.ok(delta.changedLines < SUBSTANTIVE_LINES);
  assert.equal(isSubstantive(delta), false);
});

test("reindenting is not revising", () => {
  const delta = editDelta(
    css(".a { color: red; }\n.b { color: blue; }"),
    css(".a { color: red; }   \n\n\n.b { color: blue; }   "),
  );
  assert.equal(delta.changedLines, 0);
  assert.equal(delta.structural, false);
});

test("removing a single element is structural however few lines it took", () => {
  const delta = editDelta(
    html("<div id=\"a\"></div>\n<div id=\"b\"></div>"),
    html("<div id=\"a\"></div>"),
  );
  assert.equal(delta.structural, true);
  assert.ok(delta.changedLines < SUBSTANTIVE_LINES);
  // The escape hatch: one line, but the scene changed shape.
  assert.equal(isSubstantive(delta), true);
});

test("adding a tween is structural; retiming an existing one is not", () => {
  const added = editDelta(
    js("gsap.to(a, {x: 1});"),
    js("gsap.to(a, {x: 1});\ngsap.from(b, {y: 2});"),
  );
  assert.equal(added.structural, true);

  const retimed = editDelta(
    js("gsap.to(a, {x: 1, duration: 0.4});"),
    js("gsap.to(a, {x: 1, duration: 0.8});"),
  );
  assert.equal(retimed.structural, false);
});

test("adding a rule block is structural", () => {
  const delta = editDelta(
    css(".a { color: red; }"),
    css(".a { color: red; }\n.b { color: blue; }"),
  );
  assert.equal(delta.structural, true);
});

test("a re-author crosses the line threshold on its own", () => {
  // No structural signal at all: same element count, same rule count, all values retuned.
  const before = css(Array.from({length: 30}, (_, i) => `.s${i} { color: red; }`).join("\n"));
  const after = css(Array.from({length: 30}, (_, i) => `.s${i} { color: blue; }`).join("\n"));
  const delta = editDelta(before, after);
  assert.equal(delta.structural, false);
  assert.ok(delta.changedLines >= SUBSTANTIVE_LINES);
  assert.equal(isSubstantive(delta), true);
});

test("every changed file is named, and unchanged siblings are not", () => {
  const delta = editDelta(
    {...html("<div></div>"), ...css(".a{}"), ...js("gsap.to(a,{});")},
    {...html("<div></div>"), ...css(".a{color:red}"), ...js("gsap.to(a,{});")},
  );
  assert.deepEqual(delta.files, ["styles.css"]);
});

test("the threshold sits in the measured gap between cosmetic and mechanical edits", () => {
  // Cosmetic nudges measured 1-6 lines; mechanical repairs 2-22; re-authors 1700+.
  // The constant must stay above the cosmetic band or the gate stops saving anything.
  assert.ok(SUBSTANTIVE_LINES > 6, "threshold would treat a cosmetic nudge as substantive");
  assert.ok(SUBSTANTIVE_LINES < 22, "threshold would treat a real repair as cosmetic");
});

test("the pipeline gates the confirmation pass on substance, not on any edit", () => {
  const source = readFileSync(new URL("../pipeline/run.ts", import.meta.url), "utf8");
  const flow = source.slice(source.indexOf("export async function composeWithRepair"));
  const review = flow.indexOf("await composer.review");

  // `changed` still drives re-checking — a cosmetic edit must still be validated.
  assert.match(flow.slice(review), /if \(!report\.ok \|\| !changed\) break;/);
  // ...but only a substantive edit buys a second vision session.
  assert.match(flow.slice(review), /if \(!substantive\) \{/);
});
