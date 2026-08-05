import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A throwaway root for the two directories that hold state, set only by tests.
 *
 * The ledger, the threads and the rendered output are the owner's real work and nothing in
 * the repository holds a copy — `data/` is untracked. Two test files exercising the ledger
 * did it by snapshotting the real `index.json`, writing a fixture over it and restoring it
 * afterwards, which is fine alone and not fine in parallel: the runner gives each file its
 * own process, both snapshot-and-restore cycles interleaved, and the file came back empty.
 *
 * So the sandbox is a property of the path layer rather than of each test's discipline.
 * Unset in every real run, which is why `ROOT` is still the default rather than a required
 * variable — a studio started without it must not quietly write somewhere else.
 */
const SANDBOX = process.env.STUDIO_SANDBOX;

export const DATA_DIR = path.join(SANDBOX ?? ROOT, "data");

/**
 * The brand kit, and the one directory the sandbox deliberately does not cover.
 *
 * Everything else under `data/` is state a run produces. The brand kit is the opposite: an
 * input the owner supplied once, that tests read and none of them write. Redirecting it too
 * made the sandbox all-or-nothing — opting a test file in cost it the tokens, the lockups and
 * the wordmark, so eight tests that check a composition against the real brand fail against an
 * empty directory. That is why fifteen of the seventeen test files never opted in, and why the
 * suite still raced a live pipeline run over the ledger, the threads and the research dir.
 *
 * Pinned to `ROOT` rather than made switchable: a sandbox exists so a test cannot damage the
 * owner's work, and nothing here writes the brand kit — only the studio's upload path and
 * `scripts/tokens.ts` do, and neither runs under test.
 */
export const BRAND_DIR = path.join(ROOT, "data", "brand");
export const KNOWLEDGE_DIR = path.join(DATA_DIR, "knowledge");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const VIDEOS_DIR = path.join(DATA_DIR, "videos");
export const OUT_DIR = path.join(SANDBOX ?? ROOT, "out");

/** Everything a single video owns: plan, narration, compose workdirs, attempts. */
export function videoDir(videoId: string) {
  return path.join(VIDEOS_DIR, videoId);
}

export function videoOutDir(videoId: string) {
  return path.join(OUT_DIR, videoId);
}

/**
 * `videoOutDir`, but `null` when the id would take the path outside `out/`.
 *
 * For anywhere a video id arrives from outside the process — an HTTP route, a CLI
 * argument — and is about to be handed to something with reach, like a file manager.
 * Callers have their own input filters; this makes containment a property of the path
 * layer rather than a property of whichever regex happened to guard the caller.
 */
export function safeVideoOutDir(videoId: string): string | null {
  return contained(OUT_DIR, videoId);
}

/**
 * `videoDir`, but `null` when the id would take the path outside `data/videos/`.
 *
 * The same containment as `safeVideoOutDir`, and required for the same reason: delete
 * removes a directory tree, which is the one operation where a traversal is unrecoverable.
 */
export function safeVideoDir(videoId: string): string | null {
  return contained(VIDEOS_DIR, videoId);
}

function contained(root: string, videoId: string): string | null {
  const resolved = path.resolve(root, videoId);
  const inside = resolved !== root && resolved.startsWith(`${root}${path.sep}`);
  return inside ? resolved : null;
}

export const rel = (absolute: string) => path.relative(ROOT, absolute);
