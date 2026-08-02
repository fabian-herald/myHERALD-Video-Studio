import fs from "node:fs/promises";
import path from "node:path";
import type {BrandKit} from "../brand/kit.ts";
import type {PlanSection, VideoPlan} from "../plan/schema.ts";
import {BLOCK_FILES, FPS, NARRATION_FILE, type AuthoringDir} from "./workdir.ts";

/**
 * A hand-written, format-parametric composition that consumes the plan directly.
 *
 * It exists so the render, check and QC path can be exercised without spending a model
 * call. It is opt-in diagnostic output, never an automatic substitute for failed creative
 * work. It rotates four archetypes rather than repeating one, because even a diagnostic
 * should expose the whole composition contract.
 */
export async function writeBaselineComposition(
  authoring: AuthoringDir,
  plan: VideoPlan,
  kit: BrandKit,
): Promise<void> {
  await fs.writeFile(path.join(authoring.dir, "index.html"), buildHtml(authoring, plan, kit), "utf8");
  await fs.writeFile(path.join(authoring.dir, "styles.css"), BASELINE_CSS, "utf8");
  await fs.writeFile(path.join(authoring.dir, "animation.js"), buildAnimation(authoring, plan, kit), "utf8");
}

const ARCHETYPES = ["display", "artifact", "field", "split"] as const;
type Archetype = (typeof ARCHETYPES)[number];

const archetypeFor = (section: PlanSection, index: number): Archetype => {
  if (section.kind === "cta" || section.kind === "outro") return "field";
  return ARCHETYPES[index % ARCHETYPES.length] ?? "display";
};

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Split copy so the tail can be italicised — the brand's headline signature. */
function headline(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return escape(text);
  const cut = Math.ceil(words.length * 0.55);
  return `${escape(words.slice(0, cut).join(" "))}<br /><em>${escape(words.slice(cut).join(" "))}</em>`;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

function logoId(kit: BrandKit, role: "seal" | "wordmark" | "lockup", theme: "light" | "dark") {
  return kit.logos.find((logo) => logo.role === role && logo.theme === theme)?.id
    ?? kit.logos.find((logo) => logo.role === role && logo.theme === "any")?.id
    ?? kit.logos.find((logo) => logo.role === role)?.id;
}

const isBrandName = (copy: string, kit: BrandKit) =>
  copy.trim().toLocaleLowerCase() === kit.name.trim().toLocaleLowerCase();

function displayCopy(copy: string, kit: BrandKit, theme: "light" | "dark") {
  if (!isBrandName(copy, kit)) return `<h1 class="line">${headline(copy)}</h1>`;
  const id = logoId(kit, "wordmark", theme);
  return id
    ? `<img class="standalone-wordmark" src="./media/logo-${id}.png" alt="${escape(kit.name)}" />`
    : `<h1 class="line">${headline(copy)}</h1>`;
}

function buildScene(section: PlanSection, index: number, plan: VideoPlan, kit: BrandKit): string {
  const archetype = archetypeFor(section, index);
  const light = archetype === "field";
  const number = String(index + 1).padStart(2, "0");
  const copy = section.onScreen.trim() || section.phrases[0]?.text || "";
  const spoken = section.phrases.map((phrase) => phrase.text).join(" ");
  const isEndCard = section.kind === "cta" || section.kind === "outro";
  const endCardLockup = logoId(kit, "lockup", "light") ?? logoId(kit, "wordmark", "light");
  const endCard = isEndCard
    ? `<div class="cta-lockup end-card">`
      + (endCardLockup
        ? `<img class="cta-wordmark" src="./media/logo-${endCardLockup}.png" alt="${escape(kit.name)}" />`
        : "")
      + `<p class="outro-context">${escape(section.kind === "cta" && plan.cta ? plan.cta.label : kit.tagline)}</p>`
      + `<div class="cta-url">${escape(section.kind === "cta" && plan.cta ? plan.cta.url : kit.website)}`
      + `${section.kind === "cta" ? " <b>&#8599;</b>" : ""}</div></div>`
    : "";

  const slot = section.slot
    ? `<div class="presenter-slot style-${section.slot.style} baseline-slot" data-placeholder-label="PRESENTER — ${seconds(section.durationMs)}s"></div>`
    : "";

  const body = {
    display: `
        <div class="scene-body body-display">
          ${displayCopy(copy, kit, "dark")}
          ${slot}
        </div>`,
    artifact: `
        <div class="scene-body body-artifact">
          <article class="paper-card artifact">
            <span class="label">${escape(section.kind.toUpperCase())}</span>
            <h2 class="line">${headline(copy)}</h2>
          </article>
          ${slot}
        </div>`,
    field: `
        <div class="scene-body body-field">
          ${isEndCard ? endCard : displayCopy(copy, kit, "light")}
          ${slot}
        </div>`,
    split: `
        <div class="scene-body body-split">
          <div class="split-left"><h2 class="line">${headline(copy)}</h2></div>
          <div class="split-mark"><i></i><b>&#8594;</b></div>
          <div class="split-right">
            <div class="tag">${escape(section.kind.toUpperCase())}</div>
            <div class="rule"><i></i><b></b></div>
          </div>
          ${slot}
        </div>`,
  }[archetype];
  void spoken;

  return `
      <section
        id="scene-${section.id}"
        class="scene clip arch-${archetype}${light ? " on-light-scene" : ""}"
        data-start="${seconds(section.startMs)}"
        data-duration="${seconds(section.durationMs)}"
        data-track-index="${10 + index}"
      >
        ${archetype === "field" ? '<div class="field accent-field"></div>' : ""}
        <div class="scene-masthead">
          <p class="kicker${light ? " on-light" : ""}">${escape(section.kind)}</p>
          <div class="section-number${light ? " on-light" : ""}">${number}</div>
        </div>
${body}
        <div class="scene-footer">
          <div class="rule${light ? " on-light" : ""}"><i></i><b></b><span>${escape(kit.tagline.toUpperCase())}</span></div>
        </div>
      </section>`;
}

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

function buildHtml(authoring: AuthoringDir, plan: VideoPlan, kit: BrandKit): string {
  const duration = authoring.durationSeconds;
  const scenes = plan.sections.map((section, index) => buildScene(section, index, plan, kit)).join("\n");
  const darkLockupId = logoId(kit, "lockup", "dark") ?? logoId(kit, "wordmark", "dark") ?? "badge";

  return `<!doctype html>
<html lang="${plan.language}">
<head>
  <meta charset="UTF-8" />
  <title>${escape(plan.title)}</title>
  <link rel="stylesheet" href="./tokens.css" />
${BLOCK_FILES.map((block) => `  <link rel="stylesheet" href="./blocks/${block}" />`).join("\n")}
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main
    id="stage"
    data-composition-id="${authoring.compositionId}"
    data-start="0"
    data-duration="${duration}"
    data-width="${authoring.width}"
    data-height="${authoring.height}"
    data-format="${authoring.family === "landscape" ? "16x9" : "9x16"}"
    data-fps="${FPS}"
    style="--stage-w: ${authoring.width}px; --stage-h: ${authoring.height}px;"
  >
    <div id="backdrop" class="backdrop clip" data-start="0" data-duration="${duration}" data-track-index="0">
      <div class="editorial-grid"></div>
      <div class="signal-spine"><i class="spine-line"></i><b class="spine-node"></b></div>
    </div>

    <header id="brand-rail" class="brand-rail clip" data-start="0" data-duration="${duration}" data-track-index="80">
      <img class="rail-lockup" src="./media/logo-${darkLockupId}.png" alt="${escape(kit.name)}" />
      <div class="rail-rule"></div>
    </header>
${scenes}

    <div id="caption-layer" class="caption-layer clip" data-start="0" data-duration="${duration}" data-track-index="90" aria-live="off"></div>
    <audio id="narration" class="clip" src="./${NARRATION_FILE}" data-start="0" data-duration="${duration}" data-track-index="95" data-volume="0.9"></audio>

    <script src="./vendor/gsap.min.js"></script>
    <script src="./caption-data.js"></script>
    <script>window.__timelines = window.__timelines || {};</script>
    <script src="./animation.js"></script>
  </main>
</body>
</html>
`;
}

function buildAnimation(authoring: AuthoringDir, plan: VideoPlan, kit: BrandKit): string {
  const entries = plan.sections.map((section, index) => ({
    selector: `#scene-${section.id}`,
    archetype: archetypeFor(section, index),
    light: archetypeFor(section, index) === "field",
  }));
  const darkLockup = logoId(kit, "lockup", "dark") ?? logoId(kit, "wordmark", "dark");
  const lightLockup = logoId(kit, "lockup", "light") ?? logoId(kit, "wordmark", "light") ?? darkLockup;

  return `(() => {
  const gsap = window.gsap;
  const captionData = window.__captionData;
  if (!gsap || !captionData) throw new Error("GSAP and caption data must load first.");

  const timeline = gsap.timeline({paused: true});
  const stage = document.querySelector("#stage");

  // Timings are read from the DOM, never hardcoded, so editing copy or pacing in the
  // plan shifts the picture with the narration instead of desynchronising it.
  const scenes = ${JSON.stringify(entries, null, 2)}
    .map((scene) => {
      const element = document.querySelector(scene.selector);
      const at = parseFloat(element.dataset.start);
      return {...scene, at, out: at + parseFloat(element.dataset.duration)};
    });

  timeline.set(scenes.map((scene) => scene.selector), {autoAlpha: 0});
  timeline.set(".spine-line", {scaleY: 1, transformOrigin: "top"});
  timeline.set(".spine-node", {autoAlpha: 0});

  // Entrance direction varies per archetype so the motion is not one gesture repeated.
  const enter = {
    display: {from: {autoAlpha: 0, y: 64}, to: {autoAlpha: 1, y: 0}},
    artifact: {from: {autoAlpha: 0, x: 220, rotate: -3}, to: {autoAlpha: 1, x: 0, rotate: -1.4}},
    field: {from: {autoAlpha: 0, scale: 0.94}, to: {autoAlpha: 1, scale: 1}},
    split: {from: {autoAlpha: 0, x: -180}, to: {autoAlpha: 1, x: 0}},
  };

  for (const scene of scenes) {
    const motion = enter[scene.archetype] || enter.display;
    timeline.set("#brand-rail", {className: scene.light ? "brand-rail clip on-light" : "brand-rail clip"}, scene.at);
    timeline.set(".rail-lockup", {attr: {src: scene.light
      ? "./media/logo-${lightLockup}.png"
      : "./media/logo-${darkLockup}.png"}}, scene.at);
    timeline.set(scene.selector, {autoAlpha: 1}, scene.at);
    if (scene.archetype === "field") {
      timeline.fromTo(scene.selector + " .accent-field",
        {scaleY: 0, transformOrigin: "bottom"},
        {scaleY: 1, duration: 0.42, ease: "power3.inOut"}, scene.at);
    }
    timeline.fromTo(scene.selector + " .scene-body > *",
      motion.from,
      {...motion.to, duration: 0.5, stagger: 0.07, ease: "power3.out"},
      scene.at + 0.06);
    timeline.fromTo(scene.selector + " .scene-masthead > *",
      {autoAlpha: 0, y: 18},
      {autoAlpha: 1, y: 0, duration: 0.34, stagger: 0.06, ease: "power2.out"},
      scene.at + 0.02);
    timeline.fromTo(scene.selector + " .scene-footer",
      {autoAlpha: 0, scaleX: 0.8, transformOrigin: "left"},
      {autoAlpha: 1, scaleX: 1, duration: 0.4, ease: "power2.out"},
      scene.at + 0.22);

    // The diagnostic baseline stays readable instead of drifting forever. Its staged
    // entrances and caption changes provide discrete visual beats; resolved type holds.

    timeline.to(scene.selector, {autoAlpha: 0, duration: 0.24, ease: "power2.in"}, scene.out - 0.24);
  }

  // Captions: pages are measured, the active word is coloured on the same timeline.
  const layer = document.querySelector("#caption-layer");
  for (const page of captionData.pages) {
    const paragraph = document.createElement("p");
    paragraph.className = "caption-page";
    paragraph.setAttribute("aria-label", page.text);
    const words = captionData.tokens.filter((token) => token.cueIndex === page.cueIndex);
    for (const token of words) {
      const span = document.createElement("span");
      span.className = "word";
      span.textContent = token.text;
      paragraph.appendChild(span);
    }
    layer.appendChild(paragraph);

    const spans = [...paragraph.querySelectorAll(".word")];
    timeline.set(paragraph, {autoAlpha: 0, y: 14}, 0);
    timeline.to(paragraph, {autoAlpha: 1, y: 0, duration: 0.14, ease: "power2.out"}, page.fromMs / 1000);
    words.forEach((token, index) => {
      timeline.set(spans, {
        color: (wordIndex) => wordIndex === index
          ? "var(--brand-yellow)"
          : "var(--brand-paper)",
      }, token.fromMs / 1000);
    });
    timeline.to(paragraph, {autoAlpha: 0, duration: 0.1}, page.toMs / 1000);
  }

  window.__timelines["${authoring.compositionId}"] = timeline;
})();
`;
}

const BASELINE_CSS = `/*
 * Baseline composition styles.
 * Deliberately restrained: this is a diagnostic baseline, not the showcase. Colours
 * come exclusively from tokens.css.
 */

.backdrop { inset: 0; }

.scene-masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gutter);
}
.scene-masthead .section-number { position: static; }

.scene-footer { align-self: end; }

.body-display { justify-items: start; }
.body-display h1 { max-width: 15ch; }

.body-artifact { justify-items: start; }
.artifact {
  border-left: 0.6rem solid var(--brand-yellow);
  transform: rotate(-1.4deg);
  max-width: 88%;
  display: grid;
  gap: calc(var(--gutter) * 0.3);
}
.artifact h2 { color: var(--brand-ink); }
.artifact h2 em { color: var(--brand-aubergine); }

.accent-field { background: var(--brand-yellow); }
.on-light-scene { color: var(--brand-ink); }
.on-light-scene h1 em { color: var(--brand-aubergine); }
.on-light-scene .rule i { background: var(--brand-aubergine); }

.body-field { justify-items: start; align-content: center; gap: calc(var(--gutter) * 0.7); }
.standalone-wordmark { width: min(46%, 31rem); height: auto; object-fit: contain; }

.body-split {
  grid-template-columns: 1.35fr auto 0.65fr;
  align-items: center;
  gap: calc(var(--gutter) * 0.4);
}
.split-mark { display: grid; place-items: center; position: relative; }
.split-mark i {
  position: absolute;
  width: 5.2em;
  height: 5.2em;
  border: 2px solid var(--brand-yellow);
  border-radius: 50%;
}
.split-mark b { color: var(--brand-yellow); font: 400 3em var(--brand-font-display); }
.split-right { display: grid; gap: calc(var(--gutter) * 0.4); justify-items: start; }

.baseline-slot {
  width: 42%;
  aspect-ratio: 3 / 4;
  justify-self: end;
}
`;
