import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a JSON state file so a reader never sees it half-written.
 *
 * `fs.writeFile` truncates first and writes second. Between those two syscalls the file on
 * disk is zero bytes, and anything that reads it in that window gets nothing — which is not
 * theoretical: the ledger was found empty twice in one afternoon, once with a test suite
 * beside a dev server and once with two processes working in the same directory. Both times
 * the recovery was a script, and the second time proved the first fix had only removed one
 * of the writers rather than the window.
 *
 * A temp file in the same directory plus `rename` closes it. POSIX rename is atomic within a
 * filesystem, so a concurrent reader observes either the previous file or the complete new
 * one. Same directory matters: renaming across filesystems is a copy, which is not atomic.
 *
 * This does not make concurrent *writers* safe — two processes each writing their own view
 * of the ledger will still have a last-one-wins outcome. It makes the file always readable
 * and always complete, which is the difference between losing one update and losing all 28.
 */
export async function writeJsonFile(target: string, value: unknown): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, {recursive: true});

  // Named from the target and the pid so two processes writing at once do not share a temp
  // file — which would reintroduce exactly the interleaving this exists to prevent.
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, {force: true});
    throw error;
  }
}
