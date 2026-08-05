/**
 * Rebuild `data/videos/index.json` from what is on disk.
 *
 * Written because the ledger was truncated to zero bytes while two processes had it open,
 * and nothing in the repository holds a copy — `data/` is not tracked. It turned out to be
 * fully reconstructible, which is worth keeping true: every field below is re-derived the
 * way `pipeline/run.ts` derives it, from each video's `plan.json` and its rendered output.
 *
 * Two fields cannot come from disk, so they are stated here:
 *
 *   - `status`, which is the pipeline's verdict on a run, not a property of the files.
 *   - `createdAt`, which was the run's wall-clock time. The plan's own date is the same
 *     day at midnight, and is the closest thing that survives.
 *
 * Run with `npm run rebuild-ledger`. It overwrites the ledger, so read the list first.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {readFacts} from "../src/core/knowledge/facts.ts";
import {ledgerEntryZ, writeLedger, type LedgerEntry} from "../src/core/ledger.ts";
import {OUT_DIR, ROOT, rel, videoDir} from "../src/core/paths.ts";
import {factIdsUsedByPlan} from "../src/core/plan/claims.ts";

/** The ledger as it read before it was lost: id and pipeline verdict, in ledger order. */
const KNOWN: readonly [string, LedgerEntry["status"]][] = [
  ["2026-07-28-der-falsche-engpass-baseline-ed84", "failed"],
  ["2026-07-28-der-engpass-ist-nicht-die-menge-baseline-cbed", "ready"],
  ["2026-07-28-eine-woche-ein-gedanke-claude-466b", "failed"],
  ["2026-07-28-freigabe-ist-keine-formsache-baseline-85b9", "ready"],
  ["2026-07-28-das-nein-der-freigabe-baseline-2168", "ready"],
  ["2026-07-28-slots-statt-gedanken-claude-2a0e", "ready"],
  ["2026-07-28-calendar-only-measure-fullness-claude-a2ab", "ready"],
  ["2026-07-28-promise-monday-understand-thursday-claude-5741", "ready"],
  ["2026-07-29-finish-argument-then-write-claude-a83a", "ready"],
  ["2026-07-29-filter-gone-claude-63ea", "ready"],
  ["2026-07-30-short-hours-ideas-claude-2556", "ready"],
  ["2026-07-30-first-draft-deadline-claude-ce0e", "failed"],
  ["2026-08-01-topic-thesis-codex-55a8", "failed"],
  ["2026-08-01-judgment-has-cost-baseline-159b", "ready"],
  ["2026-08-01-iteration-debt-d939", "ready"],
  ["2026-08-01-consistency-cheap-codex-53e1", "failed"],
  ["2026-08-04-line-keep-codex-3172", "ready"],
  ["2026-08-04-standard-behind-schedule-016b", "failed"],
  ["2026-08-04-consistency-point-view-claude-dba0", "ready"],
  ["2026-08-04-consistency-identity-76bc", "failed"],
  ["2026-08-04-recognition-test-codex-174e", "failed"],
  ["2026-08-04-month-later-test-codex-9d42", "ready"],
  ["2026-08-05-speed-authorship-codex-0600", "failed"],
  ["2026-08-05-ship-thought-codex-9722", "failed"],
  ["2026-08-05-authorship-starts-early-codex-d794", "ready"],
  ["2026-08-05-let-authorship-lead-codex-d28f", "ready"],
  ["2026-08-05-speed-test-wrong-claude-1a99", "ready"],
  ["2026-08-05-brief-boundary-claude-0bb8", "failed"],
];

const facts = await readFacts();
const entries: LedgerEntry[] = [];
const missing: string[] = [];

for (const [id, status] of KNOWN) {
  const raw = await fs.readFile(path.join(videoDir(id), "plan.json"), "utf8").catch(() => null);
  if (!raw) {
    missing.push(id);
    continue;
  }
  const plan = JSON.parse(raw);

  // Only the canonical master per format. The comparison renders beside them —
  // `master-9x16-terra-high.mp4` and friends — were never ledger outputs.
  const outputs: {format: string; path: string}[] = [];
  for (const format of plan.formats ?? []) {
    const file = path.join(OUT_DIR, id, `master-${format}.mp4`);
    if (await fs.stat(file).then(() => true, () => false)) outputs.push({format, path: rel(file)});
  }

  entries.push(ledgerEntryZ.parse({
    id,
    title: plan.title,
    thesis: plan.thesis,
    intent: plan.intent,
    formats: plan.formats,
    language: plan.language,
    createdAt: new Date(plan.createdAt).toISOString(),
    status,
    spokenScript: (plan.sections ?? [])
      .flatMap((section: {phrases?: {text: string}[]}) => (section.phrases ?? []).map((phrase) => phrase.text))
      .join(" "),
    mediaIds: [],
    factIds: factIdsUsedByPlan(plan, facts),
    outputs,
  }));
}

await writeLedger(entries);

console.log(`rebuilt ${entries.length} of ${KNOWN.length} entries in ${rel(ROOT)}data/videos/index.json`);
console.log(`  with rendered output: ${entries.filter((entry) => entry.outputs.length).length}`);
console.log(`  charting a fact:      ${entries.filter((entry) => entry.factIds.length).length}`);
if (missing.length) console.log(`  no plan.json for:     ${missing.join(", ")}`);
