import fs from "node:fs/promises";
import path from "node:path";

/**
 * Wall-clock per stage, aggregated by name.
 *
 * The pipeline has always logged which stage it is in and never how long that stage
 * took, which makes every speed argument a guess about proportion. Spans nest freely:
 * `compose` contains its own attempts, so the summary reports the whole and the parts,
 * and the gap between them is the cost nobody has named yet.
 */
export interface Span {
  name: string;
  ms: number;
}

export interface StageTotal {
  name: string;
  ms: number;
  count: number;
  /** Fraction of the run's wall clock. Nested spans deliberately sum past 1. */
  share: number;
}

const SECONDS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export class Timeline {
  private readonly spans: Span[] = [];
  private readonly startedAt = Date.now();

  /**
   * Timed in `finally`, not after a successful await. A stage that threw or was
   * cancelled is exactly the one whose cost you want on the record.
   */
  async span<T>(name: string, work: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      return await work();
    } finally {
      this.spans.push({name, ms: Date.now() - at});
    }
  }

  /**
   * Record an already-measured span. `span()` reads better, but wrapping a call in a
   * closure changes the source text, and `visual-review.test.ts` locates the review
   * flow by the position of `await renderSnapshots` and `await composer.review`. The
   * order of that flow is a guarantee worth more than tidier instrumentation.
   */
  record(name: string, ms: number) {
    this.spans.push({name, ms});
  }

  /** Start a manual span; call the returned function when the work is done. */
  open(name: string): () => void {
    const at = Date.now();
    return () => this.record(name, Date.now() - at);
  }

  get elapsedMs() {
    return Date.now() - this.startedAt;
  }

  /** One row per distinct span name, slowest first. */
  totals(): StageTotal[] {
    const wall = Math.max(1, this.elapsedMs);
    const byName = new Map<string, {ms: number; count: number}>();
    for (const span of this.spans) {
      const entry = byName.get(span.name) ?? {ms: 0, count: 0};
      byName.set(span.name, {ms: entry.ms + span.ms, count: entry.count + 1});
    }
    return [...byName]
      .map(([name, entry]) => ({name, ms: entry.ms, count: entry.count, share: entry.ms / wall}))
      .sort((a, b) => b.ms - a.ms);
  }

  /** Log lines in the pipeline's existing 14-column format. */
  report(log: (line: string) => void) {
    const rows = this.totals();
    const width = Math.max(8, ...rows.map((row) => row.name.length));
    log(`profile       total ${SECONDS(this.elapsedMs)}`);
    for (const row of rows) {
      log(
        `profile       ${row.name.padEnd(width)}  ${SECONDS(row.ms).padStart(8)}`
        + `  ${`${Math.round(row.share * 100)}%`.padStart(4)}  ×${row.count}`,
      );
    }
  }

  /** Machine-readable alongside provenance.json, so two runs can be diffed. */
  async write(target: string) {
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(
      target,
      `${JSON.stringify({totalMs: this.elapsedMs, stages: this.totals(), spans: this.spans}, null, 2)}\n`,
    );
  }
}
