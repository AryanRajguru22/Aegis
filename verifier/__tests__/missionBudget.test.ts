import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconstructMissionBudgets } from "../missionBudget.js";
import type { ExportedLedgerEntry } from "../schema.js";

/**
 * Adversarial tests for Proof 2 (verifier/missionBudget.ts) — never imports or calls
 * src/mission/ledger.ts's computeMissionSpent(). Entries here are plain data objects;
 * hash/signature/prevHash fields are filled with placeholder values since this file
 * tests ONLY the mission-reconstruction arithmetic in isolation (verifier/report.ts is
 * what wires this together with Proof 1's result for the overall verdict).
 */

let seqCounter = 1;
function entry(kind: string, data: unknown, agentId = "agent-1", principalId = "p-1"): ExportedLedgerEntry {
  return {
    seq: seqCounter++,
    kind,
    agentId,
    principalId,
    data,
    createdAt: "2026-01-01T00:00:00.000Z",
    prevHash: "0".repeat(64),
    contentHash: "placeholder",
    signature: "placeholder",
  };
}

describe("reconstructMissionBudgets() — Proof 2, adversarial cases", () => {
  test("9. mission budget exactly reached — no overspend, invariant holds", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 1000, success: true }),
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.maximumObservedSpendMinorUnits, 1000);
    assert.equal(result!.overspendMinorUnits, 0);
    assert.equal(result!.budgetInvariantHolds, true);
  });

  test("10. one minor unit over budget — invariant correctly reported as violated", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 1001, success: true }),
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.overspendMinorUnits, 1);
    assert.equal(result!.budgetInvariantHolds, false);
  });

  test("11. multiple missions are reconstructed independently, including one with zero spend", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 500 }),
      entry("mission_created", { missionId: "m-2", budgetMinorUnits: 900 }),
      entry("mission_created", { missionId: "m-3", budgetMinorUnits: 100 }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 200, success: true }),
      entry("mission_transaction_link", { missionId: "m-2", amountMinorUnits: 900, success: true }),
      // m-3 has no transactions at all.
    ];
    const results = reconstructMissionBudgets(entries);
    assert.equal(results.length, 3);
    const byId = Object.fromEntries(results.map((r) => [r.missionId, r]));
    assert.equal(byId["m-1"]!.maximumObservedSpendMinorUnits, 200);
    assert.equal(byId["m-2"]!.maximumObservedSpendMinorUnits, 900);
    assert.equal(byId["m-2"]!.budgetInvariantHolds, true);
    assert.equal(byId["m-3"]!.maximumObservedSpendMinorUnits, 0);
    assert.equal(byId["m-3"]!.evidenceSufficient, true);
  });

  test("12. unrelated entries (other kinds, other missions) are ignored", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("agent_registered", { x: 1 }),
      entry("policy_verdict", { verdict: "allow" }),
      entry("mission_pipeline_outcome", { missionId: "m-1", verdict: "deny" }), // never counted, wrong kind
      entry("mission_transaction_link", { missionId: "other-mission-not-created-here", amountMinorUnits: 99999, success: true }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 300, success: true }),
    ];
    const results = reconstructMissionBudgets(entries);
    const m1 = results.find((r) => r.missionId === "m-1")!;
    assert.equal(m1.maximumObservedSpendMinorUnits, 300, "unrelated kinds and unrelated missionIds must not leak into m-1's total");
  });

  test("13. failed transactions (execution failed after allow) never count toward spend", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("mission_pipeline_outcome", { missionId: "m-1", verdict: "allow", execution: { success: false } }),
      // Note: a real Aegis server never writes mission_transaction_link for a failed execution at all — modeled here as its simple absence.
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.maximumObservedSpendMinorUnits, 0);
  });

  test("14. denied transactions never count toward spend", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("mission_policy_verdict", { missionId: "m-1", allowed: false, reason: "would exceed budget" }),
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.maximumObservedSpendMinorUnits, 0);
  });

  test("15. two genuinely distinct, validly-signed settlements both count (no incorrect deduplication)", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 100, success: true }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 100, success: true }),
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.maximumObservedSpendMinorUnits, 200, "two separate real settlements, even for the same amount, must both count — idempotent replay never produces a second ledger entry at the source, so no special-case deduplication belongs here");
  });

  test("16. a tampered mission_transaction_link's arithmetic is computed correctly in isolation — Proof 1 is what would have already caught the tamper before this ever runs meaningfully", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 100 }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 100000, success: true }), // hash/signature fields are placeholders — Proof 1 would reject this artifact
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.budgetInvariantHolds, false, "the arithmetic itself is still correct and honest — report.ts is responsible for not presenting this as a trustworthy result when integrity failed");
  });

  test("17. missing mission-creation evidence is reported honestly, never guessed", () => {
    const entries = [entry("mission_transaction_link", { missionId: "ghost-mission", amountMinorUnits: 500, success: true })];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.evidenceSufficient, false);
    assert.equal(result!.budgetMinorUnits, null);
    assert.equal(result!.budgetInvariantHolds, null);
    assert.equal(result!.overspendMinorUnits, null);
    assert.match(result!.reason ?? "", /No "mission_created" entry found/);
  });

  test("a malformed mission_transaction_link (non-numeric amount) is skipped, not counted as 0 or crashed on", () => {
    const entries = [
      entry("mission_created", { missionId: "m-1", budgetMinorUnits: 1000 }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: "not-a-number", success: true }),
      entry("mission_transaction_link", { missionId: "m-1", amountMinorUnits: 50, success: true }),
    ];
    const [result] = reconstructMissionBudgets(entries);
    assert.equal(result!.maximumObservedSpendMinorUnits, 50);
  });
});
