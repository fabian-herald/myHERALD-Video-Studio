import fs from "node:fs/promises";
import path from "node:path";
import {VIDEOS_DIR} from "../paths.ts";

/**
 * What a video's folder is called.
 *
 * It used to be `<intent>-<6 hex>`, and every one of thirty folders began with
 * `thought-leadership-` and ended in noise. `ls` gave a wall of near-identical names in
 * arbitrary order, and finding "the one from Tuesday about brand drift" meant opening
 * plan.json files one at a time.
 *
 * So: the date first, because that is the question actually being asked, and it makes the
 * directory sort itself. Then words from the brief, because they are the only description
 * available at the moment the folder has to exist — the plan, and its much better title,
 * does not exist yet and cannot without somewhere to write it.
 */

/**
 * Words that carry no identity. Dropped so four words of slug are four useful ones —
 * "most-brands-measure-ai" is worse than "brands-measure-ai-content" by exactly one word.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from",
  "how", "in", "is", "it", "its", "just", "more", "most", "much", "no", "not", "of",
  "on", "or", "our", "so", "than", "that", "the", "their", "them", "they", "this",
  "to", "up", "was", "we", "what", "when", "which", "who", "why", "will", "with", "you",
  "your",
]);

export const SLUG_WORDS = 4;

/** Lowercase words, punctuation gone, stopwords dropped, accents flattened. */
export function briefSlug(brief: string, words = SLUG_WORDS): string {
  const slug = brief
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, words)
    .join("-");
  // A brief of nothing but stopwords is unlikely and not worth an exception; "video" is a
  // truthful placeholder and the date still distinguishes it.
  return slug || "video";
}

/** `2026-08-04`, in local time — the day the person made it, not a UTC day they were asleep for. */
export function dateStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export const videoIdFor = (brief: string, at: Date) => `${dateStamp(at)}-${briefSlug(brief)}`;

/**
 * The id, with a suffix if that folder is already taken.
 *
 * The old scheme folded `Date.now()` into a hash, so collisions were impossible and nobody
 * had to think about them. This one is legible instead, which means two videos from the
 * same brief on the same day would land in the same folder — and silently overwriting a
 * finished video is a worse outcome than an ugly `-2`.
 */
export async function uniqueVideoId(brief: string, at: Date = new Date()): Promise<string> {
  const base = videoIdFor(brief, at);
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const taken = await fs.access(path.join(VIDEOS_DIR, candidate)).then(() => true).catch(() => false);
    if (!taken) return candidate;
  }
}
