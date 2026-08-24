import type { DatabaseSync } from "node:sqlite";

export interface AgentRecordInput {
  agentId: string;
  principalId: string;
  /** null for a root agent; the parent's agentId for a sub-agent. */
  parentAgentId: string | null;
  delegatedGoal: string;
  /** Stored as opaque JSON — this module deliberately does not depend on src/capability's Caveats type, so the state layer can be tested and evolve independently of the token layer. */
  caveats: Record<string, unknown>;
  tokenBase64: string;
  /** The token's own revocation id (src/capability's getOwnRevocationId) — the API layer's identity-resolution key. Must be unique across all agents by construction (each Biscuit block's revocation id is cryptographically unique). */
  revocationId: string;
}

export interface AgentRecord extends AgentRecordInput {
  rootAgentId: string;
  createdAt: string;
}

export interface AgentStore {
  register(input: AgentRecordInput): AgentRecord;
  get(agentId: string): AgentRecord | undefined;
  /** Resolves a presented token back to the agent it was issued for — see src/api/auth.ts. */
  getByRevocationId(revocationId: string): AgentRecord | undefined;
  listChildren(agentId: string): AgentRecord[];
  /** Every agent sharing the given root, including the root itself — the whole delegation tree. */
  listTree(rootAgentId: string): AgentRecord[];
  listByPrincipal(principalId: string): AgentRecord[];
}

function rowToRecord(row: Record<string, unknown>): AgentRecord {
  return {
    agentId: String(row.agent_id),
    principalId: String(row.principal_id),
    parentAgentId: row.parent_agent_id === null ? null : String(row.parent_agent_id),
    rootAgentId: String(row.root_agent_id),
    delegatedGoal: String(row.delegated_goal),
    caveats: JSON.parse(String(row.caveats_json)),
    tokenBase64: String(row.token_base64),
    revocationId: String(row.revocation_id),
    createdAt: String(row.created_at),
  };
}

export function createAgentStore(db: DatabaseSync): AgentStore {
  const insertStmt = db.prepare(`
    INSERT INTO agents (agent_id, principal_id, parent_agent_id, root_agent_id, delegated_goal, caveats_json, token_base64, revocation_id, created_at)
    VALUES (:agent_id, :principal_id, :parent_agent_id, :root_agent_id, :delegated_goal, :caveats_json, :token_base64, :revocation_id, :created_at)
  `);
  const getStmt = db.prepare(`SELECT * FROM agents WHERE agent_id = :agent_id`);
  const getByRevocationIdStmt = db.prepare(`SELECT * FROM agents WHERE revocation_id = :revocation_id`);
  const childrenStmt = db.prepare(`SELECT * FROM agents WHERE parent_agent_id = :parent_agent_id ORDER BY created_at ASC`);
  const treeStmt = db.prepare(`SELECT * FROM agents WHERE root_agent_id = :root_agent_id ORDER BY created_at ASC`);
  const byPrincipalStmt = db.prepare(`SELECT * FROM agents WHERE principal_id = :principal_id ORDER BY created_at ASC`);

  function get(agentId: string): AgentRecord | undefined {
    const row = getStmt.get({ agent_id: agentId }) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  function getByRevocationId(revocationId: string): AgentRecord | undefined {
    const row = getByRevocationIdStmt.get({ revocation_id: revocationId }) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  function register(input: AgentRecordInput): AgentRecord {
    if (get(input.agentId)) {
      throw new Error(`Agent "${input.agentId}" is already registered`);
    }

    let rootAgentId: string;
    if (input.parentAgentId === null) {
      rootAgentId = input.agentId;
    } else {
      const parent = get(input.parentAgentId);
      if (!parent) {
        throw new Error(`Cannot register "${input.agentId}": parent agent "${input.parentAgentId}" does not exist`);
      }
      if (parent.principalId !== input.principalId) {
        throw new Error(
          `Cannot register "${input.agentId}": principalId "${input.principalId}" does not match parent's principalId "${parent.principalId}"`
        );
      }
      rootAgentId = parent.rootAgentId;
    }

    const createdAt = new Date().toISOString();
    insertStmt.run({
      agent_id: input.agentId,
      principal_id: input.principalId,
      parent_agent_id: input.parentAgentId,
      root_agent_id: rootAgentId,
      delegated_goal: input.delegatedGoal,
      caveats_json: JSON.stringify(input.caveats),
      token_base64: input.tokenBase64,
      revocation_id: input.revocationId,
      created_at: createdAt,
    });

    return { ...input, rootAgentId, createdAt };
  }

  return {
    register,
    get,
    getByRevocationId,
    listChildren: (agentId) => (childrenStmt.all({ parent_agent_id: agentId }) as Array<Record<string, unknown>>).map(rowToRecord),
    listTree: (rootAgentId) => (treeStmt.all({ root_agent_id: rootAgentId }) as Array<Record<string, unknown>>).map(rowToRecord),
    listByPrincipal: (principalId) =>
      (byPrincipalStmt.all({ principal_id: principalId }) as Array<Record<string, unknown>>).map(rowToRecord),
  };
}
