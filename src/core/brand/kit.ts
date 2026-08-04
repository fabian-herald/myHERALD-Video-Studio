import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {BRAND_DIR} from "../paths.ts";

/** A colour token name is always used as `var(--brand-<name>)` inside compositions. */
const tokenName = z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "token names are lowerCamelCase");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colours are 6-digit hex");

export const LOGO_ROLES = ["wordmark", "seal", "lockup"] as const;
export type LogoRole = (typeof LOGO_ROLES)[number];

export const logoZ = z.object({
  id: z.string(),
  /** `seal` is the mark alone, `wordmark` the words alone, `lockup` both together. */
  role: z.enum(LOGO_ROLES),
  /** The field it is drawn *for*: `light` means dark ink, meant for a light background. */
  theme: z.enum(["light", "dark", "any"]).default("any"),
  file: z.string(),
  /** Clear space around the mark, as a fraction of its own width. */
  safeAreaPct: z.number().min(0).max(1).default(0.25),
  /**
   * Whether the asset already renders the brand tagline. A lockup usually does, and a
   * composition that also typesets it puts the same words on screen twice — which the
   * silent-outro rule used to require, because it had no way to know.
   */
  includesTagline: z.boolean().default(false),
  /** Intrinsic pixel size, so a composition can size the mark without measuring it. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  label: z.string().default(""),
});

export type Logo = z.infer<typeof logoZ>;

/**
 * Foreground/background combinations that have already been checked against WCAG AA.
 * Handing the composer approved pairs is what makes `hyperframes check --contrast`
 * pass on the first attempt instead of the third.
 */
export const colorPairZ = z.object({
  fg: tokenName,
  bg: tokenName,
  minRatio: z.number().min(1).default(4.5),
  usage: z.string().default(""),
});

export const brandKitZ = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  tagline: z.string().default(""),
  website: z.string(),
  logos: z.array(logoZ).default([]),
  color: z.object({
    tokens: z.record(tokenName, hexColor),
    pairs: z.array(colorPairZ).default([]),
  }),
  type: z.object({
    stacks: z.object({
      display: z.string(),
      body: z.string(),
      mono: z.string(),
    }),
    /** Sizes in px against a 1080-wide reference canvas; scaled per format at render. */
    scale: z.record(z.string(), z.number()),
  }),
  motion: z.object({
    easeIn: z.string().default("power2.in"),
    easeOut: z.string().default("power3.out"),
    sceneEnterMs: z.number().default(440),
    staggerMs: z.number().default(45),
    maxSimultaneous: z.number().default(6),
    forbidden: z.array(z.string()).default([]),
  }),
  voice: z.object({
    toneRules: z.array(z.string()).default([]),
    bannedWords: z.array(z.string()).default([]),
    addressAs: z.string().default("you"),
    narrationStyle: z.string().default(""),
    /**
     * Who is speaking, physically — not how they feel about it.
     *
     * Kept apart from `narrationStyle` because they answer different questions and only
     * one of them may vary. A generative TTS model re-decides the speaker on every
     * request, and asked sixteen times for one voice it returned readings from 104 to
     * 200 Hz. Stating the register cut that from 10.6 semitones to 7.3 and took the
     * ceiling from 205 Hz down to 145. Style may shift between sections; this must not.
     */
    narratorRegister: z.string().default(""),
  }),
  doDont: z.object({
    do: z.array(z.string()).default([]),
    dont: z.array(z.string()).default([]),
  }),
});

export type BrandKit = z.infer<typeof brandKitZ>;
export type ColorPair = z.infer<typeof colorPairZ>;

export const KIT_PATH = path.join(BRAND_DIR, "kit.json");

export async function loadBrandKit(kitPath = KIT_PATH): Promise<BrandKit> {
  const raw = await fs.readFile(kitPath, "utf8").catch(() => {
    throw new Error(`No brand kit at ${kitPath}. Seed it before generating a video.`);
  });
  return brandKitZ.parse(JSON.parse(raw));
}

export async function saveBrandKit(kit: BrandKit, kitPath = KIT_PATH) {
  await fs.mkdir(path.dirname(kitPath), {recursive: true});
  await fs.writeFile(kitPath, `${JSON.stringify(brandKitZ.parse(kit), null, 2)}\n`, "utf8");
}

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string) {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

/** Fails loudly when a declared pair does not actually meet its own minimum. */
export function verifyPairs(kit: BrandKit): {pair: ColorPair; ratio: number}[] {
  const failures: {pair: ColorPair; ratio: number}[] = [];
  for (const pair of kit.color.pairs) {
    const fg = kit.color.tokens[pair.fg];
    const bg = kit.color.tokens[pair.bg];
    if (!fg || !bg) {
      failures.push({pair, ratio: 0});
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < pair.minRatio) failures.push({pair, ratio});
  }
  return failures;
}
