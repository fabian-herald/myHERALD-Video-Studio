import fs from "node:fs/promises";
import path from "node:path";
import type {BrandKit} from "../brand/kit.ts";
import {FONT_FILES, writeTokensCss} from "../brand/tokens.ts";
import {FORMATS, referenceFormat, type FormatFamily} from "../plan/formats.ts";
import {languageName} from "../plan/language.ts";
import {ENERGY_MOTION} from "../tts/energy.ts";
import {intentPreset} from "../intents/index.ts";
import {planDurationMs, type Energy, type Intent, type VideoPlan} from "../plan/schema.ts";
import {ROOT} from "../paths.ts";
import {buildCaptions, writeCaptionData} from "../tts/captions.ts";

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
    renderBrief({plan, kit, compositionId, spec, durationSeconds}),
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

A calm piece is not a still one. The point is contrast: a lift only reads as a lift
because the section before it did not.

Keep the sustained motion of §6 in every scene regardless of energy, and scale its
speed the same way — but how far and how fast is your call, not a number in this brief.`;
}

/** The per-composition brief: everything specific to THIS video, in one file. */
function renderBrief(options: {
  plan: VideoPlan;
  kit: BrandKit;
  compositionId: string;
  spec: (typeof FORMATS)[keyof typeof FORMATS];
  durationSeconds: number;
}): string {
  const {plan, kit, compositionId, spec, durationSeconds} = options;
  const seconds = (ms: number) => (ms / 1000).toFixed(3);

  const sections = plan.sections.map((section, index) => {
    const spoken = section.phrases.map((phrase) => phrase.text).join(" ");
    return [
      `### ${index + 1}. \`${section.id}\` — ${section.kind}`,
      "",
      `- element: \`<section id="scene-${section.id}" class="scene clip" data-start="${seconds(section.startMs)}" data-duration="${seconds(section.durationMs)}" data-track-index="${10 + index}">\``,
      `- on-screen copy (**verbatim**): ${section.onScreen ? `\`${section.onScreen}\`` : "_none — visual only_"}`,
      `- must accomplish: ${section.intentNote || "—"}`,
      `- energy: **${section.energy}** — ${ENERGY_MOTION[section.energy].note}`,
      section.mediaId ? `- media: \`media/${section.mediaId}.png\`` : null,
      section.slot ? `- presenter slot: style \`${section.slot.style}\`, ${seconds(section.durationMs)}s` : null,
      `- narration underneath: "${spoken || "(silent)"}"`,
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

## The video

- **Thesis**: ${plan.thesis}
- **Intent**: ${plan.intent}
- **Language**: ${languageName(plan.language)} — all on-screen copy is already in this language, use it verbatim
- **Brief that produced it**: ${plan.brief}
${plan.cta ? `- **CTA**: ${plan.cta.label} → ${plan.cta.url}` : "- **CTA**: none — this piece does not pitch"}

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
- Choose by size as well as field, because role decides how small a mark may go. A
  \`wordmark\` is the name alone and survives the persistent corner slug. A \`lockup\`
  also carries a tagline, and that tagline is illegible below roughly 9% of the frame
  height — so a lockup belongs on a card that gives it room, never in the rail. A
  \`seal\` is the mark alone and reads at any size.
- Place them with \`<img>\`. Constrain one dimension and let the other follow, so the
  mark can never distort: \`.brand-seal img { height: calc(var(--stage-h) * 0.034); width: auto; }\`.
  In the rail, that fraction is the floor, not a target.
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

## Before you finish

\`\`\`bash
npx hyperframes check . --json --strict
npx hyperframes snapshot . --at ${snapshotTimes(durationSeconds)} --no-end --describe false --output snapshots
\`\`\`

Read \`CONTRACT.md\` first — especially section 6. Then look at the snapshots and answer
honestly: **are these frames structurally different from one another?**
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

const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
