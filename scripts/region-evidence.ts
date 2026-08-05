import fs from "node:fs/promises";
import path from "node:path";
import {chromium} from "playwright";
import {ROOT, VIDEOS_DIR, rel} from "../src/core/paths.ts";

/**
 * Phase 0 measurement gate (docs/template-build-plan.md §2, docs/template-system-plan.md §4).
 *
 * Question: do the ten approved/Claude portrait compositions already place their painted
 * elements into a small number of recurring boxes? Measured, not guessed — this script loads
 * every composition's real rendered `index.html` over `file://` in headless Chrome, seeks its
 * GSAP timeline to each scene's midpoint, applies the `.clip` visibility window by hand
 * (the rendered directory ships no hyperframes runtime), and records the normalised rect of
 * every element that is actually painted at that instant.
 *
 * Deterministic: same corpus, same numbers. No randomness, no library clustering — a stated,
 * simple tolerance-based grouping (see `rawClusterAtTolerance`).
 */

// ---------------------------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------------------------

/** The ten approved/Claude compositions named in docs/template-build-plan.md §0(a). */
const CORPUS = [
  "2026-08-04-consistency-point-view-claude-dba0",
  "2026-07-30-second-draft-7e83",
  "2026-07-30-short-hours-ideas-claude-2556",
  "2026-07-30-first-draft-deadline-claude-ce0e",
  "2026-07-29-filter-gone-claude-63ea",
  "2026-07-29-finish-argument-then-write-claude-a83a",
  "2026-07-28-calendar-only-measure-fullness-claude-a2ab",
  "2026-07-28-promise-monday-understand-thursday-claude-5741",
  "2026-07-28-slots-statt-gedanken-claude-2a0e",
  "2026-07-28-eine-woche-ein-gedanke-claude-466b",
] as const;

const TOLERANCES = [0.03, 0.05, 0.08] as const;
const GATE_TOLERANCE = 0.05;
const GATE_THRESHOLD = 0.6;

const JSON_OUT = path.join(ROOT, "docs", "region-evidence.json");
const MD_OUT = path.join(ROOT, "docs", "region-evidence.md");

// ---------------------------------------------------------------------------------------------
// Plan reading
// ---------------------------------------------------------------------------------------------

interface PlanSection {
  id: string;
  kind?: string;
  startMs: number;
  durationMs: number;
}

interface Scene {
  video: string;
  sectionId: string;
  sectionKind: string;
  t: number;
}

async function readScenes(videoId: string): Promise<Scene[]> {
  const planPath = path.join(VIDEOS_DIR, videoId, "plan.json");
  const raw = await fs.readFile(planPath, "utf8");
  const plan = JSON.parse(raw) as {sections?: PlanSection[]};
  const sections = plan.sections ?? [];
  return sections.map((section) => ({
    video: videoId,
    sectionId: section.id,
    sectionKind: section.kind ?? "unknown",
    t: (section.startMs + section.durationMs / 2) / 1000,
  }));
}

/** Glob render/9x16*, preferring an exact "9x16" when several exist (§0(a) correction). */
async function resolveRenderDir(videoId: string): Promise<string> {
  const renderRoot = path.join(VIDEOS_DIR, videoId, "render");
  const entries = await fs.readdir(renderRoot, {withFileTypes: true});
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("9x16"))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`No render/9x16* directory for ${videoId} (looked in ${rel(renderRoot)}).`);
  }
  const chosen = names.includes("9x16") ? "9x16" : names[0]!;
  return path.join(renderRoot, chosen);
}

// ---------------------------------------------------------------------------------------------
// Browser probe
//
// Written as a raw JS source string, not a TypeScript closure. tsx/esbuild rewrites named
// function declarations with a `__name(fn, "fn")` helper call that only exists in the
// transpiled module scope; a closure serialised into `page.evaluate` throws
// `ReferenceError: __name is not defined` inside the page. Passing the function as a bare
// string and calling `page.evaluate(`(${PROBE})(${json})`)` evaluates it as a page-native
// expression instead, so no compiled helper ever needs to exist in the browser. The same
// applies to `page.waitForFunction`, called below with a string body rather than a closure.
// ---------------------------------------------------------------------------------------------

interface Candidate {
  selector: string;
  tag: string;
  classes: string[];
  hasText: boolean;
  hasBackground: boolean;
  rect: [number, number, number, number];
  parentRect: [number, number, number, number] | null;
  isChrome: boolean;
}

/** Supplied chrome (plan §5 / CONTRACT §5), excluded from the clustering population. */
const CHROME_SELECTOR_LIST = [
  ".brand-rail",
  ".brand-seal",
  ".rail-rule",
  ".rail-lockup",
  "#caption-layer",
  ".caption-layer",
  ".caption-page",
  ".signal-spine",
];

const SEEK_AND_MEASURE = `function (args) {
  var sectionId = args.sectionId;
  var t = args.t;
  var stage = document.querySelector("#stage[data-composition-id]");
  if (!stage) throw new Error("no #stage[data-composition-id] element");

  var compId = stage.getAttribute("data-composition-id");
  var timelines = window.__timelines || {};
  var timeline = compId && timelines[compId] ? timelines[compId] : Object.values(timelines)[0];
  if (!timeline) throw new Error("window.__timelines has no entry for " + sectionId);

  timeline.seek(t, false);
  void document.body.offsetHeight; // force a style flush before measuring

  var STAGE_W = parseFloat(stage.dataset.width);
  var STAGE_H = parseFloat(stage.dataset.height);
  var stageBox = stage.getBoundingClientRect();

  function fracRect(rect) {
    return [
      (rect.left - stageBox.left) / STAGE_W,
      (rect.top - stageBox.top) / STAGE_H,
      rect.width / STAGE_W,
      rect.height / STAGE_H,
    ];
  }

  function parseAlpha(colorStr) {
    if (!colorStr || colorStr === "transparent") return 0;
    var m = colorStr.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return 1;
    var parts = m[1].split(/[,\\/]/).map(function (p) { return p.trim(); });
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  }

  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent && n.textContent.trim().length > 0) return true;
    }
    return false;
  }

  function hasVisibleBorder(cs) {
    var sides = ["top", "right", "bottom", "left"];
    for (var i = 0; i < sides.length; i++) {
      var side = sides[i];
      var width = parseFloat(cs.getPropertyValue("border-" + side + "-width"));
      var style = cs.getPropertyValue("border-" + side + "-style");
      var color = cs.getPropertyValue("border-" + side + "-color");
      if (width > 0 && style !== "none" && style !== "hidden" && parseAlpha(color) > 0) return true;
    }
    return false;
  }

  function isClipActive(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.classList && node.classList.contains("clip")) {
        var start = parseFloat(node.dataset.start);
        var dur = parseFloat(node.dataset.duration);
        if (!(t >= start && t < start + dur)) return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function selectorFor(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + node.id;
        parts.unshift(part);
        break;
      }
      if (node.classList.length) {
        part += "." + Array.prototype.slice.call(node.classList).slice(0, 3).join(".");
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  var EXCLUDED_TAGS = {SCRIPT: 1, AUDIO: 1, HTML: 1, BODY: 1, STYLE: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1};
  var CHROME_SELECTOR = ${JSON.stringify(
    CHROME_SELECTOR_LIST.flatMap((sel) => [sel, `${sel} *`]).join(", "),
  )};

  var all = document.querySelectorAll("*");
  var out = [];
  for (var idx = 0; idx < all.length; idx++) {
    var el = all[idx];
    if (EXCLUDED_TAGS[el.tagName]) continue;
    if (el.id === "stage") continue;
    if (!isClipActive(el)) continue;

    var cs = window.getComputedStyle(el);
    if (parseFloat(cs.opacity) === 0) continue;
    if (cs.visibility !== "visible") continue;
    if (cs.display === "none") continue;

    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    var ownText = hasOwnText(el);
    var bgAlpha = parseAlpha(cs.backgroundColor);
    var hasBg = bgAlpha > 0;
    var bgImage = cs.backgroundImage;
    var hasBgImage = !!bgImage && bgImage !== "none";
    var borderVisible = hasVisibleBorder(cs);
    var painted = ownText || hasBg || hasBgImage || borderVisible;
    if (!painted) continue;

    var isChrome = el.closest(CHROME_SELECTOR) !== null;
    var parent = el.parentElement;
    var parentFrac = parent ? fracRect(parent.getBoundingClientRect()) : null;

    out.push({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList),
      hasText: ownText,
      hasBackground: hasBg || hasBgImage,
      rect: fracRect(rect),
      parentRect: parentFrac,
      isChrome: isChrome,
    });
  }
  return out;
}`;

/** Reads the composition's actual left content inset (var(--gutter)) via .scene padding-left. */
const GUTTER_PROBE = `function () {
  var stage = document.querySelector("#stage[data-composition-id]");
  var scene = document.querySelector(".scene");
  if (!stage || !scene) return null;
  var W = parseFloat(stage.dataset.width);
  var cs = window.getComputedStyle(scene);
  return parseFloat(cs.paddingLeft) / W;
}`;

// ---------------------------------------------------------------------------------------------
// Measurement run
// ---------------------------------------------------------------------------------------------

interface MeasuredElement extends Candidate {
  video: string;
  sectionId: string;
  sectionKind: string;
  t: number;
  category: "content" | "chrome" | "wrapper";
}

const WRAPPER_TOLERANCE = 0.01;

function classify(candidate: Candidate): "content" | "chrome" | "wrapper" {
  if (candidate.isChrome) return "chrome";
  if (candidate.parentRect && !candidate.hasText && !candidate.hasBackground) {
    const matchesParent = candidate.rect.every(
      (value, index) => Math.abs(value - candidate.parentRect![index]!) <= WRAPPER_TOLERANCE,
    );
    if (matchesParent) return "wrapper";
  }
  return "content";
}

async function measureCorpus(): Promise<{
  elements: MeasuredElement[];
  gutterFractions: Record<string, number | null>;
}> {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1080, height: 1920}, deviceScaleFactor: 1});
  const page = await context.newPage();

  const elements: MeasuredElement[] = [];
  const gutterFractions: Record<string, number | null> = {};

  for (const videoId of CORPUS) {
    const renderDir = await resolveRenderDir(videoId);
    const indexHtml = path.join(renderDir, "index.html");
    await page.goto(`file://${indexHtml}`, {waitUntil: "load"});
    await page.waitForFunction("Object.keys(window.__timelines || {}).length > 0", null, {timeout: 15000});

    const gutter = (await page.evaluate(`(${GUTTER_PROBE})()`)) as number | null;
    gutterFractions[videoId] = gutter;

    const scenes = await readScenes(videoId);
    for (const scene of scenes) {
      const candidates = (await page.evaluate(
        `(${SEEK_AND_MEASURE})(${JSON.stringify({sectionId: scene.sectionId, t: scene.t})})`,
      )) as Candidate[];

      for (const candidate of candidates) {
        elements.push({
          ...candidate,
          video: scene.video,
          sectionId: scene.sectionId,
          sectionKind: scene.sectionKind,
          t: scene.t,
          category: classify(candidate),
        });
      }
    }
    console.log(`measured      ${videoId} · ${scenes.length} scene(s) · render ${rel(renderDir)}`);
  }

  await browser.close();
  return {elements, gutterFractions};
}

// ---------------------------------------------------------------------------------------------
// Clustering — simple, stated, no library.
//
// Elements are processed in a fixed deterministic order (sorted by video, section, t,
// selector). Each cluster is anchored by the rect of the first element that started it; a
// later element joins the first existing cluster whose anchor is within `tolerance` on all
// four normalised numbers, otherwise it starts a new cluster. First-fit against a fixed
// anchor (not a running centroid) keeps the result reproducible from the sorted input alone.
// ---------------------------------------------------------------------------------------------

interface RawCluster {
  anchor: [number, number, number, number];
  members: MeasuredElement[];
}

interface ClusterSummary {
  anchor: [number, number, number, number];
  videoCount: number;
  videos: string[];
  elementCount: number;
  shareOfPopulation: number;
  textFraction: number;
  topClasses: {name: string; count: number}[];
  recurring: boolean;
}

function withinTolerance(a: readonly number[], b: readonly number[], tolerance: number): boolean {
  for (let i = 0; i < 4; i++) {
    if (Math.abs(a[i]! - b[i]!) > tolerance) return false;
  }
  return true;
}

function sortKey(element: MeasuredElement): string {
  return `${element.video} ${element.sectionId} ${element.t.toFixed(6)} ${element.selector}`;
}

function rawClusterAtTolerance(content: MeasuredElement[], tolerance: number): RawCluster[] {
  const sorted = [...content].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const clusters: RawCluster[] = [];

  for (const element of sorted) {
    let placed = false;
    for (const cluster of clusters) {
      if (withinTolerance(cluster.anchor, element.rect, tolerance)) {
        cluster.members.push(element);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({anchor: element.rect, members: [element]});
  }

  return clusters;
}

function summarizeCluster(cluster: RawCluster, totalPopulation: number): ClusterSummary {
  const videos = [...new Set(cluster.members.map((m) => m.video))].sort();
  const classCounts = new Map<string, number>();
  for (const member of cluster.members) {
    for (const cls of member.classes) {
      classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    }
  }
  const topClasses = [...classCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({name, count}));
  const textCount = cluster.members.filter((m) => m.hasText).length;
  return {
    anchor: cluster.anchor,
    videoCount: videos.length,
    videos,
    elementCount: cluster.members.length,
    shareOfPopulation: totalPopulation > 0 ? cluster.members.length / totalPopulation : 0,
    textFraction: cluster.members.length > 0 ? textCount / cluster.members.length : 0,
    topClasses,
    recurring: videos.length >= 3,
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const {elements, gutterFractions} = await measureCorpus();

const contentPop = elements.filter((e) => e.category === "content");
const chromePop = elements.filter((e) => e.category === "chrome");
const wrapperPop = elements.filter((e) => e.category === "wrapper");

const bleedElements = contentPop.filter(
  (e) => e.rect[0] < 0 || e.rect[1] < 0 || e.rect[0] + e.rect[2] > 1 || e.rect[1] + e.rect[3] > 1,
);

const rawClustersByTolerance: Record<string, RawCluster[]> = {};
const clustersByTolerance: Record<string, ClusterSummary[]> = {};
const headlineByTolerance: Record<string, number> = {};

for (const tolerance of TOLERANCES) {
  const raw = rawClusterAtTolerance(contentPop, tolerance);
  rawClustersByTolerance[String(tolerance)] = raw;
  const summaries = raw
    .map((cluster) => summarizeCluster(cluster, contentPop.length))
    .sort((a, b) => b.elementCount - a.elementCount);
  clustersByTolerance[String(tolerance)] = summaries;
  const recurringCount = summaries.filter((s) => s.recurring).reduce((sum, s) => sum + s.elementCount, 0);
  headlineByTolerance[String(tolerance)] = contentPop.length > 0 ? recurringCount / contentPop.length : 0;
}

const headlineAtGate = headlineByTolerance[String(GATE_TOLERANCE)] ?? 0;
const gatePasses = headlineAtGate >= GATE_THRESHOLD;

const gutterValues = Object.values(gutterFractions).filter((v): v is number => v !== null);
const gutterMin = gutterValues.length ? Math.min(...gutterValues) : null;
const gutterMax = gutterValues.length ? Math.max(...gutterValues) : null;
const gutterAvg = gutterValues.length ? gutterValues.reduce((a, b) => a + b, 0) / gutterValues.length : null;
const gutterConsistent = gutterMin !== null && gutterMax !== null && gutterMax - gutterMin < 0.001;

const sceneCount = new Set(elements.map((e) => `${e.video} ${e.sectionId}`)).size;

// One-off (non-recurring, at the gate tolerance) breakdown, for the honest section.
const gateRawClusters = rawClustersByTolerance[String(GATE_TOLERANCE)]!;
const oneOffClustersAtGate = gateRawClusters.filter((c) => new Set(c.members.map((m) => m.video)).size < 3);
const oneOffElementsAtGate = oneOffClustersAtGate.flatMap((c) => c.members);
const oneOffByVideo = new Map<string, number>();
const oneOffByKind = new Map<string, number>();
for (const member of oneOffElementsAtGate) {
  oneOffByVideo.set(member.video, (oneOffByVideo.get(member.video) ?? 0) + 1);
  oneOffByKind.set(member.sectionKind, (oneOffByKind.get(member.sectionKind) ?? 0) + 1);
}

// ---------------------------------------------------------------------------------------------
// JSON output — raw enough that a reviewer can recompute the headline number by hand.
// ---------------------------------------------------------------------------------------------

const jsonPayload = {
  generatedBy: "scripts/region-evidence.ts",
  corpus: CORPUS,
  gate: {tolerance: GATE_TOLERANCE, threshold: GATE_THRESHOLD, headlineFraction: headlineAtGate, passes: gatePasses},
  counts: {
    videos: CORPUS.length,
    scenes: sceneCount,
    totalMeasured: elements.length,
    content: contentPop.length,
    chrome: chromePop.length,
    wrapper: wrapperPop.length,
    offCanvasBleedContentElements: bleedElements.length,
  },
  gutter: {
    byVideo: gutterFractions,
    min: gutterMin,
    max: gutterMax,
    average: gutterAvg,
    consistentAcrossCorpus: gutterConsistent,
  },
  headlineFractionByTolerance: headlineByTolerance,
  clustersByTolerance,
  oneOffsAtGateTolerance: {
    byVideo: Object.fromEntries(oneOffByVideo),
    bySectionKind: Object.fromEntries(oneOffByKind),
  },
  elements,
};

await fs.mkdir(path.dirname(JSON_OUT), {recursive: true});
await fs.writeFile(JSON_OUT, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
console.log(`wrote         ${rel(JSON_OUT)}`);

// ---------------------------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------------------------

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function clusterTable(clusters: ClusterSummary[]): string {
  const multi = clusters.filter((c) => c.elementCount >= 2);
  const shown = multi.slice(0, 40);
  const omitted = multi.length - shown.length;
  const rows = shown.map((c) => {
    const rect = c.anchor.map((v) => v.toFixed(3)).join(", ");
    const classes = c.topClasses.map((tc) => `${tc.name} (${tc.count})`).join(", ") || "—";
    return `| [${rect}] | ${c.videoCount} | ${c.elementCount} | ${pct(c.shareOfPopulation)} | ${pct(c.textFraction)} | ${c.recurring ? "yes" : "no"} | ${classes} |`;
  });
  const header = [
    "| rect [x,y,w,h] | videos | elements | share | text | recurring | top classes |",
    "|---|---|---|---|---|---|---|",
  ];
  const footer = omitted > 0 ? [`\n_${omitted} smaller cluster(s) with 2+ elements omitted from this table; full list in the JSON._`] : [];
  return [...header, ...rows, ...footer].join("\n");
}

let md = "";
md += "# Region evidence — Phase 0 measurement gate\n\n";
md += "Generated by `npm run regions:evidence` (`scripts/region-evidence.ts`). Deterministic — ";
md += "same corpus, same numbers. Raw per-element measurements are in `docs/region-evidence.json`.\n\n";

md += "## 1. What was measured\n\n";
md += `- Videos: ${CORPUS.length}\n`;
md += `- Scenes (video × plan section): ${sceneCount}\n`;
md += `- Elements measured (clip-active, painted, at a scene midpoint): ${elements.length}\n`;
md += `- Dropped as supplied chrome (\`.brand-rail\`, \`.brand-seal\`, \`.rail-rule\`, \`.rail-lockup\`, `;
md += "caption layer, `.signal-spine` and children): ";
md += `${chromePop.length}\n`;
md += `- Dropped as pure layout wrappers (rect within 1% of parent on all four numbers, no own `;
md += `text, no background): ${wrapperPop.length}\n`;
md += `- Remaining clustering population (content): ${contentPop.length}\n`;
md += `- Content elements with off-canvas bleed (x<0, y<0, x+w>1 or y+h>1) — kept **unclamped** `;
md += `in clustering, not dropped: ${bleedElements.length}\n\n`;
md += "Corpus (video → render dir resolved by globbing `render/9x16*`, preferring exact `9x16`):\n\n";
for (const videoId of CORPUS) {
  md += `- \`${videoId}\`\n`;
}
md += "\n";

md += "**Reserved left rail/spine lane, measured (not guessed):** read from each composition's ";
md += "`.scene` computed `padding-left` (`var(--gutter)`), divided by stage width. Average ";
md += `${gutterAvg !== null ? gutterAvg.toFixed(4) : "n/a"} of stage width across the corpus `;
md += `(min ${gutterMin?.toFixed(4)}, max ${gutterMax?.toFixed(4)}). `;
md += gutterConsistent
  ? "Consistent across all ten videos.\n\n"
  : "**Not** perfectly consistent — the corpus splits into two values, not one, by video:\n\n";
if (!gutterConsistent) {
  for (const videoId of CORPUS) {
    const value = gutterFractions[videoId];
    md += `  - ${videoId}: ${value !== null && value !== undefined ? value.toFixed(4) : "n/a"}\n`;
  }
  md += "\n";
}

md += "## 2. Cluster tables\n\n";
md += "Two rects cluster when all four normalised numbers `[x, y, w, h]` are within tolerance of ";
md += "the cluster's anchor (the rect of the first element that started it, in a fixed sorted ";
md += "input order — a fixed anchor, not a running centroid, so the result is reproducible from ";
md += "the sorted input alone). A cluster is **recurring** when its members span three or more ";
md += "distinct videos. Only clusters with 2+ elements are listed; singletons are counted in the ";
md += "totals above and present in full in the JSON.\n\n";

for (const tolerance of TOLERANCES) {
  const clusters = clustersByTolerance[String(tolerance)]!;
  const recurring = clusters.filter((c) => c.recurring);
  md += `### Tolerance ${tolerance}\n\n`;
  md += `${recurring.length} recurring cluster(s) out of ${clusters.length} total cluster(s).\n\n`;
  md += `${clusterTable(clusters)}\n\n`;
}

md += "## 3. Headline fraction\n\n";
for (const tolerance of TOLERANCES) {
  md += `- Tolerance ${tolerance}: **${pct(headlineByTolerance[String(tolerance)] ?? 0)}** of content `;
  md += "elements fall into a recurring cluster.\n";
}
md += "\n";
md += `**Verdict:** At tolerance ${GATE_TOLERANCE}, ${pct(headlineAtGate)} of elements fall into `;
md += `recurring clusters, so the gate **${gatePasses ? "passes" : "fails"}** `;
md += `(threshold ${pct(GATE_THRESHOLD)}).\n\n`;

md += "## 4. Candidate portrait region maps\n\n";
if (!gatePasses) {
  md += `**Not produced.** The gate failed at tolerance ${GATE_TOLERANCE} `;
  md += `(${pct(headlineAtGate)} < ${pct(GATE_THRESHOLD)}). Per the brief, candidate maps are not `;
  md += "written as usable when the gate fails, and this report does not switch to a looser ";
  md += "tolerance to clear the bar. See §3 for the number at every tolerance actually measured.\n\n";
} else {
  md += "Reserved lane: see §1 above for the measured rail/spine width. Caption band per ";
  md += '`captionZone("portrait")`: `{x0:0.06, y0:0.73, x1:0.94, y1:0.88}`.\n\n';
  md += "Candidate maps drawn from the recurring clusters above are authored by hand in this same ";
  md += "file, immediately below this generated block, each naming the cluster(s) and share of the ";
  md += "population it transcribes. See `docs/region-evidence.md` for the final hand-authored ";
  md += "section — this generated block stops at the measurement.\n\n";
}

md += "## 5. What the clusters do not explain\n\n";
md += `At tolerance ${GATE_TOLERANCE}, ${oneOffClustersAtGate.length} cluster(s) totalling `;
md += `${oneOffElementsAtGate.length} element(s) `;
md += `(${pct(contentPop.length ? oneOffElementsAtGate.length / contentPop.length : 0)} of the content `;
md += "population) do not recur across three or more videos — these are one-offs, not shared ";
md += "structure.\n\n";
md += "One-off element count by video:\n\n";
for (const videoId of CORPUS) {
  md += `- ${videoId}: ${oneOffByVideo.get(videoId) ?? 0}\n`;
}
md += "\nOne-off element count by scene kind (from `plan.json` `sections[].kind`):\n\n";
for (const [kind, count] of [...oneOffByKind.entries()].sort((a, b) => b[1] - a[1])) {
  md += `- ${kind}: ${count}\n`;
}
md += "\n_(Full one-off membership — selectors, classes, rects — is in `docs/region-evidence.json` ";
md += '→ `oneOffsAtGateTolerance` counts plus `clustersByTolerance["0.05"]` for the cluster shapes; ';
md += "cross-reference against `elements` for exact rows.)_\n";

await fs.writeFile(MD_OUT, md, "utf8");
console.log(`wrote         ${rel(MD_OUT)}`);
console.log("");
console.log(`gate          tolerance ${GATE_TOLERANCE} · ${pct(headlineAtGate)} · ${gatePasses ? "PASS" : "FAIL"}`);
