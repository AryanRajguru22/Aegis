import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Ledger kinds written by the escalation workflow (see src/api/routes/escalations.ts). */
export const LEDGER_KIND_ESCALATION_OPENED = "escalation_opened";
export const LEDGER_KIND_ESCALATION_RESOLVED = "escalation_resolved";

export type EscalationStatus = "pending" | "approved" | "rejected";

/**
 * What happened to an APPROVED escalation after the operator said yes. NULL while it is in
 * flight (and for pending/rejected rows).
 *  - settled        the rail reported success
 *  - failed         the rail was called and reported failure (nothing was spent)
 *  - blocked        authority changed between the decision and the rail (revocation, mission
 *                   closed, ...): the rail was NOT called
 *  - error          an unexpected exception before the rail was reached: the rail was NOT called
 *  - indeterminate  the process died (or bookkeeping failed) after the rail may have been
 *                   reached. The transaction is never re-executed; reconcile with the rail.
 */
export type EscalationOutcome = "settled" | "failed" | "blocked" | "error" | "indeterminate";

export interface EscalationRecord {
  escalationId: string;
  /** The idempotency scoped_key of the /transactions request that was escalated. */
  originKey: string;
  agentId: string;
  principalId: string;
  missionId: string | null;
  counterparty: string;
  /** The goal the risk stage judged the transaction against (the mission's goal when mission-scoped). */
  delegatedGoal: string;
  transaction: Record<string, unknown>;
  /** Why the pipeline escalated. */
  escalationReason: string;
  /** The risk stage's evidence (intent judgment + baseline flags), shown to the operator. */
  risk: unknown;
  status: EscalationStatus;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  outcome: EscalationOutcome | null;
  outcomeDetail: unknown;
  outcomeAt: string | null;
}

export interface EscalationOpenInput {
  originKey: string;
  agentId: string;
  principalId: string;
  missionId: string | null;
  counterparty: string;
  delegatedGoal: string;
  transaction: Record<string, unknown>;
  escalationReason: string;
  risk: unknown;
}

export interface EscalationStore {
  /** Idempotent on originKey: a second open() for the same request returns the existing record. */
  open(input: EscalationOpenInput): EscalationRecord;
  get(escalationId: string): EscalationRecord | undefined;
  listByPrincipal(principalId: string, status?: EscalationStatus): EscalationRecord[];
  /**
   * Atomically moves a PENDING escalation to approved/rejected. Returns true iff THIS call
   * made the transition — a single conditional UPDATE, so of any number of duplicate or
   * conflicting resolutions exactly one wins and every other sees false.
   */
  resolve(escalationId: string, decision: "approved" | "rejected", resolvedBy: string, reason: string): boolean;
  /** Records how an approved escalation ended. Only ever sets a NULL outcome, once. */
  recordOutcome(escalationId: string, outcome: EscalationOutcome, detail?: unknown): boolean;
}

function rowToRecord(row: Record<string, unknown>): EscalationRecord {
  return {
    escalationId: String(row.escalation_id),
    originKey: String(row.origin_key),
    agentId: String(row.agent_id),
    principalId: String(row.principal_id),
    missionId: row.mission_id === null ? null : String(row.mission_id),
    counterparty: String(row.counterparty),
    delegatedGoal: String(row.delegated_goal),
    transaction: JSON.parse(String(row.transaction_json)),
    escalationReason: String(row.escalation_reason),
    risk: row.risk_json === null ? null : JSON.parse(String(row.risk_json)),
    status: String(row.status) as EscalationStatus,
    createdAt: String(row.created_at),
    resolvedBy: row.resolved_by === null ? null : String(row.resolved_by),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    resolutionReason: row.resolution_reason === null ? null : String(row.resolution_reason),
    outcome: row.outcome === null ? null : (String(row.outcome) as EscalationOutcome),
    outcomeDetail: row.outcome_json === null ? null : JSON.parse(String(row.outcome_json)),
    outcomeAt: row.outcome_at === null ? null : String(row.outcome_at),
  };
}

/** The scoped key an approved escalation's budget reservation and rail call are filed under. Distinct from the originating request's key, which is already completed. */
export function escalationExecutionKey(escalationId: string): string {
  return `escalation:${escalationId}`;
}

export function createEscalationStore(db: DatabaseSync): EscalationStore {
  const insertStmt = db.prepare(`
    INSERT INTO escalations (escalation_id, origin_key, agent_id, principal_id, mission_id, counterparty, delegated_goal,
                             transaction_json, escalation_reason, risk_json, status, created_at)
    VALUES (:escalation_id, :origin_key, :agent_id, :principal_id, :mission_id, :counterparty, :delegated_goal,
            :transaction_json, :escalation_reason, :risk_json, 'pending', :created_at)
  `);
  const getStmt = db.prepare(`SELECT * FROM escalations WHERE escalation_id = :id`);
  const getByOriginStmt = db.prepare(`SELECT * FROM escalations WHERE origin_key = :origin_key`);
  const listAllStmt = db.prepare(`SELECT * FROM escalations WHERE principal_id = :principal_id ORDER BY created_at DESC, escalation_id DESC`);
  const listByStatusStmt = db.prepare(
    `SELECT * FROM escalations WHERE principal_id = :principal_id AND status = :status ORDER BY created_at DESC, escalation_id DESC`
  );
  const resolveStmt = db.prepare(`
    UPDATE escalations
    SET status = :status, resolved_by = :resolved_by, resolved_at = :resolved_at, resolution_reason = :reason
    WHERE escalation_id = :id AND status = 'pending'
  `);
  const outcomeStmt = db.prepare(`
    UPDATE escalations
    SET outcome = :outcome, outcome_json = :outcome_json, outcome_at = :outcome_at
    WHERE escalation_id = :id AND status = 'approved' AND outcome IS NULL
  `);
  // An approved escalation whose execution never recorded an outcome belongs to a process
  // that died mid-flight. It must never be executed again.
  const markStaleStmt = db.prepare(`
    UPDATE escalations
    SET outcome = 'indeterminate', outcome_at = :now,
        outcome_json = :detail
    WHERE status = 'approved' AND outcome IS NULL
  `);

  const stale = markStaleStmt.run({
    now: new Date().toISOString(),
    detail: JSON.stringify({ note: "The process stopped after this escalation was approved and before its execution outcome was recorded. It was not re-executed; confirm with the payment rail whether it was reached." }),
  });
  if (Number(stale.changes) > 0) {
    // eslint-disable-next-line no-console
    console.warn(`Escalations: ${stale.changes} approved escalation(s) had no recorded outcome after a restart and were marked "indeterminate" (never re-executed).`);
  }

  function get(escalationId: string): EscalationRecord | undefined {
    const row = getStmt.get({ id: escalationId }) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  return {
    open(input) {
      const existing = getByOriginStmt.get({ origin_key: input.originKey }) as Record<string, unknown> | undefined;
      if (existing) return rowToRecord(existing);
      const escalationId = `esc_${randomUUID()}`;
      insertStmt.run({
        escalation_id: escalationId,
        origin_key: input.originKey,
        agent_id: input.agentId,
        principal_id: input.principalId,
        mission_id: input.missionId,
        counterparty: input.counterparty,
        delegated_goal: input.delegatedGoal,
        transaction_json: JSON.stringify(input.transaction),
        escalation_reason: input.escalationReason,
        risk_json: input.risk === undefined ? null : JSON.stringify(input.risk),
        created_at: new Date().toISOString(),
      });
      return get(escalationId)!;
    },
    get,
    listByPrincipal(principalId, status) {
      const rows = (status ? listByStatusStmt.all({ principal_id: principalId, status }) : listAllStmt.all({ principal_id: principalId })) as Array<Record<string, unknown>>;
      return rows.map(rowToRecord);
    },
    resolve(escalationId, decision, resolvedBy, reason) {
      const result = resolveStmt.run({ id: escalationId, status: decision, resolved_by: resolvedBy, resolved_at: new Date().toISOString(), reason });
      return Number(result.changes) === 1;
    },
    recordOutcome(escalationId, outcome, detail) {
      const result = outcomeStmt.run({
        id: escalationId,
        outcome,
        outcome_json: detail === undefined ? null : JSON.stringify(detail),
        outcome_at: new Date().toISOString(),
      });
      return Number(result.changes) === 1;
    },
  };
}
