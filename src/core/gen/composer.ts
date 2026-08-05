import fs from "node:fs/promises";
import path from "node:path";
import type {AuthoringDir} from "../compose/workdir.ts";
import type {CheckFinding, CheckReport} from "../render/check.ts";

/** The three files a composition consists of. Nothing else may be written. */
export const COMPOSITION_FILES = ["index.html", "styles.css", "animation.js"] as const;

export interface ComposeContext {
  authoring: AuthoringDir;
  /** Absolute path to the checker the composer may run on itself. */
  onLog: (line: string) => void;
  signal?: AbortSignal;
  /** Raised for the repair passes so a second attempt thinks harder. */
  effort: "default" | "high";
  /**
   * Set when this composition is a re-lay of one that already exists in another shape.
   *
   * A video wanted on LinkedIn and on Instagram needs a 16:9 and a 9:16, and the shapes
   * are different enough that one set of coordinates cannot serve both — a five-row
   * vertical stack is a squat band at 1920×1080. So the second family is still authored.
   * What it must not be is *invented*: the piece was already designed, and a second
   * independent pass produces a different video that happens to share a script, which is
   * the opposite of "correct it once and publish it everywhere".
   */
  adaptation?: {
    fromFamily: string;
    fromWidth: number;
    fromHeight: number;
  };
}

export interface ComposeResult {
  provider: string;
  model: string;
  /**
   * The thinking budget this pass actually ran at — Codex's `model_reasoning_effort`, or
   * Claude's turn ceiling. Recorded because it is the one input we tune without swapping
   * models, and provenance could not previously say which budget produced a composition.
   */
  effort: string;
  /**
   * Assistant turns. Provider-relative and not comparable across backends: Claude reports
   * the SDK's `num_turns`, Codex counts completed assistant messages, which reads lower for
   * the same work. Compare a provider against itself over time, never against the other.
   */
  turns: number;
  /** Tool calls, file writes and commands — what the session did, as against what it said. */
  actions: number;
  costUsd: number;
  /** Whatever the composer said about what it built. */
  notes: string;
}

/**
 * What every backend is told about `exemplar/`, in one place.
 *
 * It used to be Codex-only, and it warned that the reference "sets the brand name as live
 * type, builds a seal by hand, reaches outside the directory with ../media/ paths, and links
 * neither tokens.css nor the block stylesheets". All four were true of the old exemplar and
 * none are true of the one that replaced it, so the warning had become a set of false claims
 * about a file the model can read — worse than no framing at all, which is what Claude had.
 *
 * The wording tracks CONTRACT §9 deliberately. A third phrasing of the same rule is how the
 * two backends drift apart.
 */
export const EXEMPLAR_FRAMING = [
  "Read exemplar/index.html, exemplar/styles.css and exemplar/animation.js before deciding",
  "anything, and look at exemplar/reference-contact-sheet.png. It is a composition that was",
  "reviewed and approved, and it is there for one purpose: how much a finished scene carries.",
  "Count the elements in its thinnest section. That density is the bar, and a sparse scene",
  "that passes every check is still a failure.",
  "",
  "Its scenes, section ids, on-screen copy and timings belong to a different brief and are",
  "already used. Its root element carries that brief's data-composition-id and data-duration;",
  "yours come from BRIEF.md. It is calibration, not a template.",
].join("\n");

/**
 * What a backend is told when it is re-laying an existing composition for another shape.
 *
 * The source files are already in the working directory when this is read, so it opens with
 * "read what is there" rather than "here is a description of it".
 */
export function adaptationFraming(adaptation: NonNullable<ComposeContext["adaptation"]>): string {
  return [
    `index.html, styles.css and animation.js in this directory are a finished, approved`,
    `composition for this video at ${adaptation.fromWidth}×${adaptation.fromHeight}`,
    `(${adaptation.fromFamily}). Read all three before changing anything.`,
    "",
    "Your job is to re-lay that composition for this canvas, not to design a new one. The",
    "same scenes, in the same order, carrying the same on-screen copy, the same media and",
    "the same timings — every `data-start` and `data-duration` stays exactly as it is, and",
    "the narration is unchanged, so nothing about the pacing is yours to decide.",
    "",
    "What does change is the shape, and it changes more than it looks. A tall frame stacks;",
    "a wide one places side by side. A five-row vertical rhythm becomes a squat band if you",
    "only rescale it, so where the source stacks, consider a column beside a column. The",
    "caption band is a quarter of the height here rather than a third, which gives back",
    "vertical room the source did not have.",
    "",
    "Keep the scene archetypes recognisably the same piece — a scene that was a stack of",
    "sheets is still a stack of sheets. Keep the motion: the same elements move, in the same",
    "order, with the same easings. Redirect a movement where the axis no longer makes sense",
    "and change nothing else about it.",
    "",
    "Density must not drop. The source is the bar for how much a scene carries, and a wider",
    "canvas is more room, not fewer elements.",
  ].join("\n");
}

/** The exact same rendered evidence and rubric is given to every composer backend. */
export interface VisualReviewRequest {
  /** Absolute paths. The backend either opens these files or attaches them as images. */
  imagePaths: readonly string[];
  prompt: string;
}

export function visualReviewRequest(
  authoring: AuthoringDir,
  imagePaths: readonly string[],
): VisualReviewRequest {
  const listed = imagePaths.map((file, index) =>
    `- ${index === 0 ? "Contact sheet" : `Temporal frame ${index}`}: ${file}`).join("\n");

  return {
    imagePaths,
    prompt: [
      `Review the rendered ${authoring.width}x${authoring.height} composition visually.`,
      "The first image is a contact sheet; the remaining images are early/late temporal pairs",
      "for each section, in the same order as BRIEF.md. Inspect every image and compare every pair.",
      "When your runtime exposes images as local files, use Read on the exact paths below.",
      "When it supports image attachments, the same files are attached as image inputs.",
      "",
      listed,
      "",
      "Judge every section against the same rubric:",
      "- intentional visual hierarchy and a clear focal point",
      "- purposeful use of the complete canvas; a small island in a mostly empty portrait frame",
      "  is under-composed, not deliberate negative space",
      "- balanced placement, alignment and scale for this exact aspect ratio",
      "- no clipped, cropped, overlapping or off-canvas elements; respect safe areas",
      "- readable secondary type and sufficient contrast behind the caption band",
      "- visible breathing room above captions: labels, rules, nodes and high-contrast marks",
      "  may not crowd the caption band even when they do not technically overlap it",
      "- distinct scene archetypes, not repeated centred layouts with swapped copy",
      "- coherent visual rhythm and no isolated decorative elements without a role",
      "- every prominent line, connector, node or dot either anchors the composition or",
      "  communicates a labelled relationship; reject unexplained pseudo-diagrams",
      "- a group of bars, blocks or segments reads as a chart whether or not one was meant.",
      "  Three coloured rectangles in the corner of an end card with no axis, no label and no",
      "  number is a chart with nothing in it; either give it a value to carry or delete it",
      "- data graphics are geometrically truthful: percentages and shares occupy their stated",
      "  proportion (25% is one quarter of its scale, never a full 100% bar)",
      "- meaningful visual development between each early/late pair; reject perpetual drifting,",
      "  floating, bobbing or rotation that communicates no state change or relationship",
      "- the persistent top-left identity and brand-signature/CTA outro use a supplied full",
      "  lockup image, not reconstructed seal plus wordmark and not the wordmark alone",
      "- a silent non-promotional outro also gives readable brand context and website, stages",
      "  them in, and leaves the resolved card visible long enough to register before looping",
      "",
      "If any frame is materially weak, edit only index.html, styles.css and animation.js",
      "with the smallest coherent visual/layout/motion correction. Do not change narration,",
      "on-screen copy, claims, scene order, brand rules or supplied media. If every frame",
      "already passes, make no edits and say so plainly.",
      "",
      "Do not run HyperFrames, install anything or open a local server. The Studio pipeline",
      "created this evidence and will rerun all authoritative checks after you return.",
    ].join("\n"),
  };
}

/**
 * Every generation backend implements this. Adding an adapter is a new file plus a
 * registry entry — the contract itself lives in the repo (compose/CONTRACT.md), not
 * in any provider's skill system, so it stays portable.
 */
export interface Composer {
  readonly id: string;
  readonly label: string;
  /** Author index.html / styles.css / animation.js into `context.authoring.dir`. */
  compose(context: ComposeContext): Promise<ComposeResult>;
  /** Inspect centrally rendered frames and make one evidence-led visual correction pass. */
  review(context: ComposeContext, request: VisualReviewRequest): Promise<ComposeResult>;
  /** Minimal diff against concrete findings. Never a blind re-author. */
  repair(
    context: ComposeContext,
    report: CheckReport,
    attempt: number,
    evidencePaths?: readonly string[],
  ): Promise<ComposeResult>;
}

/**
 * Warnings are useful in the log, but they do not block rendering and must not broaden a
 * surgical repair. The first live Codex run tried to "fix" 27 warnings alongside eight
 * errors and doubled the layout failures. Keep repair attention on the gates that failed.
 */
export function actionableRepairFindings(report: CheckReport) {
  const errors = report.findings.filter((finding) => finding.severity === "error");
  return errors.length ? errors : report.findings;
}

/**
 * One rendering of a finding for every adapter.
 *
 * Claude and Codex had byte-identical copies of this, which is how a field added for one
 * silently fails to reach the other. `file:line` and the expected literal are the two the
 * model most often had to rediscover by reading the whole file.
 */
export function formatFindingForRepair(finding: CheckFinding): string {
  const at = finding.file
    ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
    : "";
  return `- [${finding.severity}] ${finding.code ?? "issue"}${at}: ${finding.message}`
    + (finding.selector ? ` (selector: ${finding.selector})` : "")
    + (finding.containerSelector ? `\n  ${otherParty(finding.code)}: ${finding.containerSelector}` : "")
    + (finding.expected ? `\n  expected: ${finding.expected}` : "")
    + (finding.fixHint ? `\n  hint: ${finding.fixHint}` : "");
}

/**
 * What the second party to a two-element finding *is*, in the words of that finding.
 *
 * "Text is hidden beneath an opaque element" names no element, and until now nothing
 * downstream named one either — the composer was handed a collision and one of its two
 * halves. Labelling it per code rather than generically matters: "hidden by" tells the
 * composer to move or re-track that element, "overlapping" tells it the two are peers and
 * either may move, and "inside" tells it the box is a container to fit within, not something
 * to push away.
 */
function otherParty(code: string | undefined): string {
  if (code === "text_occluded") return "hidden by";
  if (code === "content_overlap") return "overlapping";
  if (code === "text_box_overflow" || code === "container_overflow" || code === "escaped_container") {
    return "inside";
  }
  return "other element";
}

const registry = new Map<string, Composer>();

export function registerComposer(composer: Composer) {
  registry.set(composer.id, composer);
}

export function composerFor(id: string): Composer {
  const composer = registry.get(id);
  if (!composer) {
    throw new Error(
      `Unknown composer "${id}". Registered: ${[...registry.keys()].join(", ") || "none"}.`,
    );
  }
  return composer;
}

export const listComposers = () => [...registry.values()];

/** Guards against a composer that reported success without writing anything. */
export async function assertCompositionWritten(dir: string) {
  const missing: string[] = [];
  for (const file of COMPOSITION_FILES) {
    const target = path.join(dir, file);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || stat.size < 40) missing.push(file);
  }
  if (missing.length) {
    throw new Error(`The composer did not produce: ${missing.join(", ")}.`);
  }
}
