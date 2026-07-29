import assert from "node:assert/strict";
import {test} from "node:test";
import {assertPublicUrl} from "./fetch.ts";
import {extractPage, rankColors, rankFonts, type Usage} from "./research.ts";

test("private, local and credentialed URLs are refused before any request", async () => {
  const refused = [
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.4.4/",
    "http://myherald.local/",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "not a url",
  ];
  for (const url of refused) {
    await assert.rejects(() => assertPublicUrl(url), `${url} should be refused`);
  }
});

const FIXTURE = `<!doctype html><html><head>
  <title>myHERALD - one thought becomes a week</title>
  <meta name="description" content="Turn a rough thought into a coherent content week.">
  <link rel="stylesheet" href="/assets/site.css">
  <link rel="stylesheet" href="https://fonts.example.com/other.css">
  <style>
    body { background: #FDFBF7; color: #2B1B3D; font-family: "DM Sans", system-ui; }
    .card { background: #FDFBF7; border: 1px solid #2B1B3D; }
    .cta { background-color: rgb(124, 58, 237); color: #FFF; }
    .cta:hover { background: #7C3AED; }
    h1 { font-family: "DM Serif Display", Georgia, serif; }
    h2 { font-family: "DM Serif Display", Georgia, serif; }
  </style>
</head><body>
  <h1>Content calendars plan slots, not thoughts, and the week falls apart</h1>
  <p>Built for founders who write their own posts and have no time to run a channel.</p>
  <p>You lose the through-line the moment planning becomes a grid of empty fields.</p>
  <p>Trusted by 40 teams who ship every week without a content manager on staff.</p>
  <li>Short</li>
  <p>Cookie settings and privacy preferences for this website and all of its partners.</p>
</body></html>`;

function read(html: string, url = "https://myherald.io/") {
  const usage = {colors: new Map<string, Usage>(), fonts: new Map<string, number>()};
  const extracted = extractPage(html, url, usage);
  return {...extracted, usage};
}

test("statements are extracted and boilerplate is dropped", () => {
  const {facts, page} = read(FIXTURE);
  const statements = facts.map((fact) => fact.statement);

  assert.ok(statements.some((text) => text.startsWith("Content calendars plan slots")));
  assert.ok(!statements.some((text) => text.startsWith("Cookie settings")), "boilerplate is dropped");
  assert.ok(!statements.includes("Short"), "fragments below 24 characters are dropped");
  assert.equal(page.title, "myHERALD - one thought becomes a week");
  assert.equal(page.summary, "Turn a rough thought into a coherent content week.");
});

test("a statement carrying a figure is marked as needing evidence", () => {
  const {facts} = read(FIXTURE);
  const numeric = facts.find((fact) => fact.statement.includes("40 teams"));
  assert.equal(numeric?.needsEvidence, true);

  const plain = facts.find((fact) => fact.statement.startsWith("Built for founders"));
  assert.equal(plain?.needsEvidence, false);
  assert.equal(plain?.kind, "audience");
});

test("rgb() and hex forms of one colour collapse, and roles come from usage", () => {
  const {usage} = read(FIXTURE);
  const colors = rankColors(usage.colors, {purple: "#7C3AED"}, "#FFFFFF");
  const hexes = colors.map((color) => color.hex);

  assert.ok(hexes.includes("#7c3aed"), `expected the accent, got ${hexes.join(", ")}`);
  assert.equal(hexes.filter((hex) => hex === "#7c3aed").length, 1, "rgb() and #hex are one entry");
  assert.ok(hexes.includes("#fdfbf7"));
  assert.equal(colors.find((color) => color.hex === "#fdfbf7")?.role, "surface");
  assert.equal(colors.find((color) => color.hex === "#2b1b3d")?.role, "text");
  assert.equal(colors.find((color) => color.hex === "#7c3aed")?.matchesToken, "purple",
    "a colour already in the kit says so instead of posing as a find");
});

test("font stacks are counted and matched against the kit", () => {
  const {usage} = read(FIXTURE);
  const fonts = rankFonts(usage.fonts, {
    display: "\"DM Serif Display\", serif",
    body: "\"DM Sans\", sans-serif",
    mono: "\"JetBrains Mono\", monospace",
  });
  const serif = fonts.find((font) => font.stack.startsWith("dm serif display"));
  assert.equal(serif?.count, 2);
  assert.equal(serif?.matchesStack, "display");
});

test("only same-origin stylesheets are followed", () => {
  const {hrefs} = read(FIXTURE);
  assert.deepEqual(hrefs, ["https://myherald.io/assets/site.css"]);
});
