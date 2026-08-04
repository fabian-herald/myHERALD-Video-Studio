/**
 * String-level surgery on an authored composition.
 *
 * These live together because three callers grew near-identical copies: the checker locating
 * an element to judge it, the edit path rewriting a scene's timing, and the auto-fixer
 * repairing a mechanical defect. A regex that drifts between them is a bug that only shows
 * up on one path, which is exactly what happened to attribute rewriting — see
 * `setElementAttribute` below.
 *
 * Deliberately not a DOM parser. The composition is authored by a model and read back by a
 * browser; introducing a parse/serialise round trip here would reformat files the model is
 * about to be shown again, and make every diff unreadable.
 */

export interface ExtractedElement {
  openTag: string;
  inner: string;
}

/** Find an element by id and return its open tag plus inner HTML. */
export function extractElement(html: string, id: string): ExtractedElement | null {
  const idIndex = html.indexOf(`id="${id}"`);
  if (idIndex < 0) return null;

  const tagStart = html.lastIndexOf("<", idIndex);
  const openEnd = html.indexOf(">", idIndex);
  if (tagStart < 0 || openEnd < 0) return null;

  const openTag = html.slice(tagStart, openEnd + 1);
  const tagName = openTag.slice(1).match(/^[a-zA-Z][\w-]*/)?.[0];
  if (!tagName) return null;

  // Walk forward balancing same-name tags so nesting cannot confuse the scan.
  const pattern = new RegExp(`<${tagName}\\b|</${tagName}\\s*>`, "gi");
  pattern.lastIndex = openEnd + 1;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return {openTag, inner: html.slice(openEnd + 1, match.index)};
  }
  return {openTag, inner: html.slice(openEnd + 1)};
}

export const attribute = (tag: string, name: string) =>
  tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

export const openingTagsByClass = (html: string, className: string) =>
  [...html.matchAll(/<[a-z][^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => (attribute(tag, "class") ?? "").split(/\s+/).includes(className));

/** Byte offsets of an element's open tag, located by id. */
function openTagRange(html: string, id: string): {start: number; end: number} | null {
  const anchor = html.indexOf(`id="${id}"`);
  if (anchor < 0) return null;
  const start = html.lastIndexOf("<", anchor);
  const end = html.indexOf(">", anchor);
  return start < 0 || end < 0 ? null : {start, end};
}

/**
 * Set an attribute on the element with this id, **inserting it when absent**.
 *
 * The insert path is the whole reason this exists. `rewriteSceneTiming` replaced with
 * `.replace(/data-start="[^"]*"/, …)`, which silently does nothing when the attribute is
 * not there — and "the attribute is not there" is precisely the `missing_timing` defect.
 * Returns the html unchanged when the id does not resolve.
 */
export function setElementAttribute(
  html: string,
  id: string,
  name: string,
  value: string,
): string {
  const range = openTagRange(html, id);
  if (!range) return html;
  const tag = html.slice(range.start, range.end + 1);
  const existing = new RegExp(`\\s${name}="[^"]*"`);

  const rewritten = existing.test(tag)
    ? tag.replace(existing, ` ${name}="${value}"`)
    // Self-closing tags keep their slash; everything else takes the attribute before `>`.
    : tag.replace(/\s*\/?>$/, (close) => ` ${name}="${value}"${close.trimStart() || ">"}`);
  return html.slice(0, range.start) + rewritten + html.slice(range.end + 1);
}

/** Add a class to the element with this id, leaving an existing class list intact. */
export function addClassToElement(html: string, id: string, className: string): string {
  const range = openTagRange(html, id);
  if (!range) return html;
  const current = attribute(html.slice(range.start, range.end + 1), "class");
  if (current !== null && current.split(/\s+/).includes(className)) return html;
  return setElementAttribute(
    html,
    id,
    "class",
    current === null ? className : `${current} ${className}`.trim(),
  );
}

/** Insert a fragment as the first or last child of the element with this id. */
export function insertIntoElement(
  html: string,
  id: string,
  fragment: string,
  position: "append" | "prepend" = "append",
): string {
  const range = openTagRange(html, id);
  const element = extractElement(html, id);
  if (!range || !element) return html;

  const innerStart = range.end + 1;
  const innerEnd = innerStart + element.inner.length;
  const inner = position === "prepend"
    ? fragment + element.inner
    : element.inner + fragment;
  return html.slice(0, innerStart) + inner + html.slice(innerEnd);
}

/** Walk `<section>` nesting from a scene's open tag to the offset just past its close. */
export function findSceneEnd(html: string, sceneStart: number): number {
  const pattern = /<section\b|<\/section\s*>/gi;
  pattern.lastIndex = sceneStart + 1;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return html.length;
}

export function removeScene(html: string, sectionId: string): string {
  const anchor = html.indexOf(`id="scene-${sectionId}"`);
  if (anchor < 0) return html;
  const start = html.lastIndexOf("<", anchor);
  return html.slice(0, start) + html.slice(findSceneEnd(html, start));
}

export function rewriteSceneTiming(
  html: string,
  sectionId: string,
  startMs: number,
  durationMs: number,
): string {
  const id = `scene-${sectionId}`;
  const withStart = setElementAttribute(html, id, "data-start", (startMs / 1000).toFixed(3));
  return setElementAttribute(withStart, id, "data-duration", (durationMs / 1000).toFixed(3));
}

/** The backdrop, brand rail, caption layer and audio all span the whole piece. */
export function rewriteFullDurationClips(html: string, duration: string): string {
  return html.replace(
    /(id="(?:stage|backdrop|brand-rail|caption-layer|narration)"[^>]*?data-duration=")[^"]*(")/g,
    `$1${duration}$2`,
  );
}

export function swapCopy(
  html: string,
  sectionId: string,
  before: string,
  after: string,
): string | null {
  const anchor = html.indexOf(`id="scene-${sectionId}"`);
  if (anchor < 0) return null;
  const sceneStart = html.lastIndexOf("<", anchor);
  const sceneEnd = findSceneEnd(html, sceneStart);
  const scene = html.slice(sceneStart, sceneEnd);

  const escapedBefore = escapeHtml(before);
  const target = scene.includes(before) ? before : scene.includes(escapedBefore) ? escapedBefore : null;
  if (!target) return null;

  const replacement = target === before ? after : escapeHtml(after);
  return html.slice(0, sceneStart) + scene.replace(target, replacement) + html.slice(sceneEnd);
}

/**
 * Compare visible scene text, not HTML source. This deliberately answers only whether
 * the requested copy is already present: it never rewrites markup or guesses how a
 * styled heading should be split across elements.
 */
export function sceneDisplaysCopy(html: string, sectionId: string, copy: string): boolean {
  const anchor = html.indexOf(`id="scene-${sectionId}"`);
  if (anchor < 0) return false;
  const sceneStart = html.lastIndexOf("<", anchor);
  const sceneEnd = findSceneEnd(html, sceneStart);
  const visible = decodeBasicEntities(html.slice(sceneStart, sceneEnd)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "));
  const haystack = normalizeVisibleText(visible);
  const needle = normalizeVisibleText(copy);
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

export const normalizeVisibleText = (value: string) => value.replace(/\s+/g, " ").trim();

export const decodeBasicEntities = (value: string) => value
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replaceAll("&nbsp;", " ");

export const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
