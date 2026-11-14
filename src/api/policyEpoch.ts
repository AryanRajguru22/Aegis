import type { LedgerStore } from "../state/ledger.js";

/** Ledger kind and policy name the independent verifier recognises (see verifier/settlementAttribution.ts). Duplicated by value on purpose: the verifier must never import Aegis code. */
export const POLICY_EPOCH_KIND = "policy_epoch";
export const MISSION_BINDING_POLICY = "mission-binding";
/** Owner of system-level entries. Contains "@", which assertValidIdentifier rejects, so no principal can ever register this id and no principal's ledger view can include these entries. */
export const SYSTEM_ACTOR = "@aegis-system";

/**
 * Records, once per ledger, the point from which the mission-binding rule (an agent that
 * has ever been assigned a mission must name one on every spend) is enforced by this
 * code. It is an ordinary signed, hash-chained entry, so it cannot be inserted, moved
 * or removed later without breaking the chain.
 *
 * Idempotent: restarting against a ledger that already carries the marker appends
 * nothing. A ledger that predates this feature gets the marker at its first start under
 * this code, so any earlier unattributed spend is correctly classified as historical by
 * the verifier. Returns true if a marker was appended.
 */
export function ensureMissionBindingEpoch(ledger: Pick<LedgerStore, "append" | "listByPrincipal">): boolean {
  const existing = ledger
    .listByPrincipal(SYSTEM_ACTOR)
    .some((e) => e.kind === POLICY_EPOCH_KIND && (e.data as { policy?: unknown }).policy === MISSION_BINDING_POLICY);
  if (existing) return false;
  ledger.append({
    kind: POLICY_EPOCH_KIND,
    agentId: SYSTEM_ACTOR,
    principalId: SYSTEM_ACTOR,
    data: {
      policy: MISSION_BINDING_POLICY,
      description:
        "From this entry onward the API denies any spend by an agent that has ever been assigned a mission unless it names one of its missions.",
    },
  });
  return true;
}
