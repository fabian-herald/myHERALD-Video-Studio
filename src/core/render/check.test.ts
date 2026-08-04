import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {
  checkBannedWords,
  checkCanonicalBrandLockups,
  checkCanvasLiterals,
  checkDataBarProportions,
  checkPerpetualMotionSource,
  checkWordmark,
} from "./check.ts";
import type {VideoPlan} from "../plan/schema.ts";

const plan = (formats: string[]) => ({formats} as unknown as VideoPlan);

async function withAnimation(source: string, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-check-"));
  try {
    await fs.writeFile(path.join(dir, "animation.js"), source, "utf8");
    await run(dir);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test("a global full-runtime spatial tween is rejected", async () => {
  await withAnimation(
    'timeline.to(".spine-node", {y: HEIGHT, duration: TOTAL, ease: "none"}, 0);',
    async (dir) => {
      const findings = await checkPerpetualMotionSource(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "perpetual_motion");
      assert.match(findings[0]?.fixHint ?? "", /scene-local meaningful visual beats/);
    },
  );
});

test("scene-local state changes and static accents pass the perpetual-motion check", async () => {
  await withAnimation(
    'timeline.to(".card", {scale: 1.04, duration: .4}, at("#scene-proof") + 2.1);',
    async (dir) => assert.deepEqual(await checkPerpetualMotionSource(dir), []),
  );
});

test("a lowercase duration alias bound to the stage is rejected", async () => {
  await withAnimation(
    'const total = parseFloat(stage.dataset.duration);\ntimeline.to(".node", {y: HEIGHT, duration: total});',
    async (dir) => assert.equal((await checkPerpetualMotionSource(dir)).length, 1),
  );
});

test("a multiline full-runtime tween is rejected", async () => {
  await withAnimation(
    'timeline.to(".node", {\n  y: HEIGHT,\n  duration: TOTAL,\n});',
    async (dir) => assert.equal((await checkPerpetualMotionSource(dir)).length, 1),
  );
});

test("a full-runtime non-spatial opacity change is not perpetual motion", async () => {
  await withAnimation(
    'timeline.to(".scrim", {opacity: 0, duration: TOTAL});',
    async (dir) => assert.deepEqual(await checkPerpetualMotionSource(dir), []),
  );
});

test("an inline full-runtime spatial tween cannot bypass animation.js", async () => {
  await withAnimation("", async (dir) => {
    await fs.writeFile(
      path.join(dir, "index.html"),
      '<script>const whole = parseFloat(stage.dataset.duration);\n'
        + 'gsap.to(".node", {rotation: 360, duration: whole});</script>',
      "utf8",
    );
    const findings = await checkPerpetualMotionSource(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? "", /index\.html/);
  });
});

test("a hardcoded canvas height is caught when the family serves several formats", async () => {
  await withAnimation(
    'timeline.fromTo(".spine-node", {y: 0}, {y: 1920, duration: TOTAL}, 0);',
    async (dir) => {
      const findings = await checkCanvasLiterals(dir, plan(["9x16", "4x5", "1x1"]), "portrait");
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "canvas_literal");
      assert.match(findings[0]?.message ?? "", /1920/);
      assert.match(findings[0]?.fixHint ?? "", /dataset\.height/);
    },
  );
});

test("reading the height from the stage passes", async () => {
  await withAnimation(
    'const H = parseFloat(stage.dataset.height);\ntimeline.fromTo(".spine-node", {y: 0}, {y: H, duration: TOTAL}, 0);',
    async (dir) => {
      assert.deepEqual(await checkCanvasLiterals(dir, plan(["9x16", "4x5", "1x1"]), "portrait"), []);
    },
  );
});

test("the shared width is not flagged, because it does not vary in this family", async () => {
  await withAnimation(
    "timeline.to('.rule', {x: 1080, duration: 1}, 0);",
    async (dir) => {
      assert.deepEqual(await checkCanvasLiterals(dir, plan(["9x16", "4x5"]), "portrait"), []);
    },
  );
});

test("a single-format family has nothing to vary and is skipped", async () => {
  await withAnimation(
    'timeline.fromTo(".spine-node", {y: 0}, {y: 1920, duration: TOTAL}, 0);',
    async (dir) => {
      assert.deepEqual(await checkCanvasLiterals(dir, plan(["9x16"]), "portrait"), []);
    },
  );
});

test("1080 is flagged for portrait once 1:1 is in the set, since it is then a height too", async () => {
  await withAnimation(
    "timeline.to('.spine-node', {y: 1080, duration: 1}, 0);",
    async (dir) => {
      const findings = await checkCanvasLiterals(dir, plan(["9x16", "1x1"]), "portrait");
      assert.equal(findings.length, 1, "1080 is 1:1's height and 9:16 is 1920");
    },
  );
});

test("a literal inside a comment is not a finding", async () => {
  await withAnimation(
    "// the node travels the full 1920 of a 9:16 canvas\nconst H = parseFloat(stage.dataset.height);",
    async (dir) => {
      assert.deepEqual(await checkCanvasLiterals(dir, plan(["9x16", "4x5"]), "portrait"), []);
    },
  );
});

test("a longer number containing the dimension is not a false positive", async () => {
  await withAnimation(
    "const seed = 11920;\nconst other = 1920.5;",
    async (dir) => {
      assert.deepEqual(await checkCanvasLiterals(dir, plan(["9x16", "4x5"]), "portrait"), []);
    },
  );
});

// — banned words and the em-dash rule ————————————————————————

const kit = {voice: {bannedWords: ["leverage", "seamless"]}} as unknown as import("../brand/kit.ts").BrandKit;

async function withHtml(html: string, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-copy-"));
  try {
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
    await run(dir);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test("an em-dash in the title is not a finding — nobody sees the title in a video", async () => {
  await withHtml(
    "<html><head><title>myHERALD — Slots statt Gedanken</title></head><body><h1>Clean copy.</h1></body></html>",
    async (dir) => assert.deepEqual(await checkBannedWords(dir, kit), []),
  );
});

test("an em-dash on screen is a finding", async () => {
  await withHtml(
    "<html><head><title>Fine</title></head><body><h1>A thought — then a slot.</h1></body></html>",
    async (dir) => {
      const findings = await checkBannedWords(dir, kit);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "em_dash");
    },
  );
});

test("a banned word on screen is a finding, and one in the head is not", async () => {
  await withHtml(
    "<html><head><title>Seamless leverage</title></head><body><h1>Plain words only.</h1></body></html>",
    async (dir) => assert.deepEqual(await checkBannedWords(dir, kit), []),
  );
  await withHtml(
    "<html><body><h1>A seamless week.</h1></body></html>",
    async (dir) => {
      const findings = await checkBannedWords(dir, kit);
      assert.equal(findings.length, 1);
      assert.match(findings[0]?.message ?? "", /seamless/);
    },
  );
});

// — the wordmark rule ————————————————————————————————————————

const branded = {
  name: "myHERALD",
  voice: {bannedWords: []},
  logos: [{id: "wordmark-light", role: "wordmark", theme: "light", file: "logos/wordmark-light.png", safeAreaPct: 0.25, label: ""}],
} as unknown as import("../brand/kit.ts").BrandKit;

test("the brand name set as type on its own is a finding", async () => {
  await withHtml(
    '<html><body><p class="sig-lockup">myHERALD</p></body></html>',
    async (dir) => {
      const findings = await checkWordmark(dir, branded);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "typeset_wordmark");
      assert.match(findings[0]?.fixHint ?? "", /logo-wordmark-light\.png/);
    },
  );
});

test("a typed brand name inside the persistent rail is still a finding", async () => {
  await withHtml(
    '<html><body><header id="brand-rail"><strong>myHERALD</strong><small>TAGLINE</small></header></body></html>',
    async (dir) => assert.equal((await checkWordmark(dir, branded)).length, 1),
  );
});

test("splitting the name across spans does not evade the rule", async () => {
  await withHtml(
    '<html><body><p><span>my</span><span>HERALD</span></p></body></html>',
    async (dir) => assert.equal((await checkWordmark(dir, branded)).length, 1,
      "the wrapper <p> reads as the bare name once its children are stripped"),
  );
});

test("the name inside a sentence is ordinary copy", async () => {
  await withHtml(
    "<html><body><h1>myHERALD turns one thought into a week.</h1></body></html>",
    async (dir) => assert.deepEqual(await checkWordmark(dir, branded), []),
  );
});

test("placing the supplied mark passes", async () => {
  await withHtml(
    '<html><body><div class="sig"><img src="media/logo-wordmark-light.png" alt="myHERALD"></div></body></html>',
    async (dir) => assert.deepEqual(await checkWordmark(dir, branded), []),
  );
});

test("with no wordmark in the kit there is nothing to enforce", async () => {
  await withHtml(
    "<html><body><p>myHERALD</p></body></html>",
    async (dir) => assert.deepEqual(
      await checkWordmark(dir, {...branded, logos: []} as unknown as import("../brand/kit.ts").BrandKit), []),
  );
});

test("the rail and silent signature use the supplied full lockup", async () => {
  const kit = {
    ...branded,
    logos: [
      ...branded.logos,
      {id: "lockup-light", role: "lockup", theme: "light", file: "logos/lockup-light.png", safeAreaPct: 0.25, label: ""},
    ],
  } as unknown as import("../brand/kit.ts").BrandKit;
  const signaturePlan = {
    sections: [{id: "brand-signature", kind: "outro", startMs: 0, durationMs: 1600, phrases: []}],
  } as unknown as VideoPlan;

  await withHtml(
    '<html><body><header id="brand-rail"><img class="rail-lockup" src="media/logo-lockup-light.png"></header>'
      + '<section id="scene-brand-signature"><img src="media/logo-lockup-light.png"></section></body></html>',
    async (dir) => assert.deepEqual(await checkCanonicalBrandLockups(dir, kit, signaturePlan), []),
  );
});

test("separate seal and wordmark do not count as the canonical lockup", async () => {
  const kit = {
    ...branded,
    logos: [
      ...branded.logos,
      {id: "lockup-light", role: "lockup", theme: "light", file: "logos/lockup-light.png", safeAreaPct: 0.25, label: ""},
    ],
  } as unknown as import("../brand/kit.ts").BrandKit;
  const signaturePlan = {
    sections: [{id: "brand-signature", kind: "outro", startMs: 0, durationMs: 1600, phrases: []}],
  } as unknown as VideoPlan;

  await withHtml(
    '<html><body><header id="brand-rail"><img src="media/logo-seal.png"><img src="media/logo-wordmark-light.png"></header>'
      + '<section id="scene-brand-signature"><img src="media/logo-wordmark-light.png"></section></body></html>',
    async (dir) => {
      const findings = await checkCanonicalBrandLockups(dir, kit, signaturePlan);
      assert.deepEqual(findings.map((finding) => finding.code), [
        "canonical_lockup_missing_rail",
        "canonical_lockup_missing_outro",
      ]);
    },
  );
});

test("a silent signature carries non-promotional brand context", async () => {
  const kit = {
    ...branded,
    tagline: "Autonomous AI Content Engine",
    website: "myherald.io",
    logos: [
      ...branded.logos,
      {id: "lockup-light", role: "lockup", theme: "light", file: "logos/lockup-light.png", safeAreaPct: 0.25, label: ""},
    ],
  } as unknown as import("../brand/kit.ts").BrandKit;
  const signaturePlan = {
    intent: "thought-leadership",
    sections: [{id: "brand-signature", kind: "outro", startMs: 0, durationMs: 3000, phrases: []}],
  } as unknown as VideoPlan;

  await withHtml(
    '<html><body><header id="brand-rail"><img src="media/logo-lockup-light.png"></header>'
      + '<section id="scene-brand-signature"><img src="media/logo-lockup-light.png">'
      + '<p>Autonomous AI Content Engine</p><p>myherald.io</p></section></body></html>',
    async (dir) => assert.deepEqual(await checkCanonicalBrandLockups(dir, kit, signaturePlan), []),
  );

  await withHtml(
    '<html><body><header id="brand-rail"><img src="media/logo-lockup-light.png"></header>'
      + '<section id="scene-brand-signature"><img src="media/logo-lockup-light.png"></section></body></html>',
    async (dir) => assert.deepEqual(
      (await checkCanonicalBrandLockups(dir, kit, signaturePlan)).map((finding) => finding.code),
      ["signature_tagline_missing", "signature_website_missing"],
    ),
  );
});

test("a percentage bar must end at its sourced proportion", async () => {
  const dataPlan = {
    sections: [{
      id: "proof", kind: "proof", startMs: 0, durationMs: 3000, phrases: [],
      data: {shape: "share", unit: "%", caption: "Source", points: [{label: "Voice slips", value: 25, factId: "f1"}]},
    }],
  } as unknown as VideoPlan;

  await withHtml(
    '<section id="scene-proof"><div class="data-bar" data-value="25" data-max="100" '
      + 'style="--fill: .25"><span></span></div></section>',
    async (dir) => assert.deepEqual(await checkDataBarProportions(dir, dataPlan), []),
  );
  await withHtml(
    '<section id="scene-proof"><div class="data-bar" data-value="25" data-max="100" '
      + 'style="--fill: 1"><span></span></div></section>',
    async (dir) => {
      const findings = await checkDataBarProportions(dir, dataPlan);
      assert.equal(findings[0]?.code, "data_bar_proportion");
    },
  );
});

test("a non-bar data treatment is not forced into bar metadata", async () => {
  const dataPlan = {
    sections: [{
      id: "proof", kind: "proof", startMs: 0, durationMs: 3000, phrases: [],
      data: {shape: "counter", unit: "%", caption: "Source", points: [{label: "Voice slips", value: 25, factId: "f1"}]},
    }],
  } as unknown as VideoPlan;
  await withHtml(
    '<section id="scene-proof"><strong class="data-figure">25%</strong></section>',
    async (dir) => assert.deepEqual(await checkDataBarProportions(dir, dataPlan), []),
  );
});

// A2 — structured location and remedy on findings.
//
// These fields are what let a deterministic fixer act on a finding without a model session.
// Each assertion below pins a value that was previously computed and then spent on prose.

test("perpetual motion carries the file and line it already names in its message", async () => {
  await withAnimation(
    '\n\ntimeline.to(".spine-node", {y: HEIGHT, duration: TOTAL, ease: "none"}, 0);',
    async (dir) => {
      const [finding] = await checkPerpetualMotionSource(dir);
      assert.equal(finding?.file, "animation.js");
      assert.equal(finding?.line, 3);
      assert.match(finding?.snippet ?? "", /spine-node/);
      // The message keeps its prose form; the fields are an addition, not a replacement.
      assert.match(finding?.message ?? "", /animation\.js:3/);
    },
  );
});

test("an em-dash finding carries the one substitution that needs no judgement", async () => {
  await withHtml(
    "<html><body><h1>Slots — statt Gedanken</h1></body></html>",
    async (dir) => {
      const finding = (await checkBannedWords(dir, kit)).find((f) => f.code === "em_dash");
      assert.equal(finding?.file, "index.html");
      // A spaced en-dash is explicitly permitted; a comma or full stop is a copy decision.
      assert.equal(finding?.expected, "–");
    },
  );
});

test("a missing rail lockup resolves the asset from the field the rail declares", async () => {
  const lockupKit = {
    ...branded,
    logos: [
      {id: "lockup-light", role: "lockup", theme: "light", file: "logos/lockup-light.png", safeAreaPct: 0.25, label: ""},
      {id: "lockup-dark", role: "lockup", theme: "dark", file: "logos/lockup-dark.png", safeAreaPct: 0.25, label: ""},
    ],
  } as unknown as import("../brand/kit.ts").BrandKit;
  const emptyPlan = {sections: []} as unknown as VideoPlan;

  await withHtml(
    '<html><body><header id="brand-rail" class="brand-rail on-dark clip"><span>myHERALD</span></header></body></html>',
    async (dir) => {
      const [finding] = await checkCanonicalBrandLockups(dir, lockupKit, emptyPlan);
      assert.equal(finding?.code, "canonical_lockup_missing_rail");
      assert.equal(finding?.elementId, "brand-rail");
      // on-dark must pick the dark lockup, not merely the first one in the kit.
      assert.equal(
        finding?.expected,
        '<img class="rail-lockup" src="media/logo-lockup-dark.png" alt="myHERALD">',
      );
    },
  );
});

test("the rail lockup literal stays unset when the field cannot be read", async () => {
  const lockupKit = {
    ...branded,
    logos: [
      {id: "lockup-light", role: "lockup", theme: "light", file: "logos/lockup-light.png", safeAreaPct: 0.25, label: ""},
      {id: "lockup-dark", role: "lockup", theme: "dark", file: "logos/lockup-dark.png", safeAreaPct: 0.25, label: ""},
    ],
  } as unknown as import("../brand/kit.ts").BrandKit;
  const emptyPlan = {sections: []} as unknown as VideoPlan;

  await withHtml(
    '<html><body><header id="brand-rail" class="brand-rail clip"><span>myHERALD</span></header></body></html>',
    async (dir) => {
      const [finding] = await checkCanonicalBrandLockups(dir, lockupKit, emptyPlan);
      // Choosing between a light, dark and plate lockup is a design call, not a fix.
      assert.equal(finding?.expected, undefined);
      assert.match(finding?.fixHint ?? "", /field-appropriate/);
    },
  );
});

test("a data bar pinned to a plan point carries the numbers to write", async () => {
  const dataBarPlan = {
    sections: [{
      id: "proof",
      data: {unit: "%", points: [{label: "Reach", value: 25}]},
    }],
  } as unknown as VideoPlan;

  await withHtml(
    '<section id="scene-proof"><div class="data-bar" data-value="25" data-max="7" style="--fill: .9"></div></section>',
    async (dir) => {
      const [finding] = await checkDataBarProportions(dir, dataBarPlan);
      assert.equal(finding?.code, "data_bar_proportion");
      assert.equal(finding?.sectionId, "proof");
      // The matched tag identifies which bar; the selector alone cannot when a scene has several.
      assert.match(finding?.snippet ?? "", /data-value="25"/);
      assert.ok(finding?.expected, "a bar anchored by data-value should carry its expected geometry");
    },
  );
});

test("a data bar with no matching plan point declines to guess a figure", async () => {
  const dataBarPlan = {
    sections: [{
      id: "proof",
      data: {unit: "%", points: [{label: "Reach", value: 25}]},
    }],
  } as unknown as VideoPlan;

  await withHtml(
    '<section id="scene-proof"><div class="data-bar" data-value="61" data-max="100" style="--fill: .61"></div></section>',
    async (dir) => {
      const [finding] = await checkDataBarProportions(dir, dataBarPlan);
      assert.equal(finding?.code, "data_bar_proportion");
      // Nothing maps this bar to a figure, and inventing one puts a wrong number on screen.
      assert.equal(finding?.expected, undefined);
    },
  );
});
