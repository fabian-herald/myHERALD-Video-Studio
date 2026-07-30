import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {loadBrandKit, contrastRatio} from "../brand/kit.ts";
import {KNOWLEDGE_DIR} from "../paths.ts";
import {fetchPublic} from "./fetch.ts";
import {containsNumericClaim, readFacts, writeFacts, type ProductFact} from "./facts.ts";

/**
 * Reads a public website and turns it into two kinds of candidate: things the product
 * claims about itself, and the colours and type it presents itself in.
 *
 * Everything this produces is a *proposal*. Facts land in `proposed` and never reach a
 * prompt until the owner approves them in the Brand screen; brand tokens are returned
 * for review and are never written into the kit. That is not politeness — the input is
 * a web page, which is to say text an attacker can author, so nothing here may take
 * effect without a human in between.
 */

const MAX_PAGES = 6;
const MAX_STYLESHEETS = 4;

export const factCandidateZ = z.object({
  kind: z.enum(["audience", "problem", "outcome", "capability", "proof"]),
  statement: z.string(),
  sourceUrl: z.string(),
  needsEvidence: z.boolean(),
});

export type FactCandidate = z.infer<typeof factCandidateZ>;

export interface ColorCandidate {
  hex: string;
  /** How often the colour appears across the site's CSS. */
  count: number;
  /** Where it was used most: a background, text, or something else. */
  role: "surface" | "text" | "accent";
  suggestedToken: string;
  /** Set when the kit already holds this colour, or something within a hair of it. */
  matchesToken?: string;
  /** Contrast against the kit's own page background, so an unusable accent is visible. */
  onSurface: number;
}

export interface FontCandidate {
  stack: string;
  count: number;
  matchesStack?: "display" | "body" | "mono";
}

export interface ResearchResult {
  pages: {url: string; title: string; summary: string; blocks: number}[];
  facts: FactCandidate[];
  colors: ColorCandidate[];
  fonts: FontCandidate[];
  errors: string[];
}

// — HTML to text ————————————————————————————————————————————

const decodeEntities = (value: string) => value
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  // Hex entities before decimal: `&#x27;` is an apostrophe, and left encoded it both
  // reads as mojibake and trips the numeric-claim check on its own digits.
  .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, "\"");

/**
 * HTML to readable text.
 *
 * Exported because `knowledge/figures.ts` feeds this same output to a model, which promotes
 * the three removals above the tag stripper from tidying to a control: a `<script>` body is
 * code an attacker chose, a `<style>` block is thousands of characters of declarations that
 * would eat a prompt budget, and an inline `<svg>` is neither. What survives is the prose
 * a reader would see, which is the only part anyone is being asked to judge.
 */
export const pageText = (value: string) => decodeEntities(
  value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " "),
).replace(/\s+/g, " ").trim();

/** The `<title>`, as text. Shared so `read_source` can name a page without a second regex. */
export const pageTitle = (html: string) =>
  pageText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");

/**
 * A coarse sort into the kit's fact kinds. It is wrong sometimes, which is fine: the
 * owner sees the kind next to the statement and can change it. The point is to arrive
 * at the review screen already grouped rather than as one undifferentiated list.
 */
function classify(text: string): FactCandidate["kind"] {
  if (/\b(?:for|built for|designed for|für|gemacht für)\b[^.]{0,60}\b(?:founders?|teams?|marketers?|creators?|agencies|companies|businesses|gründer|teams?|unternehmen)\b/i.test(text)) return "audience";
  if (/\b(?:struggle|problem|manual|wastes?|stuck|lose|losing|missing|burden|pain|without|instead of|kein|ohne|mühsam|verlieren)\b/i.test(text)) return "problem";
  if (/\b(?:customers?|case study|used by|trusted by|award|certified|ISO|GDPR|DSGVO|kunden|zertifiziert)\b/i.test(text)) return "proof";
  if (/\b(?:turns?|becomes?|get|save|grow|increase|reduce|ship|deliver|so that|damit|spart|wird zu)\b/i.test(text)) return "outcome";
  return "capability";
}

const BOILERPLATE = /^(?:cookie|privacy|datenschutz|terms|agb|impressum|sign in|log in|anmelden|menu|copyright|©|all rights|alle rechte|newsletter|follow us|share)/i;

function extractFacts(html: string, url: string): FactCandidate[] {
  const blocks = [...html.matchAll(/<(h1|h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => pageText(match[2] ?? ""))
    .filter((text) => text.length >= 24 && text.length <= 280)
    .filter((text) => !BOILERPLATE.test(text))
    // A block that is one long run of navigation labels has no sentence in it.
    .filter((text) => /[.!?]|\b\w{4,}\b.*\b\w{4,}\b/.test(text));

  const unique = [...new Map(blocks.map((text) => [text.toLowerCase(), text])).values()].slice(0, 20);
  return unique.map((statement) => ({
    kind: classify(statement),
    statement,
    sourceUrl: url,
    needsEvidence: containsNumericClaim(statement),
  }));
}

// — CSS to brand candidates ————————————————————————————————

const CHANNEL = /^[0-9a-f]{6}$/i;

function normalizeColor(raw: string): string | null {
  const hex = raw.trim().toLowerCase();
  if (hex.startsWith("#")) {
    const digits = hex.slice(1);
    if (digits.length === 3) return `#${digits.split("").map((digit) => digit + digit).join("")}`;
    if (digits.length === 8) return CHANNEL.test(digits.slice(0, 6)) ? `#${digits.slice(0, 6)}` : null;
    return CHANNEL.test(digits) ? `#${digits}` : null;
  }
  const rgb = hex.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map((value) => Math.max(0, Math.min(255, Math.round(Number(value)))));
  if (channels.some((value) => !Number.isFinite(value))) return null;
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

const channels = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

/** Plain RGB distance. Good enough to tell "the same purple" from "a different purple". */
function distance(a: string, b: string): number {
  const [x, y] = [channels(a), channels(b)];
  return Math.sqrt((x[0]! - y[0]!) ** 2 + (x[1]! - y[1]!) ** 2 + (x[2]! - y[2]!) ** 2);
}

function saturation(hex: string): number {
  const [r, g, b] = channels(hex) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

interface Usage {
  count: number;
  background: number;
  text: number;
}

function collectCss(css: string, colors: Map<string, Usage>, fonts: Map<string, number>): void {
  for (const declaration of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
    const property = (declaration[1] ?? "").toLowerCase();
    const value = declaration[2] ?? "";

    if (property === "font-family") {
      // Build tools emit synthetic metric-matching families ("DM Sans Fallback").
      // They are not typefaces anyone chose, so they never reach the report.
      const stack = value
        .replace(/["']/g, "")
        .split(",")
        .map((family) => family.replace(/\s+/g, " ").trim().toLowerCase())
        .filter((family) => family && !family.endsWith("fallback"))
        .join(", ");
      if (stack && !stack.startsWith("var(") && stack.length < 200) {
        fonts.set(stack, (fonts.get(stack) ?? 0) + 1);
      }
      continue;
    }
    // Shadows and outlines are almost always near-black at low alpha. They say
    // nothing about a brand and would otherwise dominate the count.
    if (/shadow|outline/.test(property)) continue;
    if (!/color|background|border|fill|stroke/.test(property)) continue;

    for (const raw of value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) {
      // A translucent colour is a scrim over something else, not the colour itself.
      const alpha = raw[0].match(/rgba\(\s*[^)]*?,\s*([\d.]+)\s*\)$/)?.[1];
      if (alpha !== undefined && Number(alpha) < 0.9) continue;
      const hex = normalizeColor(raw[0]);
      if (!hex) continue;
      const usage = colors.get(hex) ?? {count: 0, background: 0, text: 0};
      usage.count += 1;
      if (property.includes("background")) usage.background += 1;
      else if (property === "color" || property === "fill") usage.text += 1;
      colors.set(hex, usage);
    }
  }
}

/** Same-origin stylesheet URLs, plus any inline `<style>` content. */
function styleSources(html: string, baseUrl: string): {inline: string[]; hrefs: string[]} {
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? "");
  const base = new URL(baseUrl);
  const hrefs: string[] = [];
  for (const link of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = link[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, base);
      // Third-party CSS describes someone else's brand, not this one.
      if (resolved.host === base.host) hrefs.push(resolved.toString());
    } catch {
      // A malformed href is simply skipped.
    }
  }
  return {inline, hrefs};
}

// — the pass ————————————————————————————————————————————————

/**
 * Everything except the network. Kept separate so the extraction can be tested against
 * a fixture without either mocking `fetch` or punching a hole in the address guard.
 */
export function extractPage(html: string, url: string, into: {colors: Map<string, Usage>; fonts: Map<string, number>}) {
  const title = pageTitle(html);
  const summary = pageText(
    html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i)?.[1]
    ?? "",
  );
  const facts = extractFacts(html, url);
  const {inline, hrefs} = styleSources(html, url);
  for (const css of inline) collectCss(css, into.colors, into.fonts);
  return {page: {url, title, summary, blocks: facts.length}, facts, hrefs};
}

export {rankColors, rankFonts};
export type {Usage};

export async function researchSite(urls: readonly string[]): Promise<ResearchResult> {
  const kit = await loadBrandKit();
  const surface = kit.color.tokens.surface ?? kit.color.tokens.paper ?? "#FFFFFF";

  const result: ResearchResult = {pages: [], facts: [], colors: [], fonts: [], errors: []};
  const usage = {colors: new Map<string, Usage>(), fonts: new Map<string, number>()};
  const seenSheets = new Set<string>();

  for (const raw of urls.slice(0, MAX_PAGES)) {
    let document;
    try {
      document = await fetchPublic(raw);
    } catch (error) {
      result.errors.push(`${raw}: ${(error as Error).message}`);
      continue;
    }

    const {page, facts, hrefs} = extractPage(document.body, document.finalUrl, usage);
    result.pages.push(page);
    result.facts.push(...facts);

    for (const href of hrefs) {
      if (seenSheets.size >= MAX_STYLESHEETS || seenSheets.has(href)) continue;
      seenSheets.add(href);
      try {
        const sheet = await fetchPublic(href, ["text/css"]);
        collectCss(sheet.body, usage.colors, usage.fonts);
      } catch (error) {
        result.errors.push(`${href}: ${(error as Error).message}`);
      }
    }
  }

  // The same sentence on three pages is one fact.
  result.facts = [...new Map(result.facts.map((fact) => [fact.statement.toLowerCase(), fact])).values()];

  result.colors = rankColors(usage.colors, kit.color.tokens, surface);
  result.fonts = rankFonts(usage.fonts, kit.type.stacks);
  return result;
}

function rankColors(
  usage: Map<string, Usage>,
  tokens: Record<string, string>,
  surface: string,
): ColorCandidate[] {
  const ranked = [...usage.entries()]
    .filter(([, use]) => use.count >= 2)
    .sort((a, b) => b[1].count - a[1].count);

  const chosen: ColorCandidate[] = [];
  for (const [hex, use] of ranked) {
    if (chosen.length >= 10) break;
    // Two hexes four units apart are the same colour to a human eye.
    if (chosen.some((candidate) => distance(candidate.hex, hex) < 12)) continue;

    const role: ColorCandidate["role"] = use.background >= use.text && use.background > 0
      ? "surface"
      : use.text > 0 ? "text" : "accent";

    const match = Object.entries(tokens)
      .map(([name, value]) => ({name, delta: distance(value.toLowerCase(), hex)}))
      .sort((a, b) => a.delta - b.delta)[0];

    chosen.push({
      hex,
      count: use.count,
      role,
      suggestedToken: `site${role[0]!.toUpperCase()}${role.slice(1)}${chosen.filter((c) => c.role === role).length + 1}`,
      ...(match && match.delta < 20 ? {matchesToken: match.name} : {}),
      onSurface: Number(contrastRatio(hex, surface).toFixed(2)),
    });
  }

  // A saturated colour nobody uses much is still the more interesting find than the
  // seventh shade of grey, so surface accents above low-signal neutrals.
  return chosen.sort((a, b) => (saturation(b.hex) > 0.15 ? 1 : 0) - (saturation(a.hex) > 0.15 ? 1 : 0) || b.count - a.count);
}

function rankFonts(usage: Map<string, number>, stacks: {display: string; body: string; mono: string}): FontCandidate[] {
  const named = Object.entries(stacks) as [FontCandidate["matchesStack"] & string, string][];
  return [...usage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([stack, count]) => {
      const first = stack.split(",")[0]?.trim() ?? "";
      const match = named.find(([, value]) => value.toLowerCase().includes(first) && first.length > 2);
      return {stack, count, ...(match ? {matchesStack: match[0]} : {})};
    });
}

// — persistence ————————————————————————————————————————————

const SOURCES_PATH = path.join(KNOWLEDGE_DIR, "sources.json");

export interface SourceRecord {
  url: string;
  title: string;
  summary: string;
  fetchedAt: string;
  excerpts: string[];
}

export async function readSources(): Promise<SourceRecord[]> {
  const raw = await fs.readFile(SOURCES_PATH, "utf8").catch(() => "[]");
  try {
    return JSON.parse(raw) as SourceRecord[];
  } catch {
    return [];
  }
}

/**
 * Writes the candidates in as `proposed` facts and records what was on the page when
 * they were taken, so an approval a week later can be checked against the wording that
 * produced it.
 */
export async function saveResearch(result: ResearchResult): Promise<{added: number; skipped: number}> {
  const existing = await readFacts();
  const known = new Set(existing.map((fact) => fact.statement.trim().toLowerCase()));

  const additions: ProductFact[] = result.facts
    .filter((candidate) => !known.has(candidate.statement.trim().toLowerCase()))
    .map((candidate, index) => ({
      id: `f-${Date.now().toString(36)}-${index}`,
      kind: candidate.kind,
      statement: candidate.statement,
      // Deliberately empty for a numeric claim: an approved fact carrying a number
      // without an evidence note is withheld from prompts, which is the behaviour we
      // want for a figure nobody has checked yet.
      evidence: "",
      state: "proposed" as const,
      source: candidate.sourceUrl,
      updatedAt: new Date().toISOString(),
    }));

  await writeFacts([...existing, ...additions]);

  const sources = await readSources();
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  for (const page of result.pages) {
    byUrl.set(page.url, {
      url: page.url,
      title: page.title,
      summary: page.summary,
      fetchedAt: new Date().toISOString(),
      excerpts: result.facts.filter((fact) => fact.sourceUrl === page.url).map((fact) => fact.statement),
    });
  }
  await fs.mkdir(KNOWLEDGE_DIR, {recursive: true});
  await fs.writeFile(SOURCES_PATH, `${JSON.stringify([...byUrl.values()], null, 2)}\n`, "utf8");

  return {added: additions.length, skipped: result.facts.length - additions.length};
}
