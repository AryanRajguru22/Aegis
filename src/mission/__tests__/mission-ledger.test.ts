import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeMissionSpent, remainingMissionBudget, LEDGER_KIND_MISSION_TRANSACTION_LINK } from "../ledger.js";
import type { LedgerEntry } from "../../state/ledger.js";

let nextSeq = 1;

/** Builds a synthetic LedgerEntry fixture — no real LedgerStore/DB involved, matching how src/risk/__tests__ exercises scoreDeviation against a plain history array. */
function fakeEntry(kind: string, data: Record<string, unknown>): LedgerEntry {
  return {
    seq: nextSeq++,
    kind,
    agentId: "agent-1",
    principalId: "principal-1",
    data,
    createdAt: new Date().toISOString(),
    prevHash: "deadbeef",
    contentHash: "cafef00d",
    signature: "sig",
  };
}

function linkEntry(missionId: string, amountMinorUnits: unknown, success: unknown): LedgerEntry {
  return fakeEntry(LEDGER_KIND_MISSION_TRANSACTION_LINK, { missionId, amountMinorUnits, success });
}

describe("computeMissionSpent — happy path (matches the approved design's explicit test list)", () => {
  test("an empty ledger yields 0 spent (empty mission → full budget remaining)", () => {
    assert.equal(computeMissionSpent([], "mission-1"), 0);
  });

  test("a ledger with entries for other missions, but none for this one, yields 0 spent", () => {
    const entries = [linkEntry("mission-other", 50_000, true)];
    assert.equal(computeMissionSpent(entries, "mission-1"), 0);
  });

  test("one successful ₹500 (50,000 minor units) transaction under a ₹2,000 mission leaves ₹1,500 remaining", () => {
    const entries = [linkEntry("mission-1", 50_000, true)];
    const spent = computeMissionSpent(entries, "mission-1");
    assert.equal(spent, 50_000);
    assert.equal(remainingMissionBudget({ budgetMinorUnits: 200_000 }, spent), 150_000);
  });

  test("multiple successful transactions sum correctly", () => {
    const entries = [linkEntry("mission-1", 50_000, true), linkEntry("mission-1", 30_000, true), linkEntry("mission-1", 20_000, true)];
    assert.equal(computeMissionSpent(entries, "mission-1"), 100_000);
  });

  test("a FAILED execution's ledger entry must NOT count against the budget — only successful settlements consume it", () => {
    const entries = [linkEntry("mission-1", 999_999, false)];
    assert.equal(computeMissionSpent(entries, "mission-1"), 0);
  });

  test("a mix of successful and failed entries for the same mission sums only the successful ones", () => {
    const entries = [
      linkEntry("mission-1", 50_000, true),
      linkEntry("mission-1", 999_999, false),
      linkEntry("mission-1", 20_000, true),
      linkEntry("mission-1", 888_888, false),
    ];
    assert.equal(computeMissionSpent(entries, "mission-1"), 70_000);
  });

  test("the function is pure: repeated calls with the same input array produce the same result", () => {
    const entries = [linkEntry("mission-1", 50_000, true), linkEntry("mission-1", 30_000, false)];
    assert.equal(computeMissionSpent(entries, "mission-1"), computeMissionSpent(entries, "mission-1"));
  });
});

describe("computeMissionSpent — adversarial: isolation from other missions and other ledger kinds", () => {
  test("ADVERSARIAL: entries for a DIFFERENT missionId, including large amounts, never leak into this mission's total", () => {
    const entries = [
      linkEntry("mission-1", 50_000, true),
      linkEntry("mission-attacker-controlled", 10_000_000, true),
    ];
    assert.equal(computeMissionSpent(entries, "mission-1"), 50_000);
  });

  test("ADVERSARIAL: an entry of a DIFFERENT ledger kind is ignored even if its data superficially matches the mission_transaction_link shape exactly", () => {
    const entries = [
      fakeEntry("policy_verdict", { missionId: "mission-1", amountMinorUnits: 999_999, success: true }),
      fakeEntry("decision", { missionId: "mission-1", amountMinorUnits: 999_999, success: true }),
    ];
    assert.equal(computeMissionSpent(entries, "mission-1"), 0);
  });

  test("ADVERSARIAL: a malformed entry belonging to a DIFFERENT mission does not throw and does not block computing THIS mission's spend — corruption elsewhere cannot deny service to an unrelated mission", () => {
    const entries = [
      linkEntry("mission-1", 50_000, true),
      linkEntry("mission-other", "not-a-number", "also-not-a-boolean"),
    ];
    assert.doesNotThrow(() => computeMissionSpent(entries, "mission-1"));
    assert.equal(computeMissionSpent(entries, "mission-1"), 50_000);
  });
});

describe("computeMissionSpent — adversarial: fails closed on a malformed entry belonging to the queried mission", () => {
  test("ADVERSARIAL: missing 'success' field throws rather than silently skipping or defaulting", () => {
    const entries = [fakeEntry(LEDGER_KIND_MISSION_TRANSACTION_LINK, { missionId: "mission-1", amountMinorUnits: 50_000 })];
    assert.throws(() => computeMissionSpent(entries, "mission-1"), /"success" must be a boolean/);
  });

  test("ADVERSARIAL: a non-boolean 'success' (e.g. the string \"true\") throws", () => {
    const entries = [linkEntry("mission-1", 50_000, "true")];
    assert.throws(() => computeMissionSpent(entries, "mission-1"), /"success" must be a boolean/);
  });

  test("ADVERSARIAL: missing 'amountMinorUnits' throws rather than silently treating it as 0", () => {
    const entries = [fakeEntry(LEDGER_KIND_MISSION_TRANSACTION_LINK, { missionId: "mission-1", success: true })];
    assert.throws(() => computeMissionSpent(entries, "mission-1"), /"amountMinorUnits" must be a positive integer/);
  });

  test("ADVERSARIAL: a NEGATIVE amountMinorUnits throws — silently summing it would inflate this mission's apparent remaining budget", () => {
    const entries = [linkEntry("mission-1", -50_000, true)];
    assert.throws(() => computeMissionSpent(entries, "mission-1"), /"amountMinorUnits" must be a positive integer/);
  });

  test("ADVERSARIAL: a zero amountMinorUnits throws — not a valid spend record", () => {
    const entries = [linkEntry("mission-1", 0, true)];
    assert.throws(() => computeMissionSpent(entries, "mission-1"));
  });

  test("ADVERSARIAL: a non-integer (fractional) amountMinorUnits throws, matching the system-wide integer-minor-units-only convention", () => {
    const entries = [linkEntry("mission-1", 50_000.5, true)];
    assert.throws(() => computeMissionSpent(entries, "mission-1"));
  });

  test("ADVERSARIAL: NaN and Infinity amountMinorUnits both throw rather than silently propagating", () => {
    assert.throws(() => computeMissionSpent([linkEntry("mission-1", NaN, true)], "mission-1"));
    assert.throws(() => computeMissionSpent([linkEntry("mission-1", Infinity, true)], "mission-1"));
  });

  test("ADVERSARIAL: a string amountMinorUnits (e.g. \"50000\") throws rather than being coerced", () => {
    const entries = [linkEntry("mission-1", "50000", true)];
    assert.throws(() => computeMissionSpent(entries, "mission-1"));
  });

  test("a throw happens on the first malformed entry encountered — no partial/silent accumulation of the entries before it is ever returned to the caller", () => {
    const entries = [linkEntry("mission-1", 50_000, true), linkEntry("mission-1", -1, true)];
    assert.throws(() => computeMissionSpent(entries, "mission-1"));
  });
});

describe("remainingMissionBudget", () => {
  test("budget minus spent yields the correct positive remainder", () => {
    assert.equal(remainingMissionBudget({ budgetMinorUnits: 200_000 }, 50_000), 150_000);
  });

  test("spent of 0 returns the full budget", () => {
    assert.equal(remainingMissionBudget({ budgetMinorUnits: 200_000 }, 0), 200_000);
  });

  test("spent exactly equal to budget returns 0", () => {
    assert.equal(remainingMissionBudget({ budgetMinorUnits: 200_000 }, 200_000), 0);
  });

  test("spent exceeding budget returns a negative number — deliberately not clamped to 0, so an already-over-budget mission is never hidden from the caller", () => {
    assert.equal(remainingMissionBudget({ budgetMinorUnits: 200_000 }, 250_000), -50_000);
  });
});
