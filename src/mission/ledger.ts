import type { LedgerEntry } from "../state/ledger.js";
import type { MissionRecord } from "../state/missions.js";

/**
 * The ledger `kind` a mission-linked transaction outcome is recorded under. Written,
 * in a later step, by route-layer orchestration AFTER the existing, unmodified
 * decision/execution pipeline (src/decision, src/execution) returns its result — this
 * module never writes ledger entries and calls no ledger store itself. It reads and
 * aggregates an already-fetched array of LedgerEntry, exactly the way
 * src/risk/baseline.ts's scoreDeviation takes a plain `history` array rather than a
 * live store reference, so it stays pure, synchronous, and testable without a
 * database.
 */
export const LEDGER_KIND_MISSION_TRANSACTION_LINK = "mission_transaction_link";

/**
 * The ledger `kind` a mission-level pre-pipeline denial is recorded under — written
 * by route-layer orchestration when checkMissionGate (or the atomic reservation
 * itself) rejects a candidate transaction BEFORE the existing capability/decision
 * pipeline ever runs. Kept distinct from LEDGER_KIND_MISSION_TRANSACTION_LINK: this
 * kind never represents a settlement and must never be counted by
 * computeMissionSpent (which only ever reads LEDGER_KIND_MISSION_TRANSACTION_LINK
 * entries) — it exists purely so a mission-level denial is visible in the same
 * unified, hash-chained ledger as every other Aegis decision, not silently dropped.
 */
export const LEDGER_KIND_MISSION_POLICY_VERDICT = "mission_policy_verdict";

/**
 * The ledger `kind` recording the FULL outcome of a mission-scoped transaction attempt
 * that reached the real capability/decision/risk/execution pipeline — written by
 * routes/transactions.ts immediately after executeTransaction returns, for every
 * verdict (allow, deny, escalate) and every execution outcome (settled, failed, not
 * attempted). This is what makes a mission's history complete: mission_policy_verdict
 * only ever covers a denial from the mission gate itself, BEFORE the real pipeline
 * runs; mission_transaction_link only ever covers a genuine successful settlement.
 * Neither covers "passed the mission gate, then was denied by capability/policy,
 * escalated, or failed to execute" — this kind does, without needing any change to
 * either of those two existing kinds or to what computeMissionSpent reads (only
 * LEDGER_KIND_MISSION_TRANSACTION_LINK — this kind is invisible to it and to the
 * atomic reservation's own SQL, by construction, so it can never affect budget
 * accounting).
 *
 * Deliberately self-contained: `data` carries the same `policy`/`risk`/`execution`
 * shapes decide.ts/executeTransaction already produce and the API already returns to
 * the caller, verbatim — not a pointer requiring the reader to go find nearby ledger
 * entries and guess which ones belong to this attempt. The write order after a "deny"
 * or "escalate" verdict has no execution_result entry at all (executeTransaction never
 * reaches the rail), so a second offset-correlated entry (mirroring how
 * mission_transaction_link is today) would need outcome-dependent offsets — a source
 * of exactly the fragility a self-contained entry avoids entirely.
 */
export const LEDGER_KIND_MISSION_PIPELINE_OUTCOME = "mission_pipeline_outcome";

/** The `data` shape a mission_pipeline_outcome entry's payload must have. */
export interface MissionPipelineOutcomeData {
  missionId: string;
  amountMinorUnits: number;
  category: string;
  counterparty: string;
  verdict: "allow" | "deny" | "escalate";
  reason: string;
  policy: { allowed: boolean; reason?: string };
  /** Absent when policy already denied — the risk engine never runs on a policy-denied transaction (see decide.ts). */
  risk?: { intentJudgment: { verdict: string; rationale: string }; baselineFlags: Array<{ code: string; detail: string }> };
  /** Present only when verdict === "allow" — see execution/executeTransaction.ts's own contract. */
  execution?: { success: boolean; rail: string; reference: string; error?: string };
}

/** The `data` shape a mission_transaction_link entry's payload must have. */
export interface MissionTransactionLinkData {
  missionId: string;
  amountMinorUnits: number;
  /** Only a successful settlement consumes a mission's budget — see computeMissionSpent. */
  success: boolean;
}

/**
 * Sums the minor-unit amount of every SUCCESSFUL mission_transaction_link entry
 * belonging to `missionId` — the mission's cumulative spend, derived entirely from
 * the ledger rather than tracked as a separate mutable counter (the same principle
 * docs/SYSTEM_ARCHITECTURE.md §9 already applies to behavioral baselines: never a
 * second source of truth that could disagree with what actually happened). A
 * transaction whose execution failed (`success: false`) never consumed real budget
 * and correctly does not count here.
 *
 * Fails closed on any entry that claims to belong to this mission but has a
 * malformed payload (a missing/non-boolean `success`, or an `amountMinorUnits` that
 * isn't a positive finite integer) by throwing, rather than silently skipping it
 * (which would UNDER-count spend and let a mission appear to have more remaining
 * budget than it safely should) or coercing/guessing a value (a negative or
 * non-numeric amount could otherwise be used to inflate apparent remaining budget).
 * This mirrors src/decision/decide.ts's safeJudge: any ambiguity collapses to a hard
 * failure the caller must treat as "cannot safely compute this right now", never as
 * an implicit zero or an implicit allow. Entries for a *different* missionId are
 * never validated or thrown on, even if malformed — only entries actually claiming to
 * belong to the mission being queried can affect (or block) its own computation, so a
 * corrupted/malicious entry elsewhere in the ledger can't deny service to an unrelated
 * mission's budget check.
 *
 * Entries of any other `kind` are ignored outright, even if their `data` happens to
 * superficially resemble this shape — only LEDGER_KIND_MISSION_TRANSACTION_LINK
 * entries are ever considered.
 */
export function computeMissionSpent(ledgerEntries: readonly LedgerEntry[], missionId: string): number {
  let spent = 0;

  for (const entry of ledgerEntries) {
    if (entry.kind !== LEDGER_KIND_MISSION_TRANSACTION_LINK) continue;

    const data = entry.data as Record<string, unknown>;
    if (data.missionId !== missionId) continue;

    if (typeof data.success !== "boolean") {
      throw new Error(
        `Malformed mission_transaction_link entry (seq ${entry.seq}) for mission "${missionId}": "success" must be a boolean, got ${JSON.stringify(data.success)}`
      );
    }
    if (
      typeof data.amountMinorUnits !== "number" ||
      !Number.isFinite(data.amountMinorUnits) ||
      !Number.isInteger(data.amountMinorUnits) ||
      data.amountMinorUnits <= 0
    ) {
      throw new Error(
        `Malformed mission_transaction_link entry (seq ${entry.seq}) for mission "${missionId}": "amountMinorUnits" must be a positive integer, got ${JSON.stringify(data.amountMinorUnits)}`
      );
    }

    if (data.success) {
      spent += data.amountMinorUnits;
    }
  }

  return spent;
}

/**
 * The mission's budget minus what it has actually spent so far. Deliberately not
 * clamped at zero: a negative result is meaningful information (this mission is
 * already over budget, which should never happen once the atomic reservation
 * primitive from a later step is wired in, but is honest to surface rather than hide
 * if it ever does) — a caller displaying this to a principal or feeding it into
 * checkMissionGate's `spentSoFar` comparison should see the true value, not one
 * silently floored to look reassuring.
 */
export function remainingMissionBudget(mission: Pick<MissionRecord, "budgetMinorUnits">, spent: number): number {
  return mission.budgetMinorUnits - spent;
}
