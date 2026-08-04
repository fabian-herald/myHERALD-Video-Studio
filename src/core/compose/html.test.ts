import assert from "node:assert/strict";
import {test} from "node:test";
import {
  addClassToElement,
  attribute,
  extractElement,
  insertIntoElement,
  rewriteSceneTiming,
  setElementAttribute,
} from "./html.ts";

test("setting an existing attribute replaces only that attribute", () => {
  const html = '<section id="scene-a" class="clip" data-start="1.000" data-duration="2.000"></section>';
  const out = setElementAttribute(html, "scene-a", "data-start", "3.500");
  assert.match(out, /data-start="3\.500"/);
  assert.match(out, /data-duration="2\.000"/);
  assert.match(out, /class="clip"/);
});

test("setting an absent attribute inserts it instead of doing nothing", () => {
  // The whole reason this helper exists: the previous regex-replace silently no-opped
  // here, which is exactly the missing_timing defect it was meant to repair.
  const html = '<section id="scene-a" class="clip"></section>';
  const out = setElementAttribute(html, "scene-a", "data-start", "0.000");
  assert.match(out, /<section id="scene-a" class="clip" data-start="0\.000">/);
});

test("inserting an attribute keeps a self-closing tag self-closing", () => {
  const html = '<img id="hero" src="media/a.png" />';
  const out = setElementAttribute(html, "hero", "data-start", "0.000");
  assert.match(out, /data-start="0\.000"\s*\/>/);
  assert.equal(attribute(out, "src"), "media/a.png");
});

test("an unresolvable id leaves the document untouched", () => {
  const html = '<section id="scene-a"></section>';
  assert.equal(setElementAttribute(html, "scene-missing", "data-start", "0"), html);
  assert.equal(addClassToElement(html, "scene-missing", "clip"), html);
  assert.equal(insertIntoElement(html, "scene-missing", "<b>x</b>"), html);
});

test("adding a class preserves the existing list and is idempotent", () => {
  const html = '<section id="scene-a" class="scene editorial"></section>';
  const once = addClassToElement(html, "scene-a", "clip");
  assert.equal(attribute(once, "class"), "scene editorial clip");
  assert.equal(addClassToElement(once, "scene-a", "clip"), once);
});

test("adding a class to an element with none creates the attribute", () => {
  const out = addClassToElement('<section id="scene-a"></section>', "scene-a", "clip");
  assert.equal(attribute(out, "class"), "clip");
});

test("a fragment appends or prepends inside the element, not around it", () => {
  const html = '<header id="brand-rail"><span>a</span></header>';
  assert.match(
    insertIntoElement(html, "brand-rail", "<img>"),
    /<header id="brand-rail"><span>a<\/span><img><\/header>/,
  );
  assert.match(
    insertIntoElement(html, "brand-rail", "<img>", "prepend"),
    /<header id="brand-rail"><img><span>a<\/span><\/header>/,
  );
});

test("insertion respects nesting of same-named elements", () => {
  const html = '<div id="outer"><div><b>inner</b></div></div>';
  const out = insertIntoElement(html, "outer", "<hr>");
  assert.match(out, /<div><b>inner<\/b><\/div><hr><\/div>/);
});

test("scene timing now repairs a missing attribute, not just a wrong one", () => {
  // Previously this rewrote data-duration and silently skipped the absent data-start.
  const html = '<section id="scene-a" class="clip" data-duration="9.999"></section>';
  const out = rewriteSceneTiming(html, "a", 1500, 2250);
  assert.match(out, /data-start="1\.500"/);
  assert.match(out, /data-duration="2\.250"/);
});

test("extracting an element balances same-named nesting", () => {
  const element = extractElement(
    '<section id="scene-a"><section>nested</section>tail</section><section>after</section>',
    "scene-a",
  );
  assert.equal(element?.inner, "<section>nested</section>tail");
});
