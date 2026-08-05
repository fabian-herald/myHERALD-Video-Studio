/**
 * Point the threads at their videos again, and name them after what they made.
 *
 *   npm run relink-threads            # dry run: prints what it would do, touches nothing
 *   npm run relink-threads -- --apply
 *
 * Two repairs, from one cause. `rename-videos` moved every video to the readable scheme —
 * `thought-leadership-ed8445` became `2026-07-28-der-falsche-engpass-baseline-ed84` — and
 * moved the ledger and both directories with it, but not the `videoId` each thread holds.
 * Nine threads have pointed at ids that no longer exist ever since, which is not cosmetic:
 * their canvas has no video to show, and opening the video from the Videos screen looks for
 * a thread by that id, fails to find one, and starts a second thread on the same video.
 *
 * With the link back, the second repair follows for free: a thread whose title this studio
 * generated can finally be named after its video rather than after the prompt that opened
 * it. Threads with no video are named from their first message. See `core/threadTitle.ts`.
 *
 * The old six-hex code survives as the new id's four-character tail — that is what makes
 * the match possible, and an old id that matches two entries is reported rather than
 * guessed at. `updatedAt` is left alone: the rail sorts on it, and this is not work.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {readLedger} from "../src/core/ledger.ts";
import {THREADS_DIR, listThreads, threadZ} from "../src/core/threads.ts";
import {isGeneratedTitle, resolveThreadTitle} from "../src/core/threadTitle.ts";

const apply = process.argv.includes("--apply");

const ledger = await readLedger();
const byId = new Map(ledger.map((entry) => [entry.id, entry]));

/** Ledger entries whose id ends in `-<tail>`, for a four-character tail. */
const byTail = new Map<string, string[]>();
for (const entry of ledger) {
  const tail = entry.id.split("-").at(-1) ?? "";
  if (tail.length !== 4) continue;
  byTail.set(tail, [...(byTail.get(tail) ?? []), entry.id]);
}

/** The renamed id for a pre-rename one, or a reason it could not be resolved. */
function relink(oldId: string): {id: string} | {problem: string} {
  const code = oldId.split("-").at(-1) ?? "";
  if (code.length < 4) return {problem: `no code to match on in ${oldId}`};

  const matches = byTail.get(code.slice(0, 4)) ?? [];
  if (matches.length === 1 && matches[0]) return {id: matches[0]};
  if (matches.length > 1) return {problem: `${oldId} matches ${matches.length}: ${matches.join(", ")}`};
  return {problem: `${oldId} matches nothing in the ledger`};
}

interface Change {
  id: string;
  title: string;
  nextTitle: string;
  videoId?: string;
  nextVideoId?: string;
}

const changes: Change[] = [];
const problems: string[] = [];
const kept: string[] = [];

for (const thread of await listThreads()) {
  if (thread.kind === "studio") continue;

  let videoId = thread.videoId;
  if (videoId && !byId.has(videoId)) {
    const resolved = relink(videoId);
    if ("id" in resolved) videoId = resolved.id;
    else problems.push(`${thread.title}: ${resolved.problem}`);
  }

  const nextTitle = resolveThreadTitle({
    current: thread.title,
    videoTitle: videoId ? byId.get(videoId)?.title : undefined,
    firstMessage: thread.messages.find((message) => message.role === "user")?.text,
  });

  const movedLink = videoId !== thread.videoId;
  const movedTitle = nextTitle !== thread.title;
  if (!movedLink && !movedTitle) {
    kept.push(`${thread.title}${isGeneratedTitle(thread.title) ? " — nothing better to call it" : ""}`);
    continue;
  }
  changes.push({id: thread.id, title: thread.title, nextTitle, videoId: thread.videoId, nextVideoId: videoId});
}

for (const change of changes) {
  const parts: string[] = [];
  if (change.nextTitle !== change.title) parts.push(`"${change.title}" -> "${change.nextTitle}"`);
  if (change.nextVideoId !== change.videoId) parts.push(`${change.videoId} -> ${change.nextVideoId}`);
  console.log(`  ${parts.join("\n    ")}`);
}
for (const line of kept) console.log(`  kept: ${line}`);
for (const line of problems) console.log(`  unresolved: ${line}`);

if (!changes.length) {
  console.log("\nNothing to change.");
} else if (!apply) {
  console.log(`\n${changes.length} thread(s) would change. Re-run with --apply.`);
} else {
  for (const change of changes) {
    const file = path.join(THREADS_DIR, `${change.id}.json`);
    const thread = threadZ.parse(JSON.parse(await fs.readFile(file, "utf8")));
    // Written directly rather than through `saveThread`, which restamps `updatedAt`.
    const next = threadZ.parse({
      ...thread,
      title: change.nextTitle,
      ...(change.nextVideoId ? {videoId: change.nextVideoId} : {}),
    });
    await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  console.log(`\nUpdated ${changes.length} thread(s).`);
}
