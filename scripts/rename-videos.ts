/**
 * Rename existing video folders to the readable scheme.
 *
 *   npm run rename-videos            # dry run: prints what it would do, touches nothing
 *   npm run rename-videos -- --apply
 *
 * `thought-leadership-9d4266` says nothing. `2026-08-04-month-later-test-codex` says what
 * the video is, when it was made and which backend composed it — the three things anyone
 * scanning the folder list is actually looking for.
 *
 * An id is three things at once: a directory under `data/videos`, a directory under `out`,
 * and a key in the ledger whose entries embed output paths built from it. All three move
 * together or none do, which is why this is a script and not a `mv`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {readLedger, writeLedger} from "../src/core/ledger.ts";
import {OUT_DIR, VIDEOS_DIR} from "../src/core/paths.ts";
import {videoIdFor} from "../src/core/pipeline/videoId.ts";

const apply = process.argv.includes("--apply");

const exists = (target: string) => fs.access(target).then(() => true).catch(() => false);

/** Which backend composed it. Provenance first; the ledger has no record of it. */
async function composerOf(id: string): Promise<string> {
  const raw = await fs.readFile(path.join(OUT_DIR, id, "provenance.json"), "utf8").catch(() => null);
  if (!raw) return "";
  const provenance = JSON.parse(raw) as {composer?: {provider?: string}};
  const provider = provenance.composer?.provider ?? "";
  // "baseline" is the deterministic fallback and is worth saying; "unknown" is not.
  return provider === "unknown" || provider === "?" ? "" : provider;
}

const plans = new Map<string, {title: string; createdAt: string}>();
const ledger = await readLedger();
for (const entry of ledger) plans.set(entry.id, {title: entry.title, createdAt: entry.createdAt});

const renames: {from: string; to: string}[] = [];
const taken = new Set<string>();
const skipped: string[] = [];

for (const id of (await fs.readdir(VIDEOS_DIR)).sort()) {
  if (!await exists(path.join(VIDEOS_DIR, id, "plan.json"))) {
    skipped.push(`${id} — no plan.json, nothing to name it from`);
    continue;
  }
  const plan = JSON.parse(await fs.readFile(path.join(VIDEOS_DIR, id, "plan.json"), "utf8")) as {
    title?: string;
    createdAt?: string;
  };
  const title = plan.title ?? plans.get(id)?.title ?? "";
  const createdAt = plan.createdAt ?? plans.get(id)?.createdAt ?? "";
  if (!title.trim() || !createdAt) {
    skipped.push(`${id} — no ${title.trim() ? "date" : "title"} to build a name from`);
    continue;
  }

  // The old six-character code is kept as the tail. It disambiguates three videos all
  // called some version of "The Second Draft", and it means anyone holding the old name
  // can still find the folder — `-2` and `-3` would have thrown both away.
  const code = /-([0-9a-f]{6})$/.exec(id)?.[1]?.slice(0, 4) ?? "";
  const candidate = videoIdFor(title, await composerOf(id), new Date(createdAt), code);
  taken.add(candidate);
  if (candidate !== id) renames.push({from: id, to: candidate});
}

for (const {from, to} of renames) console.log(`${from}\n  → ${to}`);
for (const note of skipped) console.log(`skip  ${note}`);
console.log(`\n${renames.length} to rename, ${skipped.length} skipped`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to move them.");
  process.exit(0);
}

// Directories first, then the ledger. A half-applied rename with the ledger already
// rewritten would point every entry at a path that does not exist yet; this order means an
// interruption leaves entries pointing at folders that are still there under the old name.
for (const {from, to} of renames) {
  await fs.rename(path.join(VIDEOS_DIR, from), path.join(VIDEOS_DIR, to));
  if (await exists(path.join(OUT_DIR, from))) {
    await fs.rename(path.join(OUT_DIR, from), path.join(OUT_DIR, to));
  }
  // The plan carries its own id, and `applyPlanEdits` reads it back.
  const planPath = path.join(VIDEOS_DIR, to, "plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as Record<string, unknown>;
  plan.id = to;
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`moved ${from} → ${to}`);
}

const byOldId = new Map(renames.map(({from, to}) => [from, to]));
await writeLedger(ledger.map((entry) => {
  const to = byOldId.get(entry.id);
  if (!to) return entry;
  return {
    ...entry,
    id: to,
    // Output paths embed the id and are shown in the Studio, so they move with it.
    outputs: entry.outputs?.map((output) => ({
      ...output,
      path: output.path.replace(`/${entry.id}/`, `/${to}/`),
    })),
  };
}));

console.log(`\n${renames.length} renamed, ledger rewritten.`);
