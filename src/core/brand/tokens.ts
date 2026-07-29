import fs from "node:fs/promises";
import path from "node:path";
import type {BrandKit} from "./kit.ts";

export const TOKEN_PREFIX = "--brand-";

/** Local brand faces. Rendering must never touch the network, so these are vendored. */
const FONT_FACES: {family: string; weight: number; file: string}[] = [
  {family: "DM Serif Display", weight: 400, file: "dm-serif-display-latin-400-normal.woff2"},
  {family: "DM Sans", weight: 400, file: "dm-sans-latin-400-normal.woff2"},
  {family: "DM Sans", weight: 500, file: "dm-sans-latin-500-normal.woff2"},
  {family: "DM Sans", weight: 700, file: "dm-sans-latin-700-normal.woff2"},
  {family: "JetBrains Mono", weight: 400, file: "jetbrains-mono-latin-400-normal.woff2"},
  {family: "JetBrains Mono", weight: 700, file: "jetbrains-mono-latin-700-normal.woff2"},
];

export const FONT_FILES = FONT_FACES.map((face) => face.file);

/**
 * Names used before the brand guide v1.1 palette became canonical. Emitted so the
 * four videos composed against the old names still re-render, and nothing more —
 * they are deliberately absent from the palette the composer is shown.
 */
const LEGACY_ALIASES: Record<string, string> = {
  aubergine: "purple",
  deep: "nearBlack",
  ink: "nearBlack",
  paper: "background",
  lilac: "lightPurple",
  rule: "borderStrong",
  positive: "purple",
  mint: "lightPurple",
};

/** Every colour literal a composition is allowed to contain, as lowercase hex. */
export function allowedColorLiterals(kit: BrandKit): Set<string> {
  return new Set(Object.values(kit.color.tokens).map((value) => value.toLowerCase()));
}

const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * The single source of truth for every colour, font and motion constant a
 * composition may use. Generated on every run — never hand-edited, never committed.
 */
export function renderTokensCss(kit: BrandKit): string {
  const lines: string[] = [
    "/* GENERATED from data/brand/kit.json — do not edit. Regenerate with `npm run tokens`. */",
    "",
    ...FONT_FACES.map((face) => [
      "@font-face {",
      `  font-family: "${face.family}";`,
      `  font-weight: ${face.weight};`,
      "  font-style: normal;",
      "  font-display: block;",
      `  src: url("./fonts/${face.file}") format("woff2");`,
      "}",
    ].join("\n")),
    "",
    ":root {",
  ];

  for (const [name, value] of Object.entries(kit.color.tokens)) {
    lines.push(`  ${TOKEN_PREFIX}${kebab(name)}: ${value};`);
  }

  const aliases = Object.entries(LEGACY_ALIASES)
    .filter(([, target]) => kit.color.tokens[target]);
  if (aliases.length) {
    lines.push("");
    lines.push("  /* Legacy names, kept so older compositions still re-render. */");
    for (const [alias, target] of aliases) {
      lines.push(`  ${TOKEN_PREFIX}${kebab(alias)}: var(${TOKEN_PREFIX}${kebab(target)});`);
    }
  }
  lines.push("");
  lines.push(`  ${TOKEN_PREFIX}font-display: ${kit.type.stacks.display};`);
  lines.push(`  ${TOKEN_PREFIX}font-body: ${kit.type.stacks.body};`);
  lines.push(`  ${TOKEN_PREFIX}font-mono: ${kit.type.stacks.mono};`);
  lines.push("");
  for (const [name, size] of Object.entries(kit.type.scale)) {
    lines.push(`  ${TOKEN_PREFIX}size-${kebab(name)}: ${size}px;`);
  }
  lines.push("");
  lines.push(`  ${TOKEN_PREFIX}ease-in: ${kit.motion.easeIn};`);
  lines.push(`  ${TOKEN_PREFIX}ease-out: ${kit.motion.easeOut};`);
  lines.push(`  ${TOKEN_PREFIX}scene-enter: ${kit.motion.sceneEnterMs}ms;`);
  lines.push(`  ${TOKEN_PREFIX}stagger: ${kit.motion.staggerMs}ms;`);
  lines.push("}");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeTokensCss(kit: BrandKit, target: string) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, renderTokensCss(kit), "utf8");
}

/**
 * The token-only lint. Any colour literal in authored CSS that is not a brand token
 * is a hard error — this is what makes palette drift structurally impossible
 * instead of merely discouraged.
 */
export function findRogueColors(css: string, kit: BrandKit): {line: number; literal: string}[] {
  const allowed = allowedColorLiterals(kit);
  const rogue: {line: number; literal: string}[] = [];
  const pattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;

  css.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\/\*.*?\*\//g, "");
    for (const match of line.matchAll(pattern)) {
      const literal = match[0];
      // Translucent overlays derived from a token are unavoidable in CSS and are
      // allowed as long as the underlying colour is a token or a neutral.
      if (/^(rgba?|hsla?)\(/i.test(literal)) {
        if (isNeutralAlpha(literal)) continue;
        rogue.push({line: index + 1, literal});
        continue;
      }
      const normalised = expandHex(literal);
      if (!normalised || allowed.has(normalised)) continue;
      rogue.push({line: index + 1, literal});
    }
  });
  return rogue;
}

/** `rgba(0,0,0,.3)` and `rgba(255,255,255,.2)` are neutral scrims, not brand colours. */
function isNeutralAlpha(literal: string) {
  const numbers = literal.match(/[\d.]+/g)?.map(Number) ?? [];
  if (numbers.length < 4) return false;
  const [r, g, b] = numbers as [number, number, number, number];
  const isBlack = r === 0 && g === 0 && b === 0;
  const isWhite = r === 255 && g === 255 && b === 255;
  return isBlack || isWhite;
}

function expandHex(literal: string): string | null {
  const value = literal.slice(1).toLowerCase();
  if (value.length === 3) return `#${value.split("").map((c) => c + c).join("")}`;
  if (value.length === 6) return `#${value}`;
  if (value.length === 8) return `#${value.slice(0, 6)}`;
  return null;
}
