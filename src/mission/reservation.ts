import type { DatabaseSync } from "node:sqlite";
import { LEDGER_KIND_MISSION_TRANSACTION_LINK } from "./ledger.js";
import type { MissionStatus } from "../state/missions.js";

export type ReservationOutcome =
  | { kind: "reserved" }
  | { kind: "mission_not_found" }
  | { kind: "mission_not_active"; status: MissionStatus }
  | { kind: "insufficient_budget" };

/**
 * The atomic counterpart to src/mission/policy.ts's checkMissionGate: where
 * checkMissionGate is a pure, synchronous decision function given a `spentSoFar` it
 * trusts the caller to have computed correctly, this store is what actually makes a
 * concurrency-safe claim on a mission's budget BEFORE the existing capability →
 * decision → risk → execution pipeline runs — see the module doc comment on
 * `createSqliteMissionReservationStore` below for exactly how atomicity is achieved.
 *
 * `reserve` must be called once per candidate transaction attempt, before the
 * existing pipeline executes, passing the SAME idempotency scoped_key the route
 * layer already claimed for this attempt (see src/api/idempotency.ts) — this is what
 * lets a crashed process's outstanding reservations be safely reconciled on restart
 * (see reconcileMissionReservations below). On any outcome other than the eventual
 * permanent settlement (deny, escalate, execution failure, or the caller giving up),
 * the caller must call `release` with the exact same amount and scoped_key to give
 * the capacity back — mirroring src/api/idempotency.ts's claim/complete-or-release
 * discipline exactly. On a genuine successful settlement, the caller is expected to
 * call `release` too, but only AFTER durably writing the corresponding
 * mission_transaction_link ledger entry — see routes/transactions.ts — so the
 * reserved amount transitions from "reserved" to ledger-recorded "settled" without a
 * window where it is counted as neither.
 */
export interface MissionReservationStore {
  reserve(missionId: string, amountMinorUnits: number, scopedKey: string): ReservationOutcome;
  /** A safe, idempotent no-op if there is nothing (or less than amountMinorUnits) currently reserved — see the module doc comment on why this must never throw or go negative. */
  release(missionId: string, amountMinorUnits: number, scopedKey: string): void;
}

function assertValidAmount(amountMinorUnits: number, fnName: string): void {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error(`${fnName}(): amountMinorUnits must be a positive integer, got ${JSON.stringify(amountMinorUnits)}`);
  }
}

/**
 * Runs once, at construction, to resolve every reservation ticket left behind by a
 * process that died before resolving it — the Step 4 crash/restart gap this step is
 * required to close. See the module doc comment on createSqliteMissionReservationStore
 * for the invariant this depends on: a ticket exists if and only if a reservation is
 * currently outstanding for that exact idempotency scoped_key.
 *
 * For each outstanding ticket, this classifies the fate of its scoped_key's
 * idempotency_records row (see src/api/idempotency.ts):
 *  - "completed": the ORIGINAL request handler already ran to completion before any
 *    crash — including whatever it did with this reservation (released it, or
 *    consumed it into a ledger entry). The ticket is now purely stale bookkeeping;
 *    deleting it does not touch reserved_minor_units at all.
 *  - "orphaned": a previous process died somewhere between claiming this key and
 *    either completing or releasing it — genuinely unknown whether the underlying
 *    transaction actually settled on a rail before it died. The fail-closed choice,
 *    matching every other ambiguous-outcome decision in this codebase (see
 *    src/decision/decide.ts's safeJudge, src/mission/ledger.ts's computeMissionSpent),
 *    is to permanently leave that amount reserved: it can only make the mission's
 *    true remaining budget look SMALLER than it may actually be, never larger, which
 *    is the only direction that matters for this system's guarantees. This can never
 *    cause a duplicate execution, because idempotency's own orphan state already,
 *    independently, permanently blocks that scoped_key from ever being retried — this
 *    function does not need to (and does not) make that guarantee itself. The ticket
 *    is deleted because its fate is now permanently settled: there is nothing further
 *    for a future reconciliation pass to learn by re-examining it.
 *  - No matching idempotency row at all, or still "pending": both should be
 *    structurally unreachable here (every reserve() is called only immediately after
 *    a successful tryClaim for the same scoped_key, and idempotency's own
 *    constructor-time reconciliation — which MUST run before this function, see the
 *    ordering requirement on createSqliteMissionReservationStore — has already turned
 *    every stale "pending" row into "orphaned"). Fail closed by leaving both the
 *    ticket and the reservation untouched rather than guessing, so a genuine anomaly
 *    stays visible instead of being silently resolved one way or the other.
 */
export function reconcileMissionReservations(db: DatabaseSync): { resolved: number; stuck: number } {
  const tickets = db.prepare(`SELECT scoped_key, mission_id, amount_minor_units FROM mission_reservation_tickets`).all() as Array<{
    scoped_key: string;
    mission_id: string;
    amount_minor_units: number;
  }>;

  let resolved = 0;
  let stuck = 0;

  if (tickets.length > 0) {
    const getIdempotencyStateStmt = db.prepare(`SELECT state FROM idempotency_records WHERE scoped_key = :scoped_key`);
    const deleteTicketStmt = db.prepare(`DELETE FROM mission_reservation_tickets WHERE scoped_key = :scoped_key`);

    for (const ticket of tickets) {
      const row = getIdempotencyStateStmt.get({ scoped_key: ticket.scoped_key }) as { state: string } | undefined;
      if (!row || row.state === "pending") continue; // structurally unreachable in practice; fail closed by leaving as-is

      if (row.state === "completed") {
        deleteTicketStmt.run({ scoped_key: ticket.scoped_key });
        resolved++;
      } else if (row.state === "orphaned") {
        deleteTicketStmt.run({ scoped_key: ticket.scoped_key });
        stuck++;
      }
    }

    if (resolved > 0 || stuck > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `Mission reservation reconciliation: ${resolved} reservation ticket(s) resolved cleanly (their transaction's outcome was already fully recorded before a restart), ` +
          `${stuck} reservation(s) left permanently reserved because the underlying transaction's outcome could not be confirmed after a crash/restart. ` +
          `Affected missions will show less available budget than they may actually have; this never risks a duplicate execution.`
      );
    }
  }

  return { resolved, stuck };
}

/**
 * SQLite-backed MissionReservationStore, built on the exact same `missions` table
 * Step 1 already created (its `reserved_minor_units` column exists for precisely this
 * purpose) plus the additive `mission_reservation_tickets` table this step adds.
 *
 * IMPORTANT ordering requirement: this function must be constructed AFTER
 * `createSqliteIdempotencyCache(db)` has already been constructed for the same `db` —
 * that call's own constructor-time reconciliation (turning stale "pending" idempotency
 * rows into "orphaned") must complete first, so that by the time
 * reconcileMissionReservations (called automatically below) runs, every idempotency
 * row a ticket could reference is already in its final, settled state
 * ("completed" or "orphaned"), never a stale "pending" left over from a dead process.
 * See src/api/main.ts and src/api/__tests__/harness.ts for where this ordering is
 * upheld in practice.
 *
 * The core design problem `reserve` itself solves: whether a reservation may proceed
 * depends on THREE quantities — the mission's budget, its currently-outstanding
 * reservations (a plain column on the `missions` row), and its already-settled spend
 * (derived from `ledger_entries`, per src/mission/ledger.ts's computeMissionSpent — a
 * *different* table entirely). Checking these with a JS-level read, then deciding,
 * then writing would reintroduce exactly the TOCTOU race src/api/idempotency.ts's
 * tryClaim was built to eliminate for idempotency keys: two callers could both read
 * "capacity available" before either has written its reservation, and both proceed,
 * together reserving more than the budget allows.
 *
 * Instead, `reserve` is a SINGLE conditional UPDATE whose WHERE clause computes
 * available capacity — budget minus already-reserved minus already-settled — via a
 * correlated subquery against `ledger_entries`, entirely inside SQLite, and only
 * writes the new reservation if that arithmetic still clears the requested amount.
 * `result.changes === 1` IS the atomic accept/reject decision — there is no separate
 * "read remaining budget" statement whose result this function later acts on. That
 * UPDATE and the reservation ticket INSERT are wrapped in one explicit SQL
 * transaction (BEGIN/COMMIT/ROLLBACK), so a crash between them is impossible: either
 * both the reservation and its ticket exist, or neither does — the invariant
 * reconcileMissionReservations depends on. (On the *rejection* path only, a follow-up
 * plain SELECT, after the transaction has already rolled back, is used purely to
 * classify *why* — not-found vs. not-active vs. insufficient-budget — for a clearer
 * caller-facing error; this mirrors idempotency.ts's tryClaim doing the same for
 * hash_mismatch/pending/completed/orphaned after a failed INSERT. That classification
 * read cannot itself grant or deny a reservation — the UPDATE above already has,
 * irreversibly, before this function ever inspects why.)
 *
 * This SQL duplicates (deliberately, and only here) the same "settled spend" business
 * rule as src/mission/ledger.ts's computeMissionSpent — only
 * LEDGER_KIND_MISSION_TRANSACTION_LINK entries whose `success` is `true` count, summed
 * by `amountMinorUnits` — because the atomicity requirement means this arithmetic must
 * run *inside* the same SQL statement as the write, not as a separate call out to that
 * TypeScript function. The two are proven to agree on identical data in this module's
 * test suite (see "computeMissionSpent and the atomic reservation's inline SQL agree
 * on the same ledger data").
 */
export function createSqliteMissionReservationStore(db: DatabaseSync): MissionReservationStore {
  const reserveStmt = db.prepare(`
    UPDATE missions
    SET reserved_minor_units = reserved_minor_units + :amount
    WHERE mission_id = :mission_id
      AND status = 'active'
      AND (
        budget_minor_units
        - reserved_minor_units
        - COALESCE((
            SELECT SUM(json_extract(data_json, '$.amountMinorUnits'))
            FROM ledger_entries
            WHERE kind = :link_kind
              AND json_extract(data_json, '$.missionId') = missions.mission_id
              AND json_extract(data_json, '$.success') = 1
          ), 0)
      ) >= :amount
  `);
  const releaseStmt = db.prepare(`
    UPDATE missions
    SET reserved_minor_units = reserved_minor_units - :amount
    WHERE mission_id = :mission_id AND reserved_minor_units >= :amount
  `);
  const getStatusStmt = db.prepare(`SELECT status FROM missions WHERE mission_id = :mission_id`);
  const insertTicketStmt = db.prepare(`
    INSERT INTO mission_reservation_tickets (scoped_key, mission_id, amount_minor_units, created_at)
    VALUES (:scoped_key, :mission_id, :amount_minor_units, :created_at)
  `);
  const deleteTicketStmt = db.prepare(`DELETE FROM mission_reservation_tickets WHERE scoped_key = :scoped_key`);

  reconcileMissionReservations(db);

  function reserve(missionId: string, amountMinorUnits: number, scopedKey: string): ReservationOutcome {
    assertValidAmount(amountMinorUnits, "reserve");

    db.exec("BEGIN");
    try {
      const result = reserveStmt.run({
        mission_id: missionId,
        amount: amountMinorUnits,
        link_kind: LEDGER_KIND_MISSION_TRANSACTION_LINK,
      });

      if (result.changes !== 1) {
        db.exec("ROLLBACK");
        const row = getStatusStmt.get({ mission_id: missionId }) as { status: string } | undefined;
        if (!row) return { kind: "mission_not_found" };
        if (row.status !== "active") return { kind: "mission_not_active", status: row.status as MissionStatus };
        return { kind: "insufficient_budget" };
      }

      insertTicketStmt.run({
        scoped_key: scopedKey,
        mission_id: missionId,
        amount_minor_units: amountMinorUnits,
        created_at: new Date().toISOString(),
      });
      db.exec("COMMIT");
      return { kind: "reserved" };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function release(missionId: string, amountMinorUnits: number, scopedKey: string): void {
    assertValidAmount(amountMinorUnits, "release");

    db.exec("BEGIN");
    try {
      // No branching on the result: releasing more than is currently reserved (a
      // double-release, or a release with no matching prior reserve) is guarded by
      // the WHERE clause itself and simply does nothing — reserved_minor_units can
      // never be pushed below zero, and a release can never increase anyone's
      // effective authority, so silently no-op-ing here is safe by construction,
      // exactly like idempotency.ts's release() on an already-completed or
      // never-claimed key. The ticket delete is likewise a harmless no-op if none
      // exists for this scoped_key.
      releaseStmt.run({ mission_id: missionId, amount: amountMinorUnits });
      deleteTicketStmt.run({ scoped_key: scopedKey });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return { reserve, release };
}
