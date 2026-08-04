/**
 * How much a visual review actually changed.
 *
 * The second review pass is a high-effort vision session plus the browser render that
 * feeds it — the most expensive thing the pipeline does per attempt. It used to run on any
 * change at all, which meant a reviewer nudging one padding value bought a full second
 * opinion. Measured across twelve runs the edit sizes separate cleanly: a cosmetic nudge is
 * one to six lines, a mechanical repair two to twenty-two, and a genuine re-author over
 * seventeen hundred. The threshold sits in that gap.
 */

export type CompositionSnapshot = Record<string, string>;

export interface EditDelta {
  /** Added plus removed lines across every file, after normalisation. */
  changedLines: number;
  /** An element, a tween or a rule block appeared or disappeared. */
  structural: boolean;
  /** Names of the files that differ, in the order given. */
  files: string[];
}

/**
 * Ten, plus the structural escape hatch. Exported rather than inlined so it can be retuned
 * from the `timing.json` of accumulated runs instead of by argument.
 */
export const SUBSTANTIVE_LINES = 10;

/**
 * Reformatting is not revision. Trailing whitespace and blank lines are dropped entirely —
 * in HTML, CSS and JS a blank line carries no meaning, so counting one as an edit would let
 * a composer that merely re-spaced a block read as if it had rewritten one.
 */
function normalise(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "");
}

/** Counts whose change means something was added or removed, not merely retuned. */
function structuralCounts(file: string, body: string): number[] {
  if (file.endsWith(".html")) return [(body.match(/<[a-zA-Z][^>]*>/g) ?? []).length];
  if (file.endsWith(".js")) return [(body.match(/\b(?:gsap|timeline)\s*\.\s*[a-zA-Z]/g) ?? []).length];
  if (file.endsWith(".css")) return [(body.match(/\{/g) ?? []).length];
  return [];
}

/** Line-level difference count. Order-insensitive: a moved block reads as unchanged. */
function differingLines(before: string[], after: string[]): number {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after) {
    const seen = counts.get(line) ?? 0;
    if (seen > 0) counts.set(line, seen - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return added + removed;
}

export function editDelta(before: CompositionSnapshot, after: CompositionSnapshot): EditDelta {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  let changedLines = 0;
  let structural = false;
  const files: string[] = [];

  for (const name of names) {
    const from = before[name] ?? "";
    const to = after[name] ?? "";
    if (from === to) continue;
    files.push(name);
    changedLines += differingLines(normalise(from), normalise(to));
    const fromCounts = structuralCounts(name, from);
    const toCounts = structuralCounts(name, to);
    if (fromCounts.some((count, index) => count !== toCounts[index])) structural = true;
  }

  return {changedLines, structural, files};
}

/**
 * A structural edit is always worth confirming, however few lines it took: deleting one
 * `<div>` is one line and can restructure a scene.
 */
export function isSubstantive(delta: EditDelta): boolean {
  return delta.structural || delta.changedLines >= SUBSTANTIVE_LINES;
}

/**
 * How much composition there is.
 *
 * On one brief with an identical plan and narration, Claude authored 570 lines of CSS and
 * Codex 65, and the owner approved the first and rejected the second as thin. That
 * comparison was made by hand with `wc -l`; this makes it a recorded number, so a change to
 * a prompt or a model can be judged instead of argued about.
 *
 * A line count on its own is gameable — a model told to write more CSS writes longer
 * selectors — so the shape is a record. `minElementsPerScene` is the honest floor: a
 * composition can carry its element budget in one dense scene and leave five bare, and
 * that reads as thin however good the total looks.
 */
export interface CompositionSize {
  lines: Record<string, number>;
  /** Opening tags in index.html. */
  elements: number;
  /** Rule blocks in styles.css. */
  cssRules: number;
  cssDeclarations: number;
  /** `gsap.*` / `timeline.*` call sites in animation.js. */
  gsapCalls: number;
  minElementsPerScene: number;
}

const count = (body: string, pattern: RegExp) => (body.match(pattern) ?? []).length;

/**
 * Elements inside the smallest `<section id="scene-…">`. Scenes nest `<section>` freely, so
 * this walks balanced tags rather than splitting — the same reason `findSceneEnd` exists in
 * compose/html.ts. Returns 0 when the markup declares no scenes at all.
 */
function smallestSceneElementCount(html: string): number {
  const counts: number[] = [];
  const opener = /<section\b[^>]*\bid="scene-[^"]*"[^>]*>/gi;
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const inner = html.slice(match.index + match[0].length);
    const nested = /<section\b|<\/section\s*>/gi;
    let depth = 1;
    let end = inner.length;
    for (let tag = nested.exec(inner); tag; tag = nested.exec(inner)) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = tag.index;
        break;
      }
    }
    counts.push(count(inner.slice(0, end), /<[a-zA-Z][^>]*>/g));
  }
  return counts.length ? Math.min(...counts) : 0;
}

export function compositionSize(snapshot: CompositionSnapshot): CompositionSize {
  const html = snapshot["index.html"] ?? "";
  const css = snapshot["styles.css"] ?? "";
  const js = snapshot["animation.js"] ?? "";
  const lines: Record<string, number> = {};
  for (const [name, body] of Object.entries(snapshot)) lines[name] = normalise(body).length;

  return {
    lines,
    elements: structuralCounts("index.html", html)[0] ?? 0,
    cssRules: structuralCounts("styles.css", css)[0] ?? 0,
    // Declarations rather than lines, because a stylesheet's real weight is the properties
    // it sets — `.a{color:red;background:blue}` is one line and two decisions.
    cssDeclarations: count(css.replace(/\/\*[\s\S]*?\*\//g, ""), /;/g),
    gsapCalls: structuralCounts("animation.js", js)[0] ?? 0,
    minElementsPerScene: smallestSceneElementCount(html),
  };
}
