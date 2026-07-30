/**
 * Cancellation, as a thing the pipeline can tell apart from a failure.
 *
 * The distinction is the whole point. A compose attempt that throws is a bad attempt and
 * the right response is to try again — that retry is what the repair budget is for. A
 * compose attempt that throws *because the run was cancelled* is not a bad attempt, and
 * retrying it spawns another model session against a run nobody is waiting for any more.
 *
 * Without the distinction the loop cannot tell them apart, and it did not: cancelling a run
 * left it composing for over an hour, spawning a fresh composer every few seconds. Killing
 * one produced another. The only way to stop it was to kill the server.
 */
export class Cancelled extends Error {
  override readonly name = "Cancelled";

  constructor(stage: string) {
    super(`Cancelled during ${stage}.`);
  }
}

/** Stop here if the run has been cancelled. Call it at every stage boundary. */
export function throwIfCancelled(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw new Cancelled(stage);
}

/**
 * Was this thrown because the run was cancelled?
 *
 * Covers our own `Cancelled` and the `AbortError` an aborted fetch or SDK query raises,
 * because a cancelled run produces whichever of the two happened to be in flight — and a
 * check that catches only one of them is a check that works most of the time, which here
 * means a retry loop that occasionally will not stop.
 */
export function isCancellation(error: unknown): boolean {
  if (error instanceof Cancelled) return true;
  const name = (error as {name?: unknown} | null)?.name;
  return name === "AbortError" || name === "Cancelled";
}
