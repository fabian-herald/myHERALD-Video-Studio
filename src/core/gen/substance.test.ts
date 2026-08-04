import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {compositionSize, editDelta, isSubstantive, SUBSTANTIVE_LINES} from "./substance.ts";

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

// compositionSize — the metric that judges whether a composer authored a dense frame.
// Reference values measured from real compositions:
//   codex 53e128   css= 27  gsap= 40  minScene=4
//   codex 3172b0   css= 59  gsap= 35  minScene=9
//   claude dba07c  css=536  gsap=107  minScene=11   (approved; the exemplar)
//   old exemplar   css=483  gsap= 64  minScene=13

test("size counts lines, rules, declarations and calls per file", () => {
  const size = compositionSize({
    "index.html": '<section id="scene-a"><h1>One</h1><p>Two</p></section>',
    "styles.css": ".a { color: red; background: blue; }\n.b { margin: 0; }",
    "animation.js": "gsap.to(a, {x: 1});\ntimeline.from(b, {y: 2});",
  });
  assert.equal(size.lines["styles.css"], 2);
  assert.equal(size.cssRules, 2);
  assert.equal(size.cssDeclarations, 3);
  assert.equal(size.gsapCalls, 2);
  assert.equal(size.elements, 3);
});

test("declarations are counted, not lines — a stylesheet's weight is its decisions", () => {
  const oneLine = compositionSize({"styles.css": ".a{color:red;background:blue;margin:0}"});
  const threeLines = compositionSize({
    "styles.css": ".a {\n  color: red;\n  background: blue;\n  margin: 0;\n}",
  });
  assert.equal(oneLine.cssDeclarations, 2, "trailing declaration needs no semicolon");
  assert.equal(threeLines.cssDeclarations, 3);
  // The point: reformatting changes the line count and must not change the weight much.
  assert.equal(oneLine.cssRules, threeLines.cssRules);
});

test("a comment full of semicolons is not a stylesheet full of declarations", () => {
  const size = compositionSize({"styles.css": "/* a; b; c; d; */\n.a { color: red; }"});
  assert.equal(size.cssDeclarations, 1);
});

test("the smallest scene sets the floor, not the average", () => {
  // A composition can carry its whole element budget in one scene and leave the rest bare.
  const size = compositionSize({
    "index.html":
      '<section id="scene-rich"><div><span>1</span><span>2</span><span>3</span></div></section>'
      + '<section id="scene-bare"><h1>alone</h1></section>',
  });
  // 2 section + div + 3 span + h1.
  assert.equal(size.elements, 7);
  assert.equal(size.minElementsPerScene, 1, "the bare scene is what a viewer sees as thin");
});

test("scene counting survives nested sections", () => {
  const size = compositionSize({
    "index.html":
      '<section id="scene-a"><section class="inner"><b>x</b></section><i>y</i></section>'
      + '<section id="scene-b"><h1>1</h1><h2>2</h2><h3>3</h3></section>',
  });
  // scene-a holds 3 (inner section, b, i); scene-b holds 3. Neither leaks into the other.
  assert.equal(size.minElementsPerScene, 3);
});

test("markup with no declared scenes reports no floor rather than a wrong one", () => {
  assert.equal(compositionSize({"index.html": "<div><p>loose</p></div>"}).minElementsPerScene, 0);
});

test("missing files are zero, not a crash", () => {
  const size = compositionSize({});
  assert.deepEqual(size.lines, {});
  assert.equal(size.elements, 0);
  assert.equal(size.gsapCalls, 0);
  assert.equal(size.minElementsPerScene, 0);
});
