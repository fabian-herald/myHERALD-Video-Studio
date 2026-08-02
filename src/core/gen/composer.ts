import fs from "node:fs/promises";
import path from "node:path";
import type {AuthoringDir} from "../compose/workdir.ts";
import type {CheckReport} from "../render/check.ts";

/** The three files a composition consists of. Nothing else may be written. */
export const COMPOSITION_FILES = ["index.html", "styles.css", "animation.js"] as const;

export interface ComposeContext {
  authoring: AuthoringDir;
  /** Absolute path to the checker the composer may run on itself. */
  onLog: (line: string) => void;
  signal?: AbortSignal;
  /** Raised for the repair passes so a second attempt thinks harder. */
  effort: "default" | "high";
}

export interface ComposeResult {
  provider: string;
  model: string;
  turns: number;
  costUsd: number;
  /** Whatever the composer said about what it built. */
  notes: string;
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
