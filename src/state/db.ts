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

    -- Backs src/state/missions.ts's MissionStore. A mission is bounded metadata layered
    -- on top of an agent's existing capability token (goal + cumulative budget +
    -- optional narrower category/counterparty allowlists) — it never grants authority
    -- itself; the token remains the sole cryptographic boundary. budget_minor_units is
    -- the cumulative cap the mission was created with; reserved_minor_units tracks
    -- atomically-reserved-but-not-yet-settled spend (added in a later step, once
    -- transaction submission is wired up) so concurrent candidate transactions can't
    -- both pass a stale "remaining budget" read past the cap. allowed_categories and
    -- approved_counterparties are nullable JSON arrays: null means "no narrowing beyond
    -- the agent's own token" for that dimension.
    CREATE TABLE IF NOT EXISTS missions (
      mission_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      principal_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      budget_minor_units INTEGER NOT NULL,
      currency TEXT NOT NULL,
      allowed_categories TEXT,
      approved_counterparties TEXT,
      reserved_minor_units INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_missions_agent ON missions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_missions_principal ON missions(principal_id);

    -- Backs src/mission/reservation.ts's crash-recovery reconciliation. Every
    -- successful reserve() writes a ticket here, in the SAME SQLite transaction as the
    -- reserved_minor_units increment, keyed by the caller's idempotency scoped_key —
    -- so a ticket exists if and only if a reservation is currently outstanding for
    -- that specific transaction attempt. release() deletes its ticket in the same
    -- transaction as the decrement. If a process dies between reserve() and the
    -- request's eventual resolution, this ticket is what lets a later process, on
    -- restart, find every reservation left in limbo and reconcile it against that same
    -- scoped_key's already-durable idempotency_records state (see
    -- reconcileMissionReservations) — without ever needing to guess.
    CREATE TABLE IF NOT EXISTS mission_reservation_tickets (
      scoped_key TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      amount_minor_units INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
