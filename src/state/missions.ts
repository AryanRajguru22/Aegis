import type { DatabaseSync } from "node:sqlite";

/** A mission is only ever created/closed by a principal — see docs on MissionStore below. */
export type MissionStatus = "active" | "completed" | "cancelled" | "expired";

export interface MissionRecordInput {
  missionId: string;
  agentId: string;
  principalId: string;
  /** Natural-language statement of what this mission's transactions are for — the same field later passed as `delegatedGoal` to the risk engine for transactions submitted under this mission, sharper than the agent's whole standing delegated goal. Free text, stored as an informational fact only, exactly like AgentRecordInput.delegatedGoal — never used in an enforcement check by this module. */
  goal: string;
  /** Cumulative cap across every transaction executed under this mission, in integer minor units — distinct from a capability token's maxAmountMinorUnits, which is a per-transaction ceiling only (see src/capability/types.ts). Not validated here; this module is a persistence layer, not a policy layer — business-rule validation of a mission against its agent's token caveats belongs to a later step's pure validation function, not this store. */
  budgetMinorUnits: number;
  currency: string;
  /** Optional narrowing of the agent's token categories for transactions under this mission. null means "no narrowing beyond the token" for this dimension. */
  allowedCategories: string[] | null;
  /** Optional counterparty allowlist ("an approved provider") — new policy surface a capability token does not express (counterparty is execution-layer-only there). null means unrestricted. */
  approvedCounterparties: string[] | null;
  expiresAt: string;
}

export interface MissionRecord extends MissionRecordInput {
  /** Atomically-reserved-but-not-yet-settled spend against budgetMinorUnits. Always 0 at creation; mutated only by a later step's atomic reservation primitive, not by this module. */
  reservedMinorUnits: number;
  status: MissionStatus;
  createdAt: string;
}

export interface MissionStore {
  register(input: MissionRecordInput): MissionRecord;
  get(missionId: string): MissionRecord | undefined;
  /** Every mission belonging to a specific agent. */
  listByAgent(agentId: string): MissionRecord[];
  /** Every mission belonging to a specific principal, across all of their agents. */
  listByPrincipal(principalId: string): MissionRecord[];
  /** Transitions a mission out of "active" (completed, cancelled, or expired). Throws if the mission does not exist. No state-machine enforcement here (e.g. re-closing an already-closed mission) — that is a future policy-layer concern, not this persistence layer's. */
  close(missionId: string, status: Exclude<MissionStatus, "active">): MissionRecord;
}

function rowToRecord(row: Record<string, unknown>): MissionRecord {
  return {
    missionId: String(row.mission_id),
    agentId: String(row.agent_id),
    principalId: String(row.principal_id),
    goal: String(row.goal),
    budgetMinorUnits: Number(row.budget_minor_units),
    currency: String(row.currency),
    allowedCategories: row.allowed_categories === null ? null : (JSON.parse(String(row.allowed_categories)) as string[]),
    approvedCounterparties:
      row.approved_counterparties === null ? null : (JSON.parse(String(row.approved_counterparties)) as string[]),
    reservedMinorUnits: Number(row.reserved_minor_units),
    status: String(row.status) as MissionStatus,
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  };
}

/**
 * SQLite-backed MissionStore — a persistence layer only, structurally mirroring
 * src/state/agents.ts. A mission never grants authority itself: it is bounded
 * metadata layered on top of an agent's existing capability token (see
 * src/state/db.ts's schema comment on the `missions` table). This module enforces
 * only referential integrity (the referenced agent exists, and the given
 * principalId genuinely matches that agent's own principalId — the same shape of
 * check src/state/agents.ts already performs for parent/principal consistency at
 * sub-agent registration) — not business rules about budgets, categories, or
 * counterparties, which belong to a later, separate validation step.
 */
export function createMissionStore(db: DatabaseSync): MissionStore {
  const insertStmt = db.prepare(`
    INSERT INTO missions (
      mission_id, agent_id, principal_id, goal, budget_minor_units, currency,
      allowed_categories, approved_counterparties, reserved_minor_units, status, expires_at, created_at
    )
    VALUES (
      :mission_id, :agent_id, :principal_id, :goal, :budget_minor_units, :currency,
      :allowed_categories, :approved_counterparties, 0, 'active', :expires_at, :created_at
    )
  `);
  const getStmt = db.prepare(`SELECT * FROM missions WHERE mission_id = :mission_id`);
  const byAgentStmt = db.prepare(`SELECT * FROM missions WHERE agent_id = :agent_id ORDER BY created_at ASC`);
  const byPrincipalStmt = db.prepare(`SELECT * FROM missions WHERE principal_id = :principal_id ORDER BY created_at ASC`);
  const getAgentPrincipalStmt = db.prepare(`SELECT principal_id FROM agents WHERE agent_id = :agent_id`);
  const updateStatusStmt = db.prepare(`UPDATE missions SET status = :status WHERE mission_id = :mission_id`);

  function get(missionId: string): MissionRecord | undefined {
    const row = getStmt.get({ mission_id: missionId }) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  function register(input: MissionRecordInput): MissionRecord {
    if (get(input.missionId)) {
      throw new Error(`Mission "${input.missionId}" is already registered`);
    }

    const agentRow = getAgentPrincipalStmt.get({ agent_id: input.agentId }) as { principal_id: string } | undefined;
    if (!agentRow) {
      throw new Error(`Cannot register mission "${input.missionId}": agent "${input.agentId}" does not exist`);
    }
    if (agentRow.principal_id !== input.principalId) {
      throw new Error(
        `Cannot register mission "${input.missionId}": principalId "${input.principalId}" does not match agent "${input.agentId}"'s principalId "${agentRow.principal_id}"`
      );
    }

    const createdAt = new Date().toISOString();
    insertStmt.run({
      mission_id: input.missionId,
      agent_id: input.agentId,
      principal_id: input.principalId,
      goal: input.goal,
      budget_minor_units: input.budgetMinorUnits,
      currency: input.currency,
      allowed_categories: input.allowedCategories === null ? null : JSON.stringify(input.allowedCategories),
      approved_counterparties:
        input.approvedCounterparties === null ? null : JSON.stringify(input.approvedCounterparties),
      expires_at: input.expiresAt,
      created_at: createdAt,
    });

    return { ...input, reservedMinorUnits: 0, status: "active", createdAt };
  }

  function close(missionId: string, status: Exclude<MissionStatus, "active">): MissionRecord {
    const existing = get(missionId);
    if (!existing) {
      throw new Error(`Cannot close mission "${missionId}": it does not exist`);
    }
    updateStatusStmt.run({ mission_id: missionId, status });
    return { ...existing, status };
  }

  return {
    register,
    get,
    listByAgent: (agentId) => (byAgentStmt.all({ agent_id: agentId }) as Array<Record<string, unknown>>).map(rowToRecord),
    listByPrincipal: (principalId) =>
      (byPrincipalStmt.all({ principal_id: principalId }) as Array<Record<string, unknown>>).map(rowToRecord),
    close,
  };
}
