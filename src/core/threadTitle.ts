/**
 * What a thread is called in the rail.
 *
 * It used to be `Video ${new Date().toLocaleDateString()}`, set once when the thread was
 * created and never touched again. Five threads made on the same afternoon were therefore
 * five rows reading `Video 8/1/2026`, and the only way to tell them apart was to open each
 * one — while the finished video sitting inside each of them already had a real title.
 *
 * So a thread is named after the best thing that exists at the time, in this order:
 *
 *   1. Its video's title, once there is a video. That is what the thread produced, and it
 *      is a name a person wrote rather than one this file assembled.
 *   2. The owner's first message, trimmed. Before a video exists this is the only
 *      description of the work there is, and it is a good one.
 *   3. `Untitled video`, for the moment between pressing New video and typing anything.
 *
 * Names this file generated are replaceable; names that came from a video or a person are
 * not. `isGeneratedTitle` is what keeps that distinction, so a later rename can never
 * overwrite something meaningful with something derived.
 */

export const UNTITLED_THREAD = "Untitled video";

/** Long enough for a real sentence fragment, short enough for a 256px rail. */
export const TITLE_MAX_CHARS = 48;

/**
 * A thread title this studio invented, rather than one taken from a video or a person.
 *
 * The legacy shape is matched too — `Video 8/1/2026`, `Video 01.08.2026`, whatever
 * `toLocaleDateString` produced in the owner's locale — because those are exactly the
 * threads that need renaming and none of them is a name anybody chose.
 */
export function isGeneratedTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === ""
    || trimmed === UNTITLED_THREAD
    || /^video\s+[\d\s./-]+$/i.test(trimmed);
}

/**
 * The opening of a message, as a title.
 *
 * Cut at a word boundary rather than mid-word: `Was habe ich zum Thema Content-Kal…` reads
 * as a truncation of something, where `Was habe ich zum Thema Content-Kalen` reads as a
 * typo. A single word longer than the limit is cut anyway — there is no boundary to find.
 */
export function titleFromMessage(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return UNTITLED_THREAD;
  if (flat.length <= TITLE_MAX_CHARS) return flat;

  const cut = flat.slice(0, TITLE_MAX_CHARS);
  const boundary = cut.lastIndexOf(" ");
  // Only honour a boundary that leaves a usable title behind; a first word of 40
  // characters would otherwise produce a two-character name plus an ellipsis.
  const kept = boundary > TITLE_MAX_CHARS / 2 ? cut.slice(0, boundary) : cut;
  return `${kept.replace(/[\s,;:.\-–—]+$/u, "")}…`;
}

/**
 * The title a thread should carry now, given what has since become known about it.
 *
 * Returns the current title unchanged whenever there is nothing better, so a caller can
 * assign it unconditionally: this is the whole rule, in one place, rather than an `if` at
 * each of the three call sites that were free to disagree with each other.
 */
export function resolveThreadTitle(options: {
  current: string;
  /** The ledger title of this thread's video, if it has one. */
  videoTitle?: string;
  /** The owner's first message in this thread, if there is one. */
  firstMessage?: string;
}): string {
  const {current, videoTitle, firstMessage} = options;
  if (!isGeneratedTitle(current)) return current;
  if (videoTitle?.trim()) return videoTitle.trim();
  if (firstMessage?.trim()) return titleFromMessage(firstMessage);
  return current.trim() || UNTITLED_THREAD;
}
