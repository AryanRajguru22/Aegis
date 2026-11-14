import type { ExportedLedgerEntry } from "./schema.js";

const KIND_EXECUTION_RESULT = "execution_result";
const KIND_MISSION_CREATED = "mission_created";
const KIND_MISSION_PIPELINE_OUTCOME = "mission_pipeline_outcome";
const KIND_MISSION_TRANSACTION_LINK = "mission_transaction_link";

/**
 * The policy-epoch boundary marker. A ledger entry of this `kind` whose `data.policy`
 * is "mission-binding" declares: "from this entry onward, the sticky mission-required
 * rule (API commit f3dbf21) was being enforced." It is an ordinary signed, hash-chained
 * ledger entry, so it cannot be inserted, moved or removed without breaking Proof 1.
 *
 * The verifier DEFINES this contract; the API does not emit the marker yet (writing it
 * is a separate API follow-up — this patch deliberately does not change the event
 * schema). A ledger without a marker is treated as "epoch not recorded": every
 * mission-binding violation in it is reported as HISTORICAL, because there is nothing
 * in it that can prove the rule was already being enforced when the settlement
 * happened. If several markers exist the earliest wins.
 */
export const KIND_POLICY_EPOCH = "policy_epoch";
export const POLICY_MISSION_BINDING = "mission-binding";

export type SettlementFindingClass = "legacy_violation" | "post_epoch_violation" | "ambiguous";

export interface SettlementFinding {
  seq: number;
  agentId: string;
  classification: SettlementFindingClass;
  reason: string;
}

export interface SettlementAttributionResult {
  /** `execution_result` entries with `success: true` — the only entries that represent money actually moving. */
  successfulSettlements: number;
  /** Matched, by rail reference, to a mission_pipeline_outcome + mission_transaction_link of a mission created for the same agent and principal before the settlement. */
  attributedToMission: number;
  /** Not attributed to any mission, but the agent had no mission_created entry before it — token-only spending the rule allows. */
  permittedMissionless: number;
  /** Attribution could not be established or refuted from the ledger (see `findings`). Never counted as pass or violation. */
  ambiguous: number;
  /** Unattributed settlements by an agent that had already been assigned a mission. `legacy`: not provably after the policy epoch. `postEpoch`: after the marker. */
  bindingViolations: { legacy: number; postEpoch: number };
  /** seq of the policy_epoch marker, or null when the ledger records none. */
  epochMarkerSeq: number | null;
  /** Always null: see `amountNote`. The verifier never reports an amount it cannot derive from trustworthy evidence. */
  amountMinorUnits: null;
  amountNote: string;
  /** mission_transaction_link entries (spend counted against a budget) with no execution_result behind them. Over-states spend, never hides it — informational only. */
  missionLinksWithoutExecution: number;
  /** One row per violation or ambiguous settlement. Attributed and permitted settlements are only counted. */
  findings: SettlementFinding[];
}

const AMOUNT_NOTE =
  "The amount of unattributed settlements cannot be determined from the existing ledger: an execution_result records the rail reference but neither an amount nor a mission, and the policy/decision entries carry no key tying them to a specific settlement.";

interface Link {
  entry: ExportedLedgerEntry;
  missionId: string;
  amountMinorUnits: number;
  consumed: boolean;
}

interface Outcome {
  entry: ExportedLedgerEntry;
  missionId: string;
  amountMinorUnits: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function refKey(entry: ExportedLedgerEntry, reference: string): string {
  return JSON.stringify([entry.agentId, entry.principalId, reference]);
}

/**
 * Settlement attribution (audit finding F1, verifier side). Reconstructs from the raw
 * entries alone — never from any Aegis API or code — which real settlements can be
 * attributed to a mission, and which were made by an agent that was already
 * mission-bound without one.
 *
 * What the ledger actually lets us prove, and what it does not:
 *  - A settlement is an `execution_result` with `success: true`. It carries the rail's
 *    `reference` (unique per settlement for both rails) and the idempotency key, but NO
 *    amount and NO missionId.
 *  - A mission-scoped settlement ALSO writes a `mission_pipeline_outcome` (same rail
 *    reference, missionId, amount) and a `mission_transaction_link` (missionId,
 *    amount) — the entry budgets are computed from. Under concurrency these are not
 *    adjacent to the execution_result, so the join is by (agent, principal, reference),
 *    never by position. The link is then matched to the outcome by mission and amount.
 *  - "Valid mission" means a `mission_created` entry for the same agent AND principal
 *    exists BEFORE the outcome.
 *  - An agent is "mission-bound" at a settlement iff a `mission_created` entry for it
 *    precedes the settlement — the same fact the API derives from the missions table.
 *    A mission-less settlement before that point is permitted, not a finding.
 *  - Anything the evidence cannot decide (duplicate references, an outcome with no
 *    link, an older-format history with no outcome, a mission with no creation entry or
 *    owned by another agent) is "ambiguous" — reported, never silently passed and never
 *    promoted to a proven violation.
 *
 * Callers must only treat the result as meaningful after Proof 1 has passed.
 */
export function analyzeSettlementAttribution(entries: readonly ExportedLedgerEntry[]): SettlementAttributionResult {
  let epochMarkerSeq: number | null = null;
  const missions = new Map<string, { agentId: string; principalId: string; seq: number }>();
  const firstMissionSeqByAgent = new Map<string, number>();
  const settlements: Array<{ entry: ExportedLedgerEntry; reference: string | null }> = [];
  const outcomesByKey = new Map<string, Outcome[]>();
  const links: Link[] = [];

  for (const entry of entries) {
    const data = asRecord(entry.data);

    if (entry.kind === KIND_POLICY_EPOCH) {
      if (epochMarkerSeq === null && data !== null && data.policy === POLICY_MISSION_BINDING) {
        epochMarkerSeq = entry.seq;
      }
      continue;
    }
    if (data === null) continue;

    if (entry.kind === KIND_MISSION_CREATED) {
      if (typeof data.missionId === "string") {
        if (!missions.has(data.missionId)) {
          missions.set(data.missionId, { agentId: entry.agentId, principalId: entry.principalId, seq: entry.seq });
        }
        if (!firstMissionSeqByAgent.has(entry.agentId)) {
          firstMissionSeqByAgent.set(entry.agentId, entry.seq);
        }
      }
      continue;
    }

    if (entry.kind === KIND_EXECUTION_RESULT) {
      if (data.success === true) {
        const reference = typeof data.reference === "string" && data.reference.length > 0 ? data.reference : null;
        settlements.push({ entry, reference });
      }
      continue;
    }

    if (entry.kind === KIND_MISSION_PIPELINE_OUTCOME) {
      const execution = asRecord(data.execution);
      if (
        execution !== null &&
        execution.success === true &&
        typeof execution.reference === "string" &&
        execution.reference.length > 0 &&
        typeof data.missionId === "string" &&
        isPositiveNumber(data.amountMinorUnits)
      ) {
        const key = refKey(entry, execution.reference);
        const list = outcomesByKey.get(key) ?? [];
        list.push({ entry, missionId: data.missionId, amountMinorUnits: data.amountMinorUnits });
        outcomesByKey.set(key, list);
      }
      continue;
    }

    if (entry.kind === KIND_MISSION_TRANSACTION_LINK) {
      if (data.success === true && typeof data.missionId === "string" && isPositiveNumber(data.amountMinorUnits)) {
        links.push({ entry, missionId: data.missionId, amountMinorUnits: data.amountMinorUnits, consumed: false });
      }
    }
  }

  const settlementCountByKey = new Map<string, number>();
  for (const s of settlements) {
    if (s.reference !== null) {
      const key = refKey(s.entry, s.reference);
      settlementCountByKey.set(key, (settlementCountByKey.get(key) ?? 0) + 1);
    }
  }

  const result: SettlementAttributionResult = {
    successfulSettlements: settlements.length,
    attributedToMission: 0,
    permittedMissionless: 0,
    ambiguous: 0,
    bindingViolations: { legacy: 0, postEpoch: 0 },
    epochMarkerSeq,
    amountMinorUnits: null,
    amountNote: AMOUNT_NOTE,
    missionLinksWithoutExecution: 0,
    findings: [],
  };

  const ambiguous = (entry: ExportedLedgerEntry, reason: string): void => {
    result.ambiguous += 1;
    result.findings.push({ seq: entry.seq, agentId: entry.agentId, classification: "ambiguous", reason });
  };

  const takeLink = (entry: ExportedLedgerEntry, match: (link: Link) => boolean, afterSeq: number): Link | null => {
    for (const link of links) {
      if (!link.consumed && link.entry.seq > afterSeq && link.entry.agentId === entry.agentId && link.entry.principalId === entry.principalId && match(link)) {
        link.consumed = true;
        return link;
      }
    }
    return null;
  };

  // Phase 1: settlements with identity evidence (a unique rail reference that a
  // pipeline outcome also carries).
  const deferred: Array<{ entry: ExportedLedgerEntry }> = [];
  for (const { entry, reference } of settlements) {
    if (reference === null) {
      deferred.push({ entry });
      continue;
    }
    const key = refKey(entry, reference);
    const outcomes = outcomesByKey.get(key) ?? [];
    if ((settlementCountByKey.get(key) ?? 0) > 1 || outcomes.length > 1) {
      ambiguous(entry, `Rail reference "${reference}" is not unique among this agent's settlements/outcomes — identity cannot be established`);
      continue;
    }
    const outcome = outcomes[0];
    if (outcome === undefined) {
      deferred.push({ entry });
      continue;
    }
    if (outcome.entry.seq < entry.seq) {
      ambiguous(entry, `A mission_pipeline_outcome (entry #${outcome.entry.seq}) carries this settlement's rail reference but precedes the settlement`);
      continue;
    }
    const link = takeLink(entry, (l) => l.missionId === outcome.missionId && l.amountMinorUnits === outcome.amountMinorUnits, outcome.entry.seq);
    if (link === null) {
      ambiguous(entry, `Settled under mission "${outcome.missionId}" per its pipeline outcome (entry #${outcome.entry.seq}) but no mission_transaction_link exists — this spend may be missing from the mission budget proof`);
      continue;
    }
    const mission = missions.get(outcome.missionId);
    if (mission === undefined) {
      ambiguous(entry, `Attributed to mission "${outcome.missionId}", which has no mission_created entry in this ledger`);
    } else if (mission.agentId !== entry.agentId || mission.principalId !== entry.principalId) {
      ambiguous(entry, `Attributed to mission "${outcome.missionId}", which was created for a different agent or principal`);
    } else if (mission.seq > outcome.entry.seq) {
      ambiguous(entry, `Attributed to mission "${outcome.missionId}", whose mission_created entry (#${mission.seq}) comes after the settlement`);
    } else {
      result.attributedToMission += 1;
    }
  }

  // Phase 2: settlements with no identity evidence. Run after phase 1 so links that
  // belong to identified settlements are already consumed.
  for (const { entry } of deferred) {
    const link = takeLink(entry, () => true, entry.seq);
    if (link !== null) {
      ambiguous(entry, `No pipeline outcome carries this settlement's rail reference, but a later mission_transaction_link for mission "${link.missionId}" exists (entry #${link.entry.seq}) — attribution rests on position alone`);
      continue;
    }
    const firstMissionSeq = firstMissionSeqByAgent.get(entry.agentId);
    if (firstMissionSeq === undefined || firstMissionSeq > entry.seq) {
      result.permittedMissionless += 1;
      continue;
    }
    const postEpoch = epochMarkerSeq !== null && entry.seq > epochMarkerSeq;
    if (postEpoch) {
      result.bindingViolations.postEpoch += 1;
    } else {
      result.bindingViolations.legacy += 1;
    }
    result.findings.push({
      seq: entry.seq,
      agentId: entry.agentId,
      classification: postEpoch ? "post_epoch_violation" : "legacy_violation",
      reason: `Settlement by an agent already assigned a mission (first at entry #${firstMissionSeq}) with no mission attribution${
        postEpoch ? ` after the mission-binding policy epoch (entry #${epochMarkerSeq})` : epochMarkerSeq === null ? " (no policy epoch recorded in this ledger)" : ` before the mission-binding policy epoch (entry #${epochMarkerSeq})`
      }`,
    });
  }

  result.missionLinksWithoutExecution = links.filter((l) => !l.consumed).length;
  result.findings.sort((a, b) => a.seq - b.seq);
  return result;
}
