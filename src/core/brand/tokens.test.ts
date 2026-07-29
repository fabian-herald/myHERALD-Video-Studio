import assert from "node:assert/strict";
import {test} from "node:test";
import {brandKitZ, contrastRatio, verifyPairs, type BrandKit} from "./kit.ts";
import {findRogueColors, renderTokensCss} from "./tokens.ts";

const kit: BrandKit = brandKitZ.parse({
  schemaVersion: 1,
  name: "Test",
  website: "example.com",
  color: {
    tokens: {ink: "#21172b", paper: "#fffefa", accent: "#fcd20c"},
    pairs: [
      {fg: "ink", bg: "paper", minRatio: 7},
      {fg: "paper", bg: "accent", minRatio: 4.5},
    ],
  },
  type: {
    stacks: {display: "Georgia, serif", body: "Arial, sans-serif", mono: "Courier, monospace"},
    scale: {h1: 98, sectionNumber: 72},
  },
  motion: {},
  voice: {},
  doDont: {},
});

test("tokens are emitted as kebab-cased custom properties", () => {
  const css = renderTokensCss(kit);
  assert.match(css, /--brand-ink: #21172b;/);
  assert.match(css, /--brand-size-section-number: 72px;/);
  assert.match(css, /--brand-font-display: Georgia, serif;/);
});

test("a colour literal outside the token set is caught", () => {
  const rogue = findRogueColors(".a { color: #ff0000; }\n.b { color: #FCD20C; }", kit);
  assert.equal(rogue.length, 1);
  assert.equal(rogue[0]?.literal, "#ff0000");
  assert.equal(rogue[0]?.line, 1);
});

test("neutral scrims are allowed but tinted rgba is not", () => {
  assert.equal(findRogueColors(".a { background: rgba(0,0,0,.4); }", kit).length, 0);
  assert.equal(findRogueColors(".a { background: rgba(255,255,255,.2); }", kit).length, 0);
  assert.equal(findRogueColors(".a { background: rgba(120,40,200,.3); }", kit).length, 1);
});

test("shorthand hex and comments are handled", () => {
  assert.equal(findRogueColors(".a { color: #fff; }", kit).length, 1, "#fff is not a token here");
  assert.equal(findRogueColors("/* #ff0000 in a comment */", kit).length, 0);
});

test("a pair that does not meet its own minimum is reported", () => {
  assert.equal(verifyPairs(kit).length, 1, "paper on accent is far below 4.5:1");
  assert.ok(contrastRatio("#21172b", "#fffefa") > 7);
});
