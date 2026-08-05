import fs from "node:fs/promises";
import {removeLedgerEntry, setLedgerArchived, type LedgerEntry} from "./ledger.ts";
import {safeVideoDir, safeVideoOutDir} from "./paths.ts";
import {deleteThread, setThreadArchived, threadForVideo} from "./threads.ts";

/**
 * Retiring and removing a video, as one operation across the three places it exists.
 *
 * A video is a ledger entry, a working directory, rendered output and usually a thread,
 * and the studio had no way to put any of that away. Twenty-eight entries later the rail
 * is mostly tests, so the two verbs here are the ones that were missing — deliberately
 * two, because they answer different questions. Archive is "stop showing me this and stop
 * counting it", and it is reversible. Delete is "the bytes go", and it is not.
 *
 * Archive is the one the UI leads with, for that reason.
 */

/** Archive or restore a video and the thread it was made in. */
export async function setVideoArchived(videoId: string, archived: boolean): Promise<LedgerEntry | null> {
  const entry = await setLedgerArchived(videoId, archived);
  if (!entry) return null;

  // The thread follows the video rather than being archived separately: they are one piece
  // of work to the owner, and leaving the thread behind would leave the rail exactly as
  // long as it was, which is the complaint archiving exists to answer.
  const thread = await threadForVideo(videoId);
  if (thread) await setThreadArchived(thread.id, archived);
  return entry;
}

export interface VideoDeletion {
  /** False when there was no ledger entry to remove — the caller reports a 404, not a lie. */
  removed: boolean;
  /** What actually went, so the confirmation is a fact rather than a hope. */
  deleted: {ledger: boolean; workdir: boolean; output: boolean; thread: boolean};
}

/**
 * Delete a video: its ledger entry, its working directory, its rendered output, its thread.
 *
 * Both directories go through the containment helpers rather than `videoDir`/`videoOutDir`,
 * because this is the one path in the studio that removes a tree. The route regex already
 * refuses a `..`; this refuses it a second time, where the recursive delete actually is.
 */
export async function deleteVideo(videoId: string): Promise<VideoDeletion> {
  const removed = await removeLedgerEntry(videoId);
  const thread = await threadForVideo(videoId);

  const workdir = safeVideoDir(videoId);
  const output = safeVideoOutDir(videoId);

  return {
    removed,
    deleted: {
      ledger: removed,
      workdir: workdir ? await removeTree(workdir) : false,
      output: output ? await removeTree(output) : false,
      thread: thread ? await deleteThread(thread.id) : false,
    },
  };
}

async function removeTree(dir: string): Promise<boolean> {
  const exists = await fs.stat(dir).then(() => true, () => false);
  if (!exists) return false;
  await fs.rm(dir, {recursive: true, force: true});
  return true;
}
