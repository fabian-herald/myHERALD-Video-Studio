import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DATA_DIR = path.join(ROOT, "data");
export const BRAND_DIR = path.join(DATA_DIR, "brand");
export const KNOWLEDGE_DIR = path.join(DATA_DIR, "knowledge");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const VIDEOS_DIR = path.join(DATA_DIR, "videos");
export const OUT_DIR = path.join(ROOT, "out");

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
  const resolved = path.resolve(OUT_DIR, videoId);
  const contained = resolved !== OUT_DIR && resolved.startsWith(`${OUT_DIR}${path.sep}`);
  return contained ? resolved : null;
}

export const rel = (absolute: string) => path.relative(ROOT, absolute);
