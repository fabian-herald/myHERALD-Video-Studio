/**
 * Two different numbers that are easy to confuse, kept apart on purpose.
 *
 * `chargedUsd` is money that actually leaves an account for this run.
 * `apiEquivalentUsd` is what the same token usage would have cost at metered API list
 * prices, which is what the Agent SDK reports whether or not you are billed that way.
 *
 * Under a CLI subscription the model work is already paid for by the monthly plan, so
 * the charged figure is zero and the equivalent figure is a comparison, not a bill.
 * Reporting only one of them is how a tool ends up either alarming its owner or hiding
 * a real cost.
 */

export type BillingMode = "subscription" | "api";

export interface CostEntry {
  provider: string;
  step: string;
  chargedUsd: number;
  apiEquivalentUsd: number;
  note: string;
}

export interface CostSummary {
  billingMode: BillingMode;
  chargedUsd: number;
  apiEquivalentUsd: number;
  entries: CostEntry[];
}

/**
 * How the local `claude` CLI is authenticated. An explicit API key means metered
 * billing; otherwise the CLI is signed in to a plan and the run is covered by it.
 * `STUDIO_BILLING_MODE` overrides the guess.
 */
export function billingMode(): BillingMode {
  const override = process.env.STUDIO_BILLING_MODE;
  if (override === "api" || override === "subscription") return override;
  return process.env.ANTHROPIC_API_KEY?.trim() ? "api" : "subscription";
}

export class CostLedger {
  readonly mode: BillingMode;
  private readonly entries: CostEntry[] = [];

  constructor(mode: BillingMode = billingMode()) {
    this.mode = mode;
  }

  /** Model work through a CLI. Charged only when that CLI bills per token. */
  model(provider: string, step: string, apiEquivalentUsd: number, note = "") {
    this.entries.push({
      provider,
      step,
      apiEquivalentUsd,
      chargedUsd: this.mode === "api" ? apiEquivalentUsd : 0,
      note: note || (this.mode === "api"
        ? "metered API billing"
        : "covered by the CLI subscription"),
    });
  }

  /** A provider that bills directly, independent of how the model work is paid for. */
  metered(provider: string, step: string, chargedUsd: number, note = "") {
    this.entries.push({provider, step, chargedUsd, apiEquivalentUsd: chargedUsd, note});
  }

  /** Something genuinely free, recorded so the ledger stays complete. */
  free(provider: string, step: string, note: string) {
    this.entries.push({provider, step, chargedUsd: 0, apiEquivalentUsd: 0, note});
  }

  summary(): CostSummary {
    return {
      billingMode: this.mode,
      chargedUsd: round(this.entries.reduce((sum, entry) => sum + entry.chargedUsd, 0)),
      apiEquivalentUsd: round(this.entries.reduce((sum, entry) => sum + entry.apiEquivalentUsd, 0)),
      entries: this.entries.map((entry) => ({
        ...entry,
        chargedUsd: round(entry.chargedUsd),
        apiEquivalentUsd: round(entry.apiEquivalentUsd),
      })),
    };
  }
}

const round = (value: number) => Number(value.toFixed(4));

/** One line for a terminal or a chat log. */
export function formatCost(summary: CostSummary): string {
  const charged = `$${summary.chargedUsd.toFixed(2)} charged`;
  if (summary.chargedUsd === summary.apiEquivalentUsd) return charged;
  return `${charged} · $${summary.apiEquivalentUsd.toFixed(2)} at API list prices`;
}
