import type { Caveats } from "../capability/types.js";
import type { MissionRecord, MissionRecordInput } from "../state/missions.js";
import type { MissionCandidateTransaction, MissionGateResult } from "./types.js";

/**
 * Fast-fail, application-level check that a proposed mission's constraints do not
 * exceed the agent's own capability-token caveats in any dimension — the mission
 * equivalent of src/capability/caveats.ts's validateAttenuation, and deliberately
 * modeled on it: a mission can only narrow what a token already allows, never widen
 * it. This is NOT the security boundary (a mission mints no token and grants no
 * authority by itself — see src/state/missions.ts's module doc comment); it exists so
 * a principal gets a clear, immediate error at mission-creation time instead of
 * silently creating a mission whose constraints could never actually be satisfied
 * (or worse, one a caller might mistakenly believe is *more* permissive than the
 * token underneath it actually is).
 *
 * Three dimensions are checked, matching exactly what a mission is allowed to
 * express (see MissionRecordInput): currency must match (a cumulative budget in a
 * different currency than the token enforces is meaningless, not just "wider" —
 * mirrors validateAttenuation's exact-match rule for currency), allowedCategories (if
 * given; null means "no narrowing beyond the token" for this dimension) must be a
 * subset of the token's categories, and expiresAt must not be later than the token's
 * own expiresAt. There is deliberately no check comparing a mission's cumulative
 * budgetMinorUnits against the token's maxAmountMinorUnits: the token's ceiling is a
 * PER-TRANSACTION cap (see src/capability/types.ts), while a mission's budget is a
 * CUMULATIVE cap meant to be spent across possibly many transactions each already
 * bounded by that per-transaction ceiling — the two are different dimensions, and a
 * mission budget larger than a single transaction's ceiling is normal, not a
 * widening. There is also no rail check: missions do not declare their own rail
 * restriction at all (see MissionCandidateTransaction's doc comment) — rail allowlisting
 * remains entirely the token's own concern, unchanged.
 */
export function validateMissionAgainstToken(
  mission: Pick<MissionRecordInput, "currency" | "allowedCategories" | "expiresAt">,
  tokenCaveats: Caveats
): void {
  if (mission.currency !== tokenCaveats.currency) {
    throw new Error(
      `Mission error: mission currency (${mission.currency}) must match the agent token's currency (${tokenCaveats.currency})`
    );
  }

  if (mission.allowedCategories !== null) {
    const tokenCategories = new Set(tokenCaveats.categories);
    for (const category of mission.allowedCategories) {
      if (!tokenCategories.has(category)) {
        throw new Error(
          `Mission error: mission category "${category}" is not in the agent token's allowed categories (${tokenCaveats.categories.join(", ")})`
        );
      }
    }
  }

  if (new Date(mission.expiresAt).getTime() > new Date(tokenCaveats.expiresAt).getTime()) {
    throw new Error(
      `Mission error: mission expiresAt (${mission.expiresAt}) is later than the agent token's expiresAt (${tokenCaveats.expiresAt})`
    );
  }
}

/**
 * The mission-level deterministic gate — the "deterministic policy" step in
 * docs/SYSTEM_ARCHITECTURE.md's mission flow, evaluated independently of (and, in a
 * later step, entirely before) the existing capability/risk/execution pipeline. Pure,
 * synchronous, and deterministic on purpose, mirroring src/decision/decide.ts's
 * combineRiskSignals: every branch is independently unit-testable without a database,
 * a token, a clock, or a network call, and this function's ordering is exactly the
 * order in which a real caller should evaluate these checks (cheapest/most
 * fundamental first).
 *
 * `spentSoFar` is supplied by the caller, not computed here — in a later step it will
 * be derived from the hash-chained ledger (the same "never a separate mutable source
 * of truth" principle already used for behavioral baselines, see
 * docs/SYSTEM_ARCHITECTURE.md §9), but this function has no opinion about where the
 * number came from.
 *
 * Deliberately checks `mission.status`, not wall-clock time against
 * `mission.expiresAt`: determining that a mission's clock has run out and
 * transitioning it to status "expired" is an inherently impure, time-dependent
 * operation (it needs "now" from somewhere) that belongs to a future orchestration
 * step — e.g. reconciled via MissionStore.close before this gate ever runs — not this
 * pure gate, which must stay independent of the current time to be reliably
 * unit-testable and safely reusable as a pure decision function. A mission whose
 * status has not yet been reconciled to "expired" past its deadline is a known,
 * intentional limitation of this function alone, not of the mission system as a
 * whole once the reconciliation step exists.
 */
export function checkMissionGate(
  mission: Pick<MissionRecord, "status" | "approvedCounterparties" | "allowedCategories" | "budgetMinorUnits">,
  candidateTransaction: MissionCandidateTransaction,
  spentSoFar: number
): MissionGateResult {
  if (mission.status !== "active") {
    return { allowed: false, reason: `Mission is not active (status: "${mission.status}")` };
  }

  if (mission.approvedCounterparties !== null && !mission.approvedCounterparties.includes(candidateTransaction.counterparty)) {
    return {
      allowed: false,
      reason: `Counterparty "${candidateTransaction.counterparty}" is not in this mission's approved counterparties (${mission.approvedCounterparties.join(", ")})`,
    };
  }

  if (mission.allowedCategories !== null && !mission.allowedCategories.includes(candidateTransaction.category)) {
    return {
      allowed: false,
      reason: `Category "${candidateTransaction.category}" is not in this mission's allowed categories (${mission.allowedCategories.join(", ")})`,
    };
  }

  if (spentSoFar + candidateTransaction.amountMinorUnits > mission.budgetMinorUnits) {
    return {
      allowed: false,
      reason: `Transaction would exceed this mission's budget (spent so far: ${spentSoFar}, requested: ${candidateTransaction.amountMinorUnits}, budget: ${mission.budgetMinorUnits})`,
    };
  }

  return { allowed: true };
}
