import type { ExportedLedgerEntry } from "./schema.js";

const KIND_MISSION_CREATED = "mission_created";
const KIND_MISSION_TRANSACTION_LINK = "mission_transaction_link";

export interface MissionBudgetResult {
  missionId: string;
  /** null when evidenceSufficient is false — never a guessed value. */
  budgetMinorUnits: number | null;
  maximumObservedSpendMinorUnits: number;
  /** null when evidenceSufficient is false. */
  overspendMinorUnits: number | null;
  /** null (not true/false) when evidenceSufficient is false — a missing budget is neither a proven pass nor a proven fail. */
  budgetInvariantHolds: boolean | null;
  evidenceSufficient: boolean;
  reason?: string;
}

interface MissionCreatedData {
  missionId: unknown;
  budgetMinorUnits: unknown;
}

interface MissionTransactionLinkData {
  missionId: unknown;
  amountMinorUnits: unknown;
  success: unknown;
}

/**
 * Proof 2, implemented completely independently of src/mission/ledger.ts's
 * computeMissionSpent() — this function is never called by, and never calls, that
 * function. It reconstructs mission budgets and settled spend from scratch, reading
 * only two ledger `kind`s:
 *
 *  - "mission_created": the mission's budget, as recorded at creation time (the ONLY
 *    place a mission's budget is ever written to the ledger — see
 *    src/api/routes/missions.ts). If a `mission_transaction_link` entry references a
 *    missionId with NO matching "mission_created" entry anywhere in the supplied
 *    entries, that mission's budget is reported as evidenceSufficient: false — never
 *    guessed as 0, Infinity, or any other value.
 *  - "mission_transaction_link" with `success: true`: the only kind that represents a
 *    genuine settlement (see src/mission/ledger.ts's own doc comment — denied,
 *    escalated, and execution-failed attempts never produce this entry at all).
 *    Cumulative spend is the running sum of these amounts; because it is only ever
 *    added to, never subtracted, the maximum observed value is simply the final sum.
 *
 * This function does not itself decide whether the RESULT is trustworthy — see
 * verifier/report.ts, which only treats these results as meaningful once
 * verifyIntegrity() has already passed. Called on a ledger that failed integrity, this
 * function would still run and produce arithmetically correct output, but that output
 * is not a proof of anything, since the underlying data could not be trusted.
 */
export function reconstructMissionBudgets(entries: readonly ExportedLedgerEntry[]): MissionBudgetResult[] {
  const budgets = new Map<string, number>();
  const spendByMission = new Map<string, number>();
  const referencedMissionIds = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === KIND_MISSION_CREATED) {
      const data = entry.data as Partial<MissionCreatedData>;
      if (typeof data.missionId === "string" && typeof data.budgetMinorUnits === "number" && Number.isFinite(data.budgetMinorUnits)) {
        // A missionId should only ever be created once; if it somehow appears twice in
        // valid, integrity-passing data, the first-seen (chronologically earliest, since
        // entries are walked in ledger order) creation is authoritative — mirroring
        // MissionStore.register()'s own "already registered" rejection, which makes a
        // second creation for the same missionId structurally impossible in a real,
        // unmodified Aegis ledger.
        if (!budgets.has(data.missionId)) {
          budgets.set(data.missionId, data.budgetMinorUnits);
        }
      }
      continue;
    }

    if (entry.kind === KIND_MISSION_TRANSACTION_LINK) {
      const data = entry.data as Partial<MissionTransactionLinkData>;
      if (typeof data.missionId !== "string") continue;
      referencedMissionIds.add(data.missionId);

      if (data.success !== true) continue; // only a genuine settlement counts
      if (typeof data.amountMinorUnits !== "number" || !Number.isFinite(data.amountMinorUnits) || data.amountMinorUnits <= 0) {
        continue; // malformed amount on an otherwise-integrity-passing entry is not something to guess at; simply cannot count it
      }
      spendByMission.set(data.missionId, (spendByMission.get(data.missionId) ?? 0) + data.amountMinorUnits);
    }
  }

  // Every mission that was ever CREATED must appear in the result, even with zero
  // observed spend, plus every mission REFERENCED by a transaction link even if its
  // creation evidence is missing (an insufficient-evidence case, reported honestly).
  const allMissionIds = new Set<string>([...budgets.keys(), ...referencedMissionIds]);

  const results: MissionBudgetResult[] = [];
  for (const missionId of allMissionIds) {
    const budget = budgets.get(missionId);
    const spend = spendByMission.get(missionId) ?? 0;

    if (budget === undefined) {
      results.push({
        missionId,
        budgetMinorUnits: null,
        maximumObservedSpendMinorUnits: spend,
        overspendMinorUnits: null,
        budgetInvariantHolds: null,
        evidenceSufficient: false,
        reason: `No "mission_created" entry found for missionId "${missionId}" in the supplied artifact — cannot independently determine its budget`,
      });
      continue;
    }

    const overspend = Math.max(0, spend - budget);
    results.push({
      missionId,
      budgetMinorUnits: budget,
      maximumObservedSpendMinorUnits: spend,
      overspendMinorUnits: overspend,
      budgetInvariantHolds: spend <= budget,
      evidenceSufficient: true,
    });
  }

  results.sort((a, b) => a.missionId.localeCompare(b.missionId));
  return results;
}
