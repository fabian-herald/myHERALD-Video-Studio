import fs from "node:fs/promises";
import path from "node:path";
import type {BrandKit} from "../brand/kit.ts";
import {FONT_FILES, writeTokensCss} from "../brand/tokens.ts";
import {FORMATS, referenceFormat, type FormatFamily} from "../plan/formats.ts";
import {languageName} from "../plan/language.ts";
import {ENERGY_MOTION} from "../tts/energy.ts";
import {intentPreset} from "../intents/index.ts";
import {dataBarGeometry, planDurationMs, type DataSeries, type Energy, type Intent, type ScreenSpec, type VideoPlan} from "../plan/schema.ts";
import {ROOT} from "../paths.ts";
import {buildCaptions, writeCaptionData} from "../tts/captions.ts";
import {FREEZE_BAR_MS, stillBriefLine, worstStillWindows, type StillWindow} from "./still.ts";

export const FPS = 30;
export const NARRATION_FILE = "narration.m4a";

const COMPOSE_SRC = path.join(ROOT, "src", "core", "compose");

/** Linked in this order, before the composition's own styles.css. */
export const BLOCK_FILES = [
  "base.css",
  "brand-rail.css",
  "editorial.css",
  "cta-lockup.css",
  "presenter-slot.css",
  "screen.css",
  "caption-layer.css",
] as const;

export interface AuthoringDir {
  dir: string;
  compositionId: string;
  family: FormatFamily;
  width: number;
  height: number;
  durationSeconds: number;
}

/**
 * Lay out everything the composer needs and nothing it doesn't: generated tokens,
 * block primitives, the exemplar, vendored GSAP, the measured caption data and the
 * mastered narration. The composer writes exactly three files in here.
 */
export async function prepareAuthoringDir(options: {
  plan: VideoPlan;
  kit: BrandKit;
  family: FormatFamily;
  dir: string;
  narrationPath: string;
  mediaFiles?: readonly {id: string; path: string}[];
}): Promise<AuthoringDir> {
  const {plan, kit, family, dir, narrationPath, mediaFiles = []} = options;
  const spec = FORMATS[referenceFormat(family)];
  const durationSeconds = Number((planDurationMs(plan) / 1000).toFixed(3));
  const compositionId = `${plan.id}-${family}`;

  await fs.rm(path.join(dir, "blocks"), {recursive: true, force: true});
  await fs.mkdir(path.join(dir, "blocks"), {recursive: true});
  await fs.mkdir(path.join(dir, "vendor"), {recursive: true});
  await fs.mkdir(path.join(dir, "media"), {recursive: true});

  await writeTokensCss(kit, path.join(dir, "tokens.css"));
  await fs.mkdir(path.join(dir, "fonts"), {recursive: true});
  for (const file of FONT_FILES) {
    await fs.copyFile(
      path.join(ROOT, "data", "brand", "fonts", file),
      path.join(dir, "fonts", file),
    );
  }
  for (const block of BLOCK_FILES) {
    await fs.copyFile(path.join(COMPOSE_SRC, "blocks", block), path.join(dir, "blocks", block));
  }
  await fs.cp(path.join(COMPOSE_SRC, "exemplar"), path.join(dir, "exemplar"), {recursive: true});
  await fs.copyFile(path.join(ROOT, "vendor", "gsap.min.js"), path.join(dir, "vendor", "gsap.min.js"));
  await fs.copyFile(narrationPath, path.join(dir, NARRATION_FILE));
  await writeCaptionData(buildCaptions(plan), path.join(dir, "caption-data.js"));

  for (const logo of kit.logos) {
    await fs.copyFile(
      path.join(ROOT, "data", "brand", logo.file),
      path.join(dir, "media", `logo-${logo.id}${path.extname(logo.file)}`),
    ).catch(() => {});
  }
  for (const media of mediaFiles) {
    await fs.copyFile(media.path, path.join(dir, "media", `${media.id}${path.extname(media.path)}`));
  }

  await fs.writeFile(
    path.join(dir, "hyperframes.json"),
    `${JSON.stringify({media: {autoProxy: true}}, null, 2)}\n`,
    "utf8",
  );
  await fs.copyFile(path.join(COMPOSE_SRC, "CONTRACT.md"), path.join(dir, "CONTRACT.md"));
  await fs.writeFile(
    path.join(dir, "BRIEF.md"),
    renderBrief({
      plan,
      kit,
      compositionId,
      spec,
      durationSeconds,
      mediaFiles: mediaFiles.map((media) => `${media.id}${path.extname(media.path)}`),
    }),
    "utf8",
  );

  return {
    dir,
    compositionId,
    family,
    width: spec.width,
    height: spec.height,
    durationSeconds,
  };
}

/**
 * The motion section of the brief, in absolute milliseconds.
 *
 * Two reasons it is generated rather than written. First, the composer should not be
 * doing arithmetic: it gets the number to type, not a baseline and two multipliers.
 * Second, the prose used to be a hand-copied duplicate of `ENERGY_MOTION` and had
 * already drifted — the table still told the composer that `quiet` meant "long holds"
 * months after that exact wording made a composition fail the post-render freeze check
 * and the table in code was corrected. Deriving it from the one table makes that
 * impossible rather than unlikely.
 */
export function motionBrief(kit: BrandKit, intent: Intent): string {
  const {scale, simultaneousDelta, note} = intentPreset(intent).motion;
  const enterMs = kit.motion.sceneEnterMs * scale;
  const rows = (Object.entries(ENERGY_MOTION) as [Energy, (typeof ENERGY_MOTION)[Energy]][])
    .map(([energy, {pace, note: feel}]) =>
      `| \`${energy}\` | ${Math.round(enterMs * pace)}ms | ${Math.round(kit.motion.staggerMs * scale * pace)}ms | ${feel} |`)
    .join("\n");

  return `Easing: ease-out \`${kit.motion.easeOut}\`, ease-in \`${kit.motion.easeIn}\`.
At most ${kit.motion.maxSimultaneous + simultaneousDelta} things moving at once.
Forbidden motion: ${kit.motion.forbidden.join(", ")}.

**Motion follows the energy curve.** Every section lists its own energy above. These are
its timings, already scaled for \`${intent}\` — ${note}. Use them as written:

| energy | entrance | stagger | what it should feel like |
|---|---|---|---|
${rows}

A calm piece can hold still long enough to read. The point is contrast: a lift only reads
as a lift because the section before it did not. Long scenes still need visual development,
but that comes from meaningful staged beats rather than an object drifting for the entire
section. No element is required to remain in motion. A continuous brand accent means visual
continuity, not a global spine, node, grid or field animating for the entire runtime.

**How much motion is enough is not a matter of taste here — it is measured.** Each
section above states the longest stretch in which the caption layer holds still, and the
finished file is scanned with \`freezedetect=n=0.001:d=${FREEZE_BAR_MS / 1000}\`. That filter
averages the change across the *entire* frame, so a meaningful beat needs visible area: a
large reveal, a state change, a comparison, a counter, or a transition. A one-pixel rule
does not register, however far it goes. After the beat resolves, the scene may hold.`;
}

/**
 * A screenshot section, as instructions.
 *
 * Focus rects are given as percentages of the image because that is what they are in the
 * plan — the composer computes a scale and an origin from them, and the same arithmetic
 * holds at every output size. Times are relative to the section for the same reason the
 * schema stores them that way: an edit to an earlier section must not move these.
 */
export function screenBrief(screen: ScreenSpec): string {
  const chrome = {
    contain: "on a bare `.screen-stage`",
    "device-frame": "inside `.screen-frame` wrapping a `.screen-stage`",
    "browser-chrome": "inside `.screen-window` — put the real URL in `.window-url`",
  }[screen.fit];

  const moves = screen.focus.length
    ? screen.focus.map((focus) => {
      const [x, y, w, h] = focus.rect;
      const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
      return `  - at **+${(focus.atMs / 1000).toFixed(2)}s** into the section, frame `
        + `x ${pct(x)}, y ${pct(y)}, w ${pct(w)}, h ${pct(h)}`
        + (focus.label ? ` — label it \`${focus.label}\`` : "");
    }).join("\n")
    : "  - none: keep the shot stable for readability; use a purposeful reveal or crop change only if the section needs a later visual beat";

  return `- screen: \`media/${screen.mediaId}.png\` ${chrome}\n`
    + `- focus (scale \`.screen-shot\` and set \`transform-origin\` to each rect's centre):\n${moves}`;
}

/**
 * A sourced figure, as instructions.
 *
 * The shape is offered and then explicitly withdrawn as a requirement, because the point
 * of not making this a section kind was to keep the composer deciding. What is not
 * negotiable is the attribution: the values arrive with a fact behind each one, and a
 * figure on screen without its source is the defect this whole path exists to avoid.
 */
export function dataBrief(data: DataSeries): string {
  // "62%" not "62 %": a symbol unit sits against the figure, a word unit takes a space.
  // The composer types this string verbatim, so the spacing here is the spacing on screen.
  const unit = data.unit ? (/^[%°$€£]$/.test(data.unit) ? data.unit : ` ${data.unit}`) : "";
  const points = dataBarGeometry(data)
    .map((point) => {
      return `  - ${point.label}: **${point.value}${unit}** — final bar fill **${point.fill.toFixed(3)}** `
        + `(data-value="${point.value}" data-max="${point.max}")`;
    })
    .join("\n");

  return `- data (${data.points.length} figures, suggested as \`${data.shape}\` — `
    + `choose another form if the scene reads better for it):\n${points}\n`
    + `- source note (render it, in \`.data-source\`): \`${data.caption || "source required"}\`\n`
    + "- if you use bars, put `data-value`, `data-max` and the declared final `--fill` on each "
    + "`.data-bar`, for example `<div class=\"data-bar\" data-value=\"25\" data-max=\"100\" "
    + "style=\"--fill: .25\"><span></span></div>`; animate **from 0 to that declared final fill**, "
    + "never every bar to 1\n"
    + "- a `.data-figure` counts up rather than appearing at its final value";
}

/**
 * Everything in the authoring directory, listed.
 *
 * Because the alternative is the composer finding out. One attempt died at
 * `error_max_turns` having spent its budget on `ls -la`, `ls -R`, `find exemplar` and a
 * `cat` of two files — every one of them refused by the sandbox, so it learned nothing
 * and paid a turn each time. This module wrote those files; it knows exactly what is
 * there, and a list costs nothing.
 *
 * Derived from the same constants `prepareAuthoringDir` copies from, so a file added
 * there appears here rather than quietly going undocumented.
 */
function directoryManifest(kit: BrandKit, mediaFiles: readonly string[]): string {
  const lines = [
    "`CONTRACT.md`, `BRIEF.md` — read both, in that order",
    "`tokens.css` — the generated brand tokens, linked first",
    ...BLOCK_FILES.map((block) => `\`blocks/${block}\``),
    "`exemplar/` — a complete worked composition: `index.html`, `styles.css`, `animation.js`",
    "`vendor/gsap.min.js` — linked for you",
    `\`${NARRATION_FILE}\` — the mastered narration`,
    "`caption-data.js` — measured caption pages, already linked; read `window.__captionData`",
    "`hyperframes.json` — project config",
    ...kit.logos.map((logo) => `\`media/logo-${logo.id}${path.extname(logo.file)}\``),
    ...mediaFiles.map((file) => `\`media/${file}\``),
  ];

  return `## What is in this directory

You do not need to look. This is all of it:

${lines.map((line) => `- ${line}`).join("\n")}

Everything except the three files you write is provided and must not be modified. Use
\`Read\` and \`Glob\` to look at any of it — the shell is restricted to the HyperFrames CLI,
so \`ls\`, \`cat\`, \`find\` and \`head\` are refused and cost you a turn for nothing.`;
}

/** The per-composition brief: everything specific to THIS video, in one file. */
function renderBrief(options: {
  plan: VideoPlan;
  kit: BrandKit;
  compositionId: string;
  spec: (typeof FORMATS)[keyof typeof FORMATS];
  durationSeconds: number;
  mediaFiles: readonly string[];
}): string {
  const {plan, kit, compositionId, spec, durationSeconds, mediaFiles} = options;
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const stillest = new Map(worstStillWindows(plan).map((window) => [window.sectionId, window]));

  const sections = plan.sections.map((section, index) => {
    const spoken = section.phrases.map((phrase) => phrase.text).join(" ");
    return [
      `### ${index + 1}. \`${section.id}\` — ${section.kind}`,
      "",
      `- element: \`<section id="scene-${section.id}" class="scene clip" data-start="${seconds(section.startMs)}" data-duration="${seconds(section.durationMs)}" data-track-index="${10 + index}">\``,
      `- on-screen copy (**verbatim**): ${section.onScreen ? `\`${section.onScreen}\`` : "_none — visual only_"}`,
      `- must accomplish: ${section.intentNote || "—"}`,
      `- energy: **${section.energy}** — ${ENERGY_MOTION[section.energy].note}`,
      section.mediaId && !section.screen ? `- media: \`media/${section.mediaId}.png\`` : null,
      section.screen ? screenBrief(section.screen) : null,
      section.data ? dataBrief(section.data) : null,
      section.slot ? `- presenter slot: style \`${section.slot.style}\`, ${seconds(section.durationMs)}s` : null,
      `- narration underneath: "${spoken || "(silent)"}"`,
      stillest.has(section.id) ? stillBriefLine(stillest.get(section.id) as StillWindow) : null,
      "",
    ].filter(Boolean).join("\n");
  }).join("\n");

  const pairs = kit.color.pairs
    .map((pair) => `- \`var(--brand-${kebab(pair.fg)})\` on \`var(--brand-${kebab(pair.bg)})\` — ${pair.usage}`)
    .join("\n");

  const tokens = Object.keys(kit.color.tokens)
    .map((name) => `\`--brand-${kebab(name)}\``)
    .join(" · ");

  const logos = kit.logos.length
    ? kit.logos.map((logo) => {
      const size = logo.width && logo.height ? `${logo.width}×${logo.height}` : "unknown size";
      return `- \`media/logo-${logo.id}${path.extname(logo.file)}\` — **${logo.role}**, for `
        + `${logo.theme === "any" ? "any field" : `${logo.theme} fields`}, ${size}, `
        + `clear space ${Math.round(logo.safeAreaPct * 100)}%. ${logo.label}`;
    }).join("\n")
    : "_None supplied. Stay typographic and do not invent a mark._";

  return `# Compose: ${plan.title}

${directoryManifest(kit, mediaFiles)}

## The video

- **Thesis**: ${plan.thesis}
- **Intent**: ${plan.intent}
- **Language**: ${languageName(plan.language)} — all on-screen copy is already in this language, use it verbatim
- **Brief that produced it**: ${plan.brief}
${plan.cta ? `- **CTA**: ${plan.cta.label} → ${plan.cta.url}` : "- **CTA**: none — this piece does not pitch"}

For a deliberately silent final \`outro\`, do not leave a logo floating by itself. It is an
identity card, not a promotion: use one canonical full lockup, show the factual descriptor
\`${kit.tagline}\` as readable text, and show \`${kit.website}\`. Do not add an instruction such
as buy, try, follow, subscribe or click. Stage the three elements in, then leave the resolved
card readable; the measured section timing already includes the minimum loop-safe hold.

## Canvas

Reference canvas ${spec.width}×${spec.height} (${spec.label}). The same composition is
re-emitted at other sizes in this family, so lay out with flow and derived units.

Use this root element **verbatim**:

\`\`\`html
<main
  id="stage"
  data-composition-id="${compositionId}"
  data-start="0"
  data-duration="${durationSeconds}"
  data-width="${spec.width}"
  data-height="${spec.height}"
  data-format="${spec.format}"
  data-fps="${FPS}"
  style="--stage-w: ${spec.width}px; --stage-h: ${spec.height}px;"
>
\`\`\`

Head — verbatim, tokens first, your styles.css last:

\`\`\`html
<link rel="stylesheet" href="./tokens.css" />
${BLOCK_FILES.map((block) => `<link rel="stylesheet" href="./blocks/${block}" />`).join("\n")}
<link rel="stylesheet" href="./styles.css" />
\`\`\`

Tail — verbatim, inside \`#stage\`, after your scenes:

\`\`\`html
<div id="caption-layer" class="caption-layer clip" data-start="0" data-duration="${durationSeconds}" data-track-index="90" aria-live="off"></div>
<audio id="narration" class="clip" src="./${NARRATION_FILE}" data-start="0" data-duration="${durationSeconds}" data-track-index="95" data-volume="0.9"></audio>
<script src="./vendor/gsap.min.js"></script>
<script src="./caption-data.js"></script>
<script>window.__timelines = window.__timelines || {};</script>
<script src="./animation.js"></script>
\`\`\`

\`animation.js\` must build the caption pages from \`window.__captionData\` (see
\`exemplar/animation.js\` for the exact pattern) and register the paused timeline as
\`window.__timelines["${compositionId}"]\`.

## Sections

Timings below are measured from real narration audio. **Use them exactly.**

${sections}

## Logos

These files are already in \`media/\`. **Never set the brand's name as type.** The
wordmark is two different faces at two sizes on one baseline, and hand-setting it gets
it wrong every time. Use the file.

${logos}

- Choose by field: a \`light\` file carries dark ink and belongs on a light background,
  a \`dark\` file is cream and belongs on the deep purple field. A file marked
  **any field** carries its own background and needs no such choice.
- The persistent top-left brand rail must use one supplied **full lockup** file as a single
  \`<img>\`. Do not reconstruct the identity from a separate seal and wordmark, and do not
  add a typeset descriptor that competes with the lockup. Give the lockup enough height for
  its tagline to remain readable; design the rail around the asset rather than shrinking it.
- A silent brand-signature or CTA outro must also use one supplied full lockup file, never
  the wordmark alone. Use the field-appropriate light/dark asset or the self-contained plate.
  A non-promotional outro also shows the brand tagline and website as readable text;
  that context identifies the author without becoming a call to action.
- Elsewhere, choose by size and purpose: \`wordmark\` is the name alone, \`lockup\` carries
  seal, name and tagline, and \`seal\` is the mark alone.
- Place every mark with \`<img>\`. Constrain one dimension and let the other follow so it
  can never distort.
- Leave clear space around the mark of at least the fraction given, measured against its
  own width. Nothing else goes inside that margin.
- Never crop, recolour, rotate, stretch, add effects to, or place a busy image behind
  one of these files.
- Writing "myHERALD" inside a *sentence* is ordinary text and stays text. This rule is
  about the mark itself: the corner slug, the outro lockup, any standalone appearance.

## Brand

Available colour tokens: ${tokens}

Approved contrast pairs — use only these combinations:

${pairs}

Type scale: ${Object.keys(kit.type.scale).map((k) => `\`--brand-size-${kebab(k)}\``).join(" · ")}

${motionBrief(kit, plan.intent)}

**Do**
${kit.doDont.do.map((rule) => `- ${rule}`).join("\n")}

**Don't**
${kit.doDont.dont.map((rule) => `- ${rule}`).join("\n")}

Banned words (must not appear on screen): ${kit.voice.bannedWords.join(", ")}.

## After authoring

Return after writing the three composition files. The Studio pipeline runs the strict
HyperFrames check and renders two temporal frames per section outside the model sandbox.
It then supplies those exact images in a separate visual-review turn using the same rubric
for every composer backend. Do not start a server or create snapshots here.
`;
}

/** Evenly spaced samples. Used when there is no plan to sample against. */
export function snapshotTimes(durationSeconds: number, count = 8): string {
  return Array.from({length: count}, (_, index) =>
    ((index + 0.5) * (durationSeconds / count)).toFixed(2)).join(",");
}

/**
 * One sample per section, taken just past its entrance.
 *
 * Even spacing shows some scenes twice and misses others entirely, which defeats the
 * purpose of the sheet: it exists to answer "is every scene structurally different?",
 * and that needs every scene in it exactly once.
 */
export function sectionSnapshotTimes(plan: VideoPlan): string {
  return plan.sections
    .filter((section) => section.durationMs > 0)
    .map((section) => {
      const settled = section.startMs + Math.min(900, section.durationMs * 0.45);
      const midpoint = section.startMs + section.durationMs * 0.55;
      return (Math.max(settled, midpoint) / 1000).toFixed(2);
    })
    .join(",");
}

/**
 * Two samples per section for visual review: one after the entrance and one after the
 * section's later visual beat. Comparing the pair exposes pointless drift and scenes that
 * never develop, neither of which a single representative still can reveal.
 */
export function sectionReviewTimes(plan: VideoPlan): string {
  return plan.sections
    .filter((section) => section.durationMs > 0)
    .flatMap((section) => {
      const early = section.startMs + Math.min(900, section.durationMs * 0.28);
      const late = section.startMs + Math.max(
        Math.min(section.durationMs - 180, section.durationMs * 0.76),
        Math.min(section.durationMs - 120, section.durationMs * 0.58),
      );
      return [early, late];
    })
    .map((atMs) => (atMs / 1000).toFixed(2))
    .join(",");
}

const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
