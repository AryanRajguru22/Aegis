import type { BaselineFlag } from "./types.js";

/**
 * Deliberately simple, explicit heuristics — see docs/MVP_SCOPE.md §3: "sophisticated
 * behavioral-baseline statistics... a simplified heuristic is fine for the demo if
 * genuinely time-constrained — but this must be disclosed... not presented as more
 * than it is." This is that heuristic. It catches two of the concrete threats named in
 * docs/THREAT_MODEL.md: §3 (a runaway/looping agent making many rapid transactions)
 * and a coarse version of unusual spend size. It is explicitly NOT: multi-hop
 * collusion-graph analysis, category-shift detection, or anything resembling a
 * trained anomaly model — those are named as production/long-term work in
 * docs/SYSTEM_ARCHITECTURE.md §10, not claimed here.
 */
export interface BaselineWindow {
  /** Rolling window, in milliseconds, used for the rate check. */
  maxAgeMs: number;
  /** Number of transactions within maxAgeMs that triggers a high-rate flag. */
  rateThreshold: number;
  /** Minimum prior transactions required before the amount-deviation check applies at all — too little history is not evidence of anything. */
  minSamplesForAmountBaseline: number;
  /** A transaction more than this multiple of the historical mean is flagged. */
  amountDeviationMultiplier: number;
}

export const DEFAULT_BASELINE_WINDOW: BaselineWindow = {
  maxAgeMs: 60_000,
  rateThreshold: 5,
  minSamplesForAmountBaseline: 3,
  amountDeviationMultiplier: 3,
};

export interface HistoricalTransaction {
  amountMinorUnits: number;
  createdAt: string;
}

export function scoreDeviation(
  history: HistoricalTransaction[],
  attempt: { amountMinorUnits: number; now?: string },
  window: BaselineWindow = DEFAULT_BASELINE_WINDOW
): BaselineFlag[] {
  const flags: BaselineFlag[] = [];
  const now = attempt.now ? new Date(attempt.now).getTime() : Date.now();

  const recentCount = history.filter((h) => now - new Date(h.createdAt).getTime() <= window.maxAgeMs).length;
  if (recentCount >= window.rateThreshold) {
    flags.push({
      code: "high_rate",
      detail: `${recentCount} transactions by this agent in the last ${Math.round(window.maxAgeMs / 1000)}s (threshold: ${window.rateThreshold})`,
    });
  }

  if (history.length >= window.minSamplesForAmountBaseline) {
    const mean = history.reduce((sum, h) => sum + h.amountMinorUnits, 0) / history.length;
    if (mean > 0 && attempt.amountMinorUnits > mean * window.amountDeviationMultiplier) {
      flags.push({
        code: "amount_deviation",
        detail: `Amount (${attempt.amountMinorUnits}) is ${(attempt.amountMinorUnits / mean).toFixed(1)}x this agent's historical average (${Math.round(mean)}), over the ${window.amountDeviationMultiplier}x threshold`,
      });
    }
  }

  return flags;
}
