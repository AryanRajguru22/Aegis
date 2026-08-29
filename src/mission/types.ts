/**
 * A candidate transaction being evaluated against a mission's own constraints — the
 * subset of fields checkMissionGate actually needs, deliberately narrower than
 * src/capability/types.ts's TransactionRequest (which carries `rail`, irrelevant here
 * since missions don't declare their own rail restriction — that stays entirely
 * within the token's own rails allowlist) and adds `counterparty`, which the
 * capability layer never sees (see src/rails/types.ts's own note that counterparty is
 * execution-layer-only, not part of capability policy). This is exactly the new
 * policy surface a mission introduces: rail is still the token's business, counterparty
 * and cumulative budget are the mission's.
 */
export interface MissionCandidateTransaction {
  amountMinorUnits: number;
  category: string;
  counterparty: string;
}

export interface MissionGateResult {
  allowed: boolean;
  /** Present when allowed is false: which mission-level constraint failed. */
  reason?: string;
}
