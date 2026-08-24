import { DatabaseSync } from "node:sqlite";

/**
 * Embedded SQLite is the right store for the isolated, provable core built in this
 * MVP phase: real SQL, real durability (file-backed when given a path), zero external
 * accounts or services to provision. docs/SYSTEM_ARCHITECTURE.md §9 names Postgres as
 * the production target once this becomes a networked service with concurrent writers
 * across processes — swapping the backing store means reimplementing AgentStore and
 * LedgerStore against a different driver, not changing anything above them, since both
 * are exposed here as plain interfaces (see agents.ts, ledger.ts).
 */
export function openDatabase(path: string = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS principals (
      principal_id TEXT PRIMARY KEY,
      api_key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      parent_agent_id TEXT REFERENCES agents(agent_id),
      root_agent_id TEXT NOT NULL,
      delegated_goal TEXT NOT NULL,
      caveats_json TEXT NOT NULL,
      token_base64 TEXT NOT NULL,
      -- The token's own (last-block) Biscuit revocation identifier — the handle the
      -- API layer uses to resolve "which agent does this presented token actually
      -- belong to" without trusting anything the caller claims. See
      -- src/capability/token.ts's getOwnRevocationId and src/api/auth.ts.
      revocation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_principal ON agents(principal_id);
    CREATE INDEX IF NOT EXISTS idx_agents_root ON agents(root_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      signature TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_agent ON ledger_entries(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_principal ON ledger_entries(principal_id);

    -- Backs src/state/revocations.ts's SqliteRevocationStore. Revoking a token's own
    -- (last-block) Biscuit revocation identifier here is what makes revocation survive
    -- a process restart — the in-memory RevocationStore in src/capability/revocation.ts
    -- (still used for isolated capability-module tests) does not.
    CREATE TABLE IF NOT EXISTS revocations (
      revocation_id TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    -- Backs src/api/idempotency.ts's SqliteIdempotencyCache. Without this persisted,
    -- a client retry of an already-executed transaction after a restart would be
    -- indistinguishable from a brand new one and could execute (and settle) twice.
    -- state is 'pending' from the moment a caller atomically claims scoped_key
    -- (a plain INSERT relying on the PRIMARY KEY constraint for atomicity — see
    -- src/api/idempotency.ts's createSqliteIdempotencyCache) until it transitions to
    -- 'completed' with a status/body_json to serve to every caller, including the
    -- original one, from then on. A 'pending' row can also be deleted outright
    -- (never left stuck) if execution throws unexpectedly — see release() there.
    CREATE TABLE IF NOT EXISTS idempotency_records (
      scoped_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      status INTEGER,
      body_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  return db;
}
