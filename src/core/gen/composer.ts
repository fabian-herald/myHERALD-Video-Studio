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
  /** Minimal diff against concrete findings. Never a blind re-author. */
  repair(context: ComposeContext, report: CheckReport, attempt: number): Promise<ComposeResult>;
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
