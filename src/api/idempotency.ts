import type { DatabaseSync } from "node:sqlite";
import { sha256Hex, stableStringify } from "../state/crypto.js";

export interface IdempotencyRecord {
  requestHash: string;
  status: number;
  body: unknown;
}

export type ClaimOutcome =
  | { kind: "claimed" }
  | { kind: "hash_mismatch" }
  | { kind: "pending" }
  | { kind: "completed"; record: IdempotencyRecord }
  /**
   * A claim that was left "pending" by a process that died (crash, kill, power loss)
   * somewhere between claiming the key and either completing or releasing it — found
   * and permanently retired at startup (see reconciliation in
   * createSqliteIdempotencyCache below). It is deliberately terminal: nothing may ever
   * claim, complete, or release an orphaned key again, because we cannot tell whether
   * the dead process's execution had already reached (and settled on) a rail before it
   * died. See routes/transactions.ts for how this surfaces to a caller.
   */
  | { kind: "orphaned" };

/**
 * POST /transactions requires an Idempotency-Key header (see routes/transactions.ts)
 * — this is what makes a client-side retry of an in-flight or already-completed
 * request safe rather than a second, distinct transaction attempt. Modeled on how
 * Stripe's API requires idempotency keys for exactly the same reason: this endpoint
 * can move money, and a retry — network-level, genuinely concurrent, or after a
 * server restart — must never be indistinguishable from an intentional second charge.
 *
 * `tryClaim` is the atomic primitive that makes this safe under real concurrency, not
 * just sequential replay: exactly one caller across any number of simultaneous
 * attempts for the same scopedKey ever receives {kind:"claimed"}, because both
 * implementations below make "does an entry already exist" and "create one" a single,
 * uninterruptible operation (a native `INSERT` with a `scoped_key` PRIMARY KEY for
 * SQLite; a plain synchronous Map check-and-set for the in-memory version, which is
 * equally atomic since nothing `await`s between the check and the write). Every other
 * concurrent caller sees {kind:"pending"} (something is executing right now) or
 * {kind:"completed", record} (it already finished) and must never execute the
 * transaction itself.
 *
 * The claimant is responsible for calling exactly one of `complete()` (normal
 * outcome — allow, deny, escalate, or a settled/failed execution are all normal,
 * cacheable outcomes) or `release()` (only for a genuinely unexpected thrown error
 * from execution itself, so the pending record does not stay stuck forever and a
 * later attempt can claim the key again). Critically, `release()` must never be called
 * once execution has genuinely completed — see routes/transactions.ts's separate
 * handling of "executeTransaction threw" versus "executeTransaction succeeded but
 * complete() itself failed to persist the result."
 */
export interface IdempotencyCache {
  tryClaim(scopedKey: string, requestHash: string): ClaimOutcome;
  complete(scopedKey: string, record: IdempotencyRecord): void;
  release(scopedKey: string): void;
  hashRequest(body: unknown): string;
}

interface InMemoryEntry {
  requestHash: string;
  state: "pending" | "completed";
  record?: IdempotencyRecord;
}

/**
 * Nothing to reconcile here: an in-memory Map holds no state across a restart at all,
 * so no "orphaned" row can ever exist by construction — {kind:"orphaned"} is part of
 * this implementation's type surface (callers must handle it uniformly across both
 * backends) but this implementation itself never produces it.
 */
export function createInMemoryIdempotencyCache(): IdempotencyCache {
  const store = new Map<string, InMemoryEntry>();

  return {
    tryClaim(scopedKey, requestHash) {
      const existing = store.get(scopedKey);
      if (!existing) {
        store.set(scopedKey, { requestHash, state: "pending" });
        return { kind: "claimed" };
      }
      if (existing.requestHash !== requestHash) {
        return { kind: "hash_mismatch" };
      }
      if (existing.state === "pending") {
        return { kind: "pending" };
      }
      return { kind: "completed", record: existing.record! };
    },
    complete(scopedKey, record) {
      const existing = store.get(scopedKey);
      if (!existing || existing.state !== "pending") {
        throw new Error(`complete() called for "${scopedKey}" with no matching pending claim`);
      }
      existing.state = "completed";
      existing.record = record;
    },
    release(scopedKey) {
      const existing = store.get(scopedKey);
      if (existing && existing.state === "pending") {
        store.delete(scopedKey);
      }
    },
    hashRequest: (body) => sha256Hex(stableStringify(body)),
  };
}

function isConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    /constraint/i.test(String((error as { message?: unknown }).message ?? ""))
  );
}

/**
 * A persistent implementation backed by the same SQLite file as everything else in
 * `src/state` — see `idempotency_records` in `src/state/db.ts`. `tryClaim`'s atomicity
 * comes directly from SQLite's own PRIMARY KEY constraint: the INSERT either succeeds
 * (no prior row — this caller now owns the pending claim) or throws a constraint
 * violation (a row already exists) as a single, uninterruptible native operation —
 * there is no `await` between "check" and "write" for a concurrent caller to land in.
 *
 * Construction performs one-time reconciliation of orphaned claims (see the module
 * doc comment): any row still 'pending' at this moment predates this process, since a
 * live process could not yet have created one. It can only exist because a previous
 * process died between claiming and resolving it, so every such row is moved to the
 * terminal 'orphaned' state rather than left claimable or silently deleted.
 */
export function createSqliteIdempotencyCache(db: DatabaseSync): IdempotencyCache {
  const reconciled = db.prepare(`UPDATE idempotency_records SET state = 'orphaned' WHERE state = 'pending'`).run();
  if (reconciled.changes > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `Idempotency reconciliation: ${reconciled.changes} claim(s) were left "pending" by a previous process (crash/restart) and have been marked "orphaned". The corresponding Idempotency-Key(s) can never be reused — callers will get a clear error and must retry with a new key.`
    );
  }

  const insertPendingStmt = db.prepare(`
    INSERT INTO idempotency_records (scoped_key, request_hash, state, created_at)
    VALUES (:scoped_key, :request_hash, 'pending', :created_at)
  `);
  const getStmt = db.prepare(`SELECT * FROM idempotency_records WHERE scoped_key = :scoped_key`);
  const completeStmt = db.prepare(`
    UPDATE idempotency_records
    SET state = 'completed', status = :status, body_json = :body_json, completed_at = :completed_at
    WHERE scoped_key = :scoped_key AND state = 'pending'
  `);
  const releaseStmt = db.prepare(`DELETE FROM idempotency_records WHERE scoped_key = :scoped_key AND state = 'pending'`);

  return {
    tryClaim(scopedKey, requestHash) {
      try {
        insertPendingStmt.run({ scoped_key: scopedKey, request_hash: requestHash, created_at: new Date().toISOString() });
        return { kind: "claimed" };
      } catch (error) {
        if (!isConstraintViolation(error)) throw error;

        const row = getStmt.get({ scoped_key: scopedKey }) as Record<string, unknown> | undefined;
        if (!row) throw error; // conflict but no row found — genuinely unexpected; don't mask it as a normal claim outcome

        if (row.state === "orphaned") {
          return { kind: "orphaned" };
        }
        if (String(row.request_hash) !== requestHash) {
          return { kind: "hash_mismatch" };
        }
        if (row.state === "pending") {
          return { kind: "pending" };
        }
        return {
          kind: "completed",
          record: {
            requestHash: String(row.request_hash),
            status: Number(row.status),
            body: JSON.parse(String(row.body_json)),
          },
        };
      }
    },
    complete(scopedKey, record) {
      const result = completeStmt.run({
        scoped_key: scopedKey,
        status: record.status,
        body_json: JSON.stringify(record.body),
        completed_at: new Date().toISOString(),
      });
      if (result.changes === 0) {
        throw new Error(`complete() called for "${scopedKey}" with no matching pending claim`);
      }
    },
    release(scopedKey) {
      releaseStmt.run({ scoped_key: scopedKey });
    },
    hashRequest: (body) => sha256Hex(stableStringify(body)),
  };
}
