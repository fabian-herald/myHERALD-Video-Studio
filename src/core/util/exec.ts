import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

export async function run(command: string, args: string[], options: {cwd?: string} = {}) {
  return execFileAsync(command, args, {maxBuffer: 32 * 1024 * 1024, ...options});
}

export async function exists(target: string) {
  return fs.access(target).then(() => true).catch(() => false);
}

/** Stable short hash used for every cache key in the pipeline. */
export function hash(value: unknown, length = 20) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

export async function fileHash(target: string) {
  return createHash("sha256").update(await fs.readFile(target)).digest("hex");
}

/** Media duration in seconds. Returns 0 when ffprobe cannot read the file. */
export async function probeDuration(target: string): Promise<number> {
  const {stdout} = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    target,
  ]).catch(() => ({stdout: ""}));
  const duration = Number.parseFloat(stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({length: Math.max(1, Math.min(limit, items.length))}, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}
