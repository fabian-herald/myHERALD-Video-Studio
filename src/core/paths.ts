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

export const rel = (absolute: string) => path.relative(ROOT, absolute);
