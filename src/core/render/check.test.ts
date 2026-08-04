import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {
  checkBannedWords,
  checkBrandRailPersistence,
  checkNumericTiming,
  checkSceneEntrances,
  HARDCODED_TIME_REPORT_LIMIT,
  checkCanonicalBrandLockups,
  checkCanvasLiterals,
  checkDataBarProportions,
  checkPerpetualMotionSource,
  checkStylesheetLinks,
  checkLayoutWaivers,
  checkTransformOrigin,
  removeHiddenElements,
  visuallyHiddenClasses,
  checkTokens,
  REQUIRED_STYLESHEETS,
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
  // Deliberately not the spine. This fixture used to be `.spine-node`, and that exact line
  // is now legal — see the progress-readout carve-out below. The rule it tests is unchanged
  // for everything that is not a clock: an orbit that circles for the whole video is drift.
  await withAnimation(
    'timeline.to(".problem-orbit", {rotation: 360, duration: TOTAL, ease: "none"}, 0);',
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
    '\n\ntimeline.to(".problem-orbit", {rotation: 360, duration: TOTAL, ease: "none"}, 0);',
    async (dir) => {
      const [finding] = await checkPerpetualMotionSource(dir);
      assert.equal(finding?.file, "animation.js");
      assert.equal(finding?.line, 3);
      assert.match(finding?.snippet ?? "", /problem-orbit/);
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

// The silent outro used to be required to typeset the tagline even when the lockup image
// already rendered it, which put the same words on screen twice with no legal alternative.

const outroKit = (includesTagline: boolean) => ({
  name: "myHERALD",
  tagline: "Autonomous AI Content Engine",
  website: "myherald.io",
  voice: {bannedWords: []},
  logos: [{
    id: "lockup-light", role: "lockup", theme: "light", file: "logos/lockup-light.png",
    safeAreaPct: 0.25, includesTagline, label: "",
  }],
} as unknown as import("../brand/kit.ts").BrandKit);

const outroPlan = {
  sections: [{id: "brand-signature", kind: "outro", startMs: 0, durationMs: 4000, phrases: []}],
} as unknown as VideoPlan;

const outroHtml = (body: string) =>
  '<html><body><header id="brand-rail">'
  + '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD"></header>'
  + `<section id="scene-brand-signature">${body}</section></body></html>`;

test("a lockup that renders the tagline satisfies the signature requirement", async () => {
  await withHtml(
    outroHtml(
      '<img class="cta-wordmark" src="media/logo-lockup-light.png" alt="myHERALD">'
      + '<div class="cta-url">myherald.io</div>',
    ),
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, outroKit(true), outroPlan))
        .map((finding) => finding.code);
      assert.equal(codes.includes("signature_tagline_missing"), false,
        "the tagline is already in the lockup image; demanding it as type duplicates it");
      // The website is not in the image, so that half of the rule still applies.
      assert.equal(codes.includes("signature_website_missing"), false);
    },
  );
});

test("a lockup without the tagline still has to say it", async () => {
  await withHtml(
    outroHtml(
      '<img class="cta-wordmark" src="media/logo-lockup-light.png" alt="myHERALD">'
      + '<div class="cta-url">myherald.io</div>',
    ),
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, outroKit(false), outroPlan))
        .map((finding) => finding.code);
      assert.ok(codes.includes("signature_tagline_missing"),
        "a bare lockup plate with no context is what this rule exists to prevent");
    },
  );
});

test("the website is never assumed to be in the artwork", async () => {
  await withHtml(
    outroHtml('<img class="cta-wordmark" src="media/logo-lockup-light.png" alt="myHERALD">'),
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, outroKit(true), outroPlan))
        .map((finding) => finding.code);
      assert.ok(codes.includes("signature_website_missing"));
    },
  );
});

// ── Stage 4a: the gaps a composition could walk through ──────────────────────────
//
// Four rules that were being trusted to the prompt. Each ships at the severity it can
// justify today: the two whose answer is fixed by the framework as errors, the two that
// have to judge a number or a string as warnings, until two real compositions have run
// through them without a false positive.

test("a narrated call to action must use the supplied lockup, not a rebuilt one", async () => {
  // The rule used to require a silent outro. A narrated cta is the same end card with a
  // voice over it, and it was free to reconstruct the mark from a seal and a wordmark.
  const ctaPlan = {
    sections: [{
      id: "cta", kind: "cta", startMs: 0, durationMs: 4000,
      phrases: [{id: "p1", text: "Find out how."}],
    }],
  } as unknown as VideoPlan;

  await withHtml(
    '<html><body><header id="brand-rail">'
    + '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD"></header>'
    + '<section id="scene-cta"><img class="seal" src="media/logo-seal.svg">'
    + '<img src="media/logo-wordmark-light.png"></section></body></html>',
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, outroKit(true), ctaPlan))
        .map((finding) => finding.code);
      assert.ok(codes.includes("canonical_lockup_missing_outro"), codes.join(", "));
    },
  );

  await withHtml(
    '<html><body><header id="brand-rail">'
    + '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD"></header>'
    + '<section id="scene-cta"><img src="media/logo-lockup-light.png" alt="myHERALD">'
    // Widening `kind` also brings a narrated cta under the context rule, which is right:
    // when the plan carries no cta line, this is still the last frame a viewer sees and
    // it has to say whose work it is. The tagline is already in this lockup's artwork.
    + '<p class="cta-url">myherald.io</p></section></body></html>',
    async (dir) => assert.deepEqual(
      await checkCanonicalBrandLockups(dir, outroKit(true), ctaPlan), []),
  );
});

test("a mid-video scene is not held to the signature rule", async () => {
  // Only the *final* section is a signature. Widening `kind` must not turn a cta at the
  // three-quarter mark into an end card.
  const midPlan = {
    sections: [
      {id: "cta", kind: "cta", startMs: 0, durationMs: 4000, phrases: []},
      {id: "payoff", kind: "payoff", startMs: 4000, durationMs: 4000, phrases: []},
    ],
  } as unknown as VideoPlan;
  await withHtml(
    '<html><body><header id="brand-rail">'
    + '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD"></header>'
    + '<section id="scene-cta"><h2>Anything</h2></section>'
    + '<section id="scene-payoff"><h2>The end</h2></section></body></html>',
    async (dir) => assert.deepEqual(
      await checkCanonicalBrandLockups(dir, outroKit(true), midPlan), []),
  );
});

test("a canvas dimension hardcoded in the stylesheet is flagged too", async () => {
  const formats = plan(["9x16", "4x5", "1x1"]);
  const withCss = async (css: string, run: (dir: string) => Promise<void>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-css-"));
    try {
      await fs.writeFile(path.join(dir, "styles.css"), css, "utf8");
      await run(dir);
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  };

  // 1920 is the 9:16 height and nothing else in the family — right in one format, wrong
  // in the two it is re-emitted into. The `px` suffix is why the JS pattern missed it.
  await withCss(".stack { height: 1920px; }", async (dir) => {
    const findings = await checkCanvasLiterals(dir, formats, "portrait");
    assert.equal(findings[0]?.code, "canvas_literal_css");
    assert.equal(findings[0]?.severity, "warning");
    assert.equal(findings[0]?.file, "styles.css");
  });

  await withCss(".stack { height: var(--stage-h); }", async (dir) =>
    assert.deepEqual(await checkCanvasLiterals(dir, formats, "portrait"), []));

  // Comments are not code, and a number that is part of a longer token is not a literal.
  await withCss("/* was 1920px */ .a { z-index: 11920; }", async (dir) =>
    assert.deepEqual(await checkCanvasLiterals(dir, formats, "portrait"), []));
});

test("an off-palette colour in a tween is caught, and a comment about one is not", async () => {
  const brandKit = {
    color: {tokens: {deep: "#0B0A1F", paper: "#F5F3FF"}},
    voice: {bannedWords: []},
    logos: [],
  } as unknown as import("../brand/kit.ts").BrandKit;

  const withJs = async (js: string, run: (dir: string) => Promise<void>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-js-"));
    try {
      await fs.writeFile(path.join(dir, "animation.js"), js, "utf8");
      await run(dir);
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  };

  // The literal lives inside a string, which is exactly why masking non-code would have
  // blanked it. Line numbers survive the comment strip so the finding points somewhere.
  await withJs(
    "// the brand deep is #0B0A1F\n\ngsap.to(el, {backgroundColor: \"#FF00AA\"});",
    async (dir) => {
      const findings = await checkTokens(dir, brandKit);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.file, "animation.js");
      assert.equal(findings[0]?.line, 3);
      assert.equal(findings[0]?.severity, "warning", "warning until two clean compositions");
    },
  );

  await withJs('gsap.to(el, {backgroundColor: "var(--brand-lilac)"});', async (dir) =>
    assert.deepEqual(await checkTokens(dir, brandKit), []));
});

test("the stylesheet link set is required, in order, with styles.css last", async () => {
  const link = (href: string) => `<link rel="stylesheet" href="${href}" />`;
  const page = (hrefs: readonly string[]) =>
    `<html><head>${hrefs.map(link).join("")}</head><body></body></html>`;

  await withHtml(page(REQUIRED_STYLESHEETS), async (dir) =>
    assert.deepEqual(await checkStylesheetLinks(dir), []));

  // A composition's own extra sheet is not this rule's business.
  await withHtml(page([...REQUIRED_STYLESHEETS, "./extra.css"]), async (dir) =>
    assert.deepEqual(await checkStylesheetLinks(dir), []));

  await withHtml(page(REQUIRED_STYLESHEETS.filter((sheet) => sheet !== "./tokens.css")), async (dir) => {
    const findings = await checkStylesheetLinks(dir);
    assert.equal(findings[0]?.code, "missing_stylesheet_link");
    assert.match(findings[0]?.message ?? "", /tokens\.css/);
  });

  // styles.css first means every block primitive overrides the composition specialising it.
  await withHtml(page(["./styles.css", ...REQUIRED_STYLESHEETS.slice(0, -1)]), async (dir) => {
    const findings = await checkStylesheetLinks(dir);
    assert.equal(findings[0]?.code, "stylesheet_link_order");
  });
});

test("a one-axis scale with no origin grows from the middle, and is flagged", async () => {
  // The idiom that is correct: origin declared once on the .set that pins the start state.
  await withAnimation(
    'timeline.set(".rule", {scaleX: 0, transformOrigin: "left center"}, 0);\n'
    + 'timeline.to(".rule", {scaleX: 1, duration: .5}, 1);',
    async (dir) => assert.deepEqual(await checkTransformOrigin(dir), []),
  );

  await withAnimation(
    'timeline.to(".data-bar span", {scaleX: 1, duration: .5}, 1);',
    async (dir) => {
      const findings = await checkTransformOrigin(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "missing_transform_origin");
      assert.equal(findings[0]?.severity, "warning", "scaling from centre is rare, not illegal");
      assert.equal(findings[0]?.selector, ".data-bar span");
      assert.equal(findings[0]?.line, 1);
    },
  );
});

test("uniform scale and rotation are left alone — the centre is usually right there", async () => {
  // The rule is narrow on purpose. A card that pops or a mark that spins about its centre
  // is correct, and flagging those would fire on most of a good composition.
  await withAnimation(
    'timeline.to(".card", {scale: 1.04, duration: .4}, 1);\n'
    + 'timeline.to(".seal", {rotation: 360, duration: 2}, 1);',
    async (dir) => assert.deepEqual(await checkTransformOrigin(dir), []),
  );
});

test("a transform-origin set in the stylesheet satisfies the rule", async () => {
  await withAnimation('timeline.to(".rule", {scaleX: 1, duration: .5}, 1);', async (dir) => {
    await fs.writeFile(
      path.join(dir, "styles.css"),
      ".rule { transform-origin: left center; width: 100%; }",
      "utf8",
    );
    assert.deepEqual(await checkTransformOrigin(dir), []);
  });
});

test("one target is reported once, however many times it is scaled", async () => {
  await withAnimation(
    'timeline.to(".rule", {scaleX: 1, duration: .5}, 1);\n'
    + 'timeline.to(".rule", {scaleX: 0, duration: .5}, 3);\n'
    + 'timeline.to(".other", {scaleY: 1, duration: .5}, 4);',
    async (dir) => {
      const findings = await checkTransformOrigin(dir);
      assert.deepEqual(findings.map((finding) => finding.selector), [".rule", ".other"]);
    },
  );
});

// ── waivers, hidden copy, and the tagline set twice ──────────────────────────────

test("a waiver declared across a group is a design decision and passes", async () => {
  // The exemplar's hook: five sheets deliberately stacked on top of one another. Without
  // these waivers that scene cannot exist, so the rule must not touch it.
  await withHtml(
    '<div class="sheet-stack" data-layout-allow-overlap data-layout-allow-occlusion>'
    + '<article class="sheet" data-layout-allow-overlap data-layout-allow-occlusion><b>POST</b></article>'
    + '<article class="sheet" data-layout-allow-overlap data-layout-allow-occlusion><b>POST</b></article>'
    + '<article class="sheet lead" data-layout-allow-overlap data-layout-allow-occlusion><h1>Consistency</h1></article>'
    + "</div>",
    async (dir) => assert.deepEqual(await checkLayoutWaivers(dir), []),
  );
});

test("a waiver on one text element alone is a mute button and is flagged", async () => {
  // The real defect: with the headline waived and nothing else, a chip and an axis label
  // both landed on top of "The wrong measure" and no gate said a word.
  await withHtml(
    '<div class="mistake-world"><div class="measure-title" data-layout-allow-overlap>'
    + "<h1>The wrong measure</h1></div>"
    + '<div class="mistake-flag">VOLUME</div></div>',
    async (dir) => {
      const findings = await checkLayoutWaivers(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "lone_layout_waiver");
      assert.equal(findings[0]?.selector, ".measure-title");
    },
  );
});

test("a waiver on a shape with no text is left alone", async () => {
  // Waiving an overlap between decorative shapes is a decision about shapes. Waiving it on
  // live type is waiving the reader's ability to read.
  await withHtml(
    '<div class="world"><div class="orbit" data-layout-allow-overlap aria-hidden="true"><i></i></div></div>',
    async (dir) => assert.deepEqual(await checkLayoutWaivers(dir), []),
  );
});

test("a visually hidden element cannot answer the on-screen copy rule", () => {
  const hidden = visuallyHiddenClasses(
    ".sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }\n"
    + ".gone { display: none; }\n"
    + ".masked { clip-path: inset(100%); }\n"
    + ".visible { width: 1px; }",
  );
  assert.deepEqual([...hidden].sort(), ["gone", "masked", "sr-only"]);

  const html = '<p class="sr-only">myHERALD</p><p class="cta-url">myherald.io</p>';
  assert.equal(removeHiddenElements(html, hidden).includes("myHERALD"), false);
  assert.equal(removeHiddenElements(html, hidden).includes("myherald.io"), true);
});

test("aria-hidden is not visually hidden — it is how a visible decoration is marked", () => {
  assert.equal(visuallyHiddenClasses('.orbit[aria-hidden="true"] { opacity: 1; }').size, 0);
});

test("the tagline is not set as type beside a lockup that already renders it", async () => {
  const kitWith = outroKit(true);
  const planNoTagline = {
    sections: [{
      id: "brand-signature", kind: "outro", startMs: 0, durationMs: 4000, phrases: [],
      onScreen: "myherald.io",
    }],
  } as unknown as VideoPlan;

  await withHtml(
    outroHtml(
      '<img class="outro-lockup" src="media/logo-lockup-light.png" alt="myHERALD">'
      + '<p class="outro-context">Autonomous AI Content Engine</p>'
      + '<div class="cta-url">myherald.io</div>',
    ),
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, kitWith, planNoTagline))
        .map((finding) => finding.code);
      assert.ok(codes.includes("tagline_duplicated"), codes.join(", "));
    },
  );

  // The plan asking for it is the usual case, and then the composer had no choice — the
  // finding belongs on the plan, which is what planner rule 11 addresses.
  const planWantsTagline = {
    sections: [{
      id: "brand-signature", kind: "outro", startMs: 0, durationMs: 4000, phrases: [],
      onScreen: "myHERALD\nAutonomous AI Content Engine\nmyherald.io",
    }],
  } as unknown as VideoPlan;
  await withHtml(
    outroHtml(
      '<img class="outro-lockup" src="media/logo-lockup-light.png" alt="myHERALD">'
      + '<p class="outro-context">Autonomous AI Content Engine</p>'
      + '<div class="cta-url">myherald.io</div>',
    ),
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, kitWith, planWantsTagline))
        .map((finding) => finding.code);
      assert.equal(codes.includes("tagline_duplicated"), false);
    },
  );
});

test("a lockup that does not carry the tagline still wants it in type", async () => {
  const planNoTagline = {
    sections: [{
      id: "brand-signature", kind: "outro", startMs: 0, durationMs: 4000, phrases: [],
      onScreen: "myherald.io",
    }],
  } as unknown as VideoPlan;
  await withHtml(
    outroHtml(
      '<img class="outro-lockup" src="media/logo-lockup-light.png" alt="myHERALD">'
      + '<p class="outro-context">Autonomous AI Content Engine</p>'
      + '<div class="cta-url">myherald.io</div>',
    ),
    async (dir) => {
      const codes = (await checkCanonicalBrandLockups(dir, outroKit(false), planNoTagline))
        .map((finding) => finding.code);
      assert.equal(codes.includes("tagline_duplicated"), false, "nothing is duplicated here");
    },
  );
});

// ── the persistent identity strip ────────────────────────────────────────────────

const railPlan = {
  sections: [
    {id: "hook", kind: "hook", startMs: 0, durationMs: 6000, phrases: []},
    {id: "payoff", kind: "payoff", startMs: 6000, durationMs: 6000, phrases: []},
    {id: "brand-outro", kind: "outro", startMs: 12000, durationMs: 4000, phrases: []},
  ],
} as unknown as VideoPlan;

const railHtml = (railAttrs: string) =>
  '<html><body><main id="stage" data-duration="16.000">'
  + `<header id="brand-rail" class="brand-rail clip" ${railAttrs}>`
  + '<img class="rail-lockup" src="media/logo-lockup-light.png" alt="myHERALD"></header>'
  + "</main></body></html>";

test("a rail clipped to part of the video leaves the rest unbranded", async () => {
  await withHtml(railHtml('data-start="0" data-duration="8.000"'), async (dir) => {
    const findings = await checkBrandRailPersistence(dir, railPlan);
    assert.equal(findings[0]?.code, "brand_rail_not_persistent");
    assert.equal(findings[0]?.severity, "error");
    // Determined, so a fixer can write it without a model.
    assert.equal(findings[0]?.expected, "16");
    assert.equal(findings[0]?.attribute, "data-duration");
  });

  await withHtml(railHtml('data-start="0" data-duration="16.000"'), async (dir) =>
    assert.deepEqual(await checkBrandRailPersistence(dir, railPlan), []));
});

test("fading the rail into the closing card is the good version and passes", async () => {
  // What the exemplar does: `timeline.to("#brand-rail", {autoAlpha: 0, ...}, S6 - 0.14)`,
  // handing the mark over to the outro lockup. The position is symbolic, and a rule that
  // cannot evaluate it says nothing rather than guessing.
  await withHtml(railHtml('data-start="0" data-duration="16.000"'), async (dir) => {
    await fs.writeFile(
      path.join(dir, "animation.js"),
      'timeline.to("#brand-rail", {autoAlpha: 0, duration: 0.16}, S6 - 0.14);',
      "utf8",
    );
    assert.deepEqual(await checkBrandRailPersistence(dir, railPlan), []);
  });
});

test("hiding the rail in the first third is reported", async () => {
  await withHtml(railHtml('data-start="0" data-duration="16.000"'), async (dir) => {
    await fs.writeFile(
      path.join(dir, "animation.js"),
      'timeline.to("#brand-rail", {autoAlpha: 0, duration: 0.3}, 4.5);',
      "utf8",
    );
    const findings = await checkBrandRailPersistence(dir, railPlan);
    assert.equal(findings[0]?.code, "brand_rail_hidden_early");
    assert.equal(findings[0]?.severity, "warning");
  });

  // Named, and named a section that is not the last one.
  await withHtml(railHtml('data-start="0" data-duration="16.000"'), async (dir) => {
    await fs.writeFile(
      path.join(dir, "animation.js"),
      'timeline.to("#brand-rail", {opacity: 0, duration: 0.3}, at("#scene-payoff"));',
      "utf8",
    );
    assert.equal(
      (await checkBrandRailPersistence(dir, railPlan))[0]?.code, "brand_rail_hidden_early");
  });
});

test("a composition with no rail at all is left to the lockup rule", async () => {
  // `checkCanonicalBrandLockups` already owns "there is no rail". Reporting it twice sends
  // a repair pass at one defect with two different remedies.
  await withHtml("<html><body><main id='stage' data-duration='16.000'></main></body></html>",
    async (dir) => assert.deepEqual(await checkBrandRailPersistence(dir, railPlan), []));
});

// ── numbers where derived timings belong ─────────────────────────────────────────

async function withTiming(js: string, html: string, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-timing-"));
  try {
    await fs.writeFile(path.join(dir, "animation.js"), js, "utf8");
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
    await run(dir);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

const stage = '<main id="stage" data-duration="45.000"></main>';

test("a numeric duration spanning the video is the TOTAL form written by hand", async () => {
  await withTiming('timeline.to(".node", {y: 200, duration: 44});', stage, async (dir) => {
    const findings = await checkNumericTiming(dir);
    assert.equal(findings[0]?.code, "numeric_full_runtime_tween");
    assert.equal(findings[0]?.severity, "warning");
  });

  await withTiming('timeline.to(".node", {y: 200, duration: 0.6});', stage, async (dir) =>
    assert.deepEqual(await checkNumericTiming(dir), []));
});

test("a literal timeline position is flagged; zero and derived positions are not", async () => {
  await withTiming('timeline.to(".card", {autoAlpha: 1, duration: .4}, 12.5);', stage, async (dir) => {
    const findings = await checkNumericTiming(dir);
    assert.equal(findings[0]?.code, "hardcoded_scene_time");
    assert.match(findings[0]?.fixHint ?? "", /at\("#scene-<id>"\)/);
  });

  // Zero is the start of the timeline and means exactly that.
  await withTiming('timeline.set(".card", {autoAlpha: 0}, 0);', stage, async (dir) =>
    assert.deepEqual(await checkNumericTiming(dir), []));

  await withTiming(
    'timeline.to(".card", {autoAlpha: 1, duration: .4}, at("#scene-hook") + len("#scene-hook") * .3);',
    stage,
    async (dir) => assert.deepEqual(await checkNumericTiming(dir), []),
  );
});

test("a composition that hardcodes everything is not reported line by line", async () => {
  // 466bde does this 68 times. With no errors in the report those warnings become the
  // repair brief, and 68 of anything is not a surgical one.
  const js = Array.from({length: 20}, (_, index) =>
    `timeline.to(".n${index}", {autoAlpha: 1, duration: .3}, ${index + 1}.5);`).join("\n");
  await withTiming(js, stage, async (dir) => {
    const findings = await checkNumericTiming(dir);
    assert.equal(findings.length, HARDCODED_TIME_REPORT_LIMIT);
    // Said out loud, not silently truncated.
    assert.match(findings.at(-1)?.message ?? "", /15 further literal positions not listed/);
  });
});

test("two scenes entering identically are noted, and only as info", async () => {
  const entrancePlan = {
    sections: [
      {id: "hook", kind: "hook", startMs: 0, durationMs: 6000, phrases: []},
      {id: "point", kind: "point", startMs: 6000, durationMs: 6000, phrases: []},
    ],
  } as unknown as VideoPlan;

  await withTiming(
    'timeline.from("#scene-hook h1", {autoAlpha: 0, y: 40, duration: .5, ease: "power2.out"}, at("#scene-hook"));\n'
    + 'timeline.from("#scene-point h1", {autoAlpha: 0, y: 40, duration: .5, ease: "power2.out"}, at("#scene-point"));',
    stage,
    async (dir) => {
      const findings = await checkSceneEntrances(dir, entrancePlan);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.severity, "info", "this one judges rather than verifies");
      assert.equal(findings[0]?.code, "repeated_scene_entrance");
    },
  );

  await withTiming(
    'timeline.from("#scene-hook h1", {autoAlpha: 0, y: 40, duration: .5, ease: "power2.out"}, at("#scene-hook"));\n'
    + 'timeline.from("#scene-point .slab", {scaleX: 0, duration: .5, ease: "power3.inOut"}, at("#scene-point"));',
    stage,
    async (dir) => assert.deepEqual(await checkSceneEntrances(dir, entrancePlan), []),
  );
});

// ── the spine is a clock, not drift ─────────────────────────────────────────────

test("a linear full-runtime spine is a progress readout and passes", async () => {
  // The exact code this rule was originally written against. The owner watched both and
  // said the continuous version reads as elapsed time where the stepped one reads as six
  // unrelated animations — and the stepped version is what every composition built,
  // because it was the only one that passed.
  await withAnimation(
    'timeline.to(".spine-line", {scaleY: 1, duration: TOTAL, ease: "none"}, 0);\n'
    + 'timeline.to(".spine-node", {y: HEIGHT, duration: TOTAL, ease: "none"}, 0);',
    async (dir) => assert.deepEqual(await checkPerpetualMotionSource(dir), []),
  );
});

test("all three conditions are load-bearing", async () => {
  const rejected = async (source: string, why: string) => {
    await withAnimation(source, async (dir) => {
      const findings = await checkPerpetualMotionSource(dir);
      assert.equal(findings.length, 1, why);
    });
  };

  // Eased: a readout that accelerates is not reporting anything, it is decoration wearing
  // a readout's clothes. This is the condition that stops the exception swallowing the rule.
  await rejected(
    'timeline.to(".spine-line", {scaleY: 1, duration: TOTAL, ease: "power2.inOut"}, 0);',
    "an eased full-runtime spine is not a clock",
  );

  // Off-axis: a spine that turns for forty-five seconds is drift whatever it is called.
  await rejected(
    'timeline.to(".spine-node", {rotation: 360, duration: TOTAL, ease: "none"}, 0);',
    "the spine may only move along the axis it runs on",
  );

  // Not the spine: the carve-out is for the one element the framework declares continuous.
  await rejected(
    'timeline.to(".ambient-grid", {y: HEIGHT, duration: TOTAL, ease: "none"}, 0);',
    "any other element moving for the whole runtime is the thing the rule exists to stop",
  );
});

test("the contract shows the continuous spine rather than describing it", async () => {
  const contract = await fs.readFile(
    new URL("../compose/CONTRACT.md", import.meta.url), "utf8");
  assert.match(contract, /duration: TOTAL, ease: "none"/, "no copyable example");
  assert.match(contract, /`ease: "none"` is not optional/);
  assert.match(contract, /Do not step it scene by scene/);
  // And it must not read as a way around the freeze gate, which it is not.
  assert.match(contract, /hairline changes too few pixels/);
});
