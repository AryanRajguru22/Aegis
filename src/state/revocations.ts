import type { DatabaseSync } from "node:sqlite";
import type { RevocationRecord } from "../capability/types.js";
import type { RevocationStore } from "../capability/revocation.js";

/**
 * A persistent implementation of the *same, unchanged* `RevocationStore` interface
 * `src/capability/authorize.ts` already depends on — no capability-module code
 * changes, no change to the cascade property (that comes entirely from
 * `getRevocationIdentifiers` returning the full ancestry chain and `findRevoked`
 * checking all of them, both unchanged). `capability/` still has no SQLite dependency;
 * only this state-layer implementation does, matching the layering already used for
 * AgentStore, PrincipalStore, and LedgerStore.
 *
 * Semantics are deliberately identical to `createInMemoryRevocationStore` (still used
 * for isolated capability-only tests): revoking an already-revoked id overwrites the
 * record (last write wins) rather than erroring, exactly like the in-memory Map's
 * `.set()` behavior it replaces for production use.
 */
export function createSqliteRevocationStore(db: DatabaseSync): RevocationStore {
  const upsertStmt = db.prepare(`
    INSERT INTO revocations (revocation_id, revoked_at, reason)
    VALUES (:revocation_id, :revoked_at, :reason)
    ON CONFLICT(revocation_id) DO UPDATE SET revoked_at = excluded.revoked_at, reason = excluded.reason
  `);
  const getStmt = db.prepare(`SELECT * FROM revocations WHERE revocation_id = :revocation_id`);
  const allStmt = db.prepare(`SELECT * FROM revocations ORDER BY revoked_at ASC`);

  function rowToRecord(row: Record<string, unknown>): RevocationRecord {
    return {
      revocationId: String(row.revocation_id),
      revokedAt: String(row.revoked_at),
      reason: String(row.reason),
    };
  }

  function get(revocationId: string): RevocationRecord | undefined {
    const row = getStmt.get({ revocation_id: revocationId }) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  return {
    revoke(revocationId, reason) {
      const revokedAt = new Date().toISOString();
      upsertStmt.run({ revocation_id: revocationId, revoked_at: revokedAt, reason });
      // Read back rather than construct the record locally, so this store's return
      // value is always exactly what was persisted, not just what was requested.
      const record = get(revocationId);
      if (!record) {
        throw new Error(`Revocation of "${revocationId}" did not persist — this should be unreachable`);
      }
      return record;
    },
    isRevoked(revocationId) {
      return get(revocationId) !== undefined;
    },
    findRevoked(revocationIds) {
      // Mirrors the in-memory store's loop exactly: check ids in the caller's given
      // order and return the first that's revoked, rather than a single IN(...) query
      // whose row order wouldn't reliably preserve "first in input array" semantics.
      for (const id of revocationIds) {
        const record = get(id);
        if (record) return record;
      }
      return undefined;
    },
    list() {
      return (allStmt.all() as Array<Record<string, unknown>>).map(rowToRecord);
    },
  };
}
