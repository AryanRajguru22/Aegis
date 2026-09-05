import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scoreDeviation, DEFAULT_BASELINE_WINDOW } from "../baseline.js";

const NOW = "2026-01-01T00:00:00.000Z";

describe("scoreDeviation", () => {
  test("no history, no flags", () => {
    const flags = scoreDeviation([], { amountMinorUnits: 100_000, now: NOW });
    assert.deepEqual(flags, []);
  });

  test("below the minimum sample size, amount deviation never fires even for an extreme outlier", () => {
    const history = [
      { amountMinorUnits: 1_000, createdAt: "2025-01-01T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-02T00:00:00.000Z" },
    ];
    const flags = scoreDeviation(history, { amountMinorUnits: 1_000_000, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.deepEqual(flags, [], "2 samples is below minSamplesForAmountBaseline (3) — insufficient evidence, must not flag");
  });

  test("amount far above the historical mean is flagged once enough samples exist", () => {
    const history = [
      { amountMinorUnits: 1_000, createdAt: "2025-01-01T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-02T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-03T00:00:00.000Z" },
    ];
    const flags = scoreDeviation(history, { amountMinorUnits: 5_000, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.code, "amount_deviation");
  });

  test("the amount-deviation detail formats money for a human reader ($50.00 / $10.00), never the raw minor units (5000 / 1000)", () => {
    const history = [
      { amountMinorUnits: 1_000, createdAt: "2025-01-01T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-02T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-03T00:00:00.000Z" },
    ];
    const flags = scoreDeviation(history, { amountMinorUnits: 5_000, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.equal(
      flags[0]?.detail,
      "Amount ($50.00) is 5.0x this agent's historical average ($10.00), over the 3x threshold"
    );
    assert.doesNotMatch(flags[0]?.detail ?? "", /\b5000\b/);
    assert.doesNotMatch(flags[0]?.detail ?? "", /\b1000\b/);
  });

  test("amount just under the multiplier threshold is not flagged", () => {
    const history = [
      { amountMinorUnits: 1_000, createdAt: "2025-01-01T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-02T00:00:00.000Z" },
      { amountMinorUnits: 1_000, createdAt: "2025-01-03T00:00:00.000Z" },
    ];
    const flags = scoreDeviation(history, { amountMinorUnits: 2_999, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.deepEqual(flags, []);
  });

  test("high transaction rate within the window is flagged", () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      amountMinorUnits: 1_000,
      createdAt: new Date(new Date(NOW).getTime() - i * 1000).toISOString(),
    }));
    const flags = scoreDeviation(history, { amountMinorUnits: 1_000, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.ok(flags.some((f) => f.code === "high_rate"));
  });

  test("transactions outside the rate window do not count toward the rate flag", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      amountMinorUnits: 1_000,
      createdAt: new Date(new Date(NOW).getTime() - (DEFAULT_BASELINE_WINDOW.maxAgeMs * 10 + i)).toISOString(),
    }));
    const flags = scoreDeviation(history, { amountMinorUnits: 1_000, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.equal(flags.some((f) => f.code === "high_rate"), false);
  });

  test("both flags can fire simultaneously", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      amountMinorUnits: 1_000,
      createdAt: new Date(new Date(NOW).getTime() - i * 1000).toISOString(),
    }));
    const flags = scoreDeviation(history, { amountMinorUnits: 100_000, now: NOW }, DEFAULT_BASELINE_WINDOW);
    assert.equal(flags.length, 2);
  });
});
