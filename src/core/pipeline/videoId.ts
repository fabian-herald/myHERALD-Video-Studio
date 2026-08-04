import {createHash} from "node:crypto";
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
 * directory sort itself. Then the plan's own title, then the backend that composed it,
 * then four characters so two videos of the same name on the same day stay two folders.
 *
 * Naming it needs the plan, and the plan used to be written into a folder that had to
 * exist first. `runPipeline` now plans before it creates anything — nothing touches disk
 * until the title is known, so there is no chicken and egg and nothing to move afterwards.
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

/**
 * `2026-08-04-the-month-later-test-codex`.
 *
 * Date first so the folder list sorts itself and "the one from Tuesday" is findable. Then
 * the plan's own title, which is the best description that exists — "The Month-Later Test"
 * beats any slug of the brief, and beats a hash by a distance. Then who composed it,
 * because comparing one backend against the other is a thing that actually gets done and
 * the answer was previously only inside `out/<id>/provenance.json`.
 *
 * The intent is deliberately not here. Nine of ten videos are `thought-leadership`, so
 * leading with it puts the same nineteen characters in front of almost every name — which
 * is exactly what made the old scheme unreadable. It is in `plan.json` and the ledger.
 */
export const videoIdFor = (title: string, composer: string, at: Date, code = "") =>
  [dateStamp(at), briefSlug(title, TITLE_WORDS), briefSlug(composer, 1), code]
    .filter((part) => part && part !== "video")
    .join("-");

/**
 * A short tail so two videos with the same title on the same day are still two folders.
 *
 * Three of the existing videos are called some version of "The Second Draft", and naming
 * them `-2` and `-3` throws away the only thing that told them apart. Derived from the
 * title and the minute, so it is stable for one video and different for the next.
 */
export const shortCode = (title: string, at: Date) =>
  createHash("sha256")
    .update(`${title}|${at.toISOString().slice(0, 16)}`)
    .digest("hex")
    .slice(0, 4);

/** A title is already short and already chosen; keep more of it than a brief's opening. */
export const TITLE_WORDS = 6;

/**
 * The id, with a suffix if that folder is already taken.
 *
 * `shortCode` already separates two videos of the same title in different minutes, so this
 * only fires on a genuine same-minute repeat. It stays because the old scheme folded
 * `Date.now()` into a hash and could not collide at all, and silently overwriting a
 * finished video is a worse outcome than an ugly `-2`.
 */
export async function uniqueVideoId(
  title: string,
  composer: string,
  at: Date = new Date(),
): Promise<string> {
  const base = videoIdFor(title, composer, at, shortCode(title, at));
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const taken = await fs.access(path.join(VIDEOS_DIR, candidate)).then(() => true).catch(() => false);
    if (!taken) return candidate;
  }
}
