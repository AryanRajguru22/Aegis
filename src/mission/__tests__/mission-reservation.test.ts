import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../state/db.js";
import { createAgentStore } from "../../state/agents.js";
import { createMissionStore } from "../../state/missions.js";
import type { MissionStatus } from "../../state/missions.js";
import { createSqliteMissionReservationStore, reconcileMissionReservations } from "../reservation.js";
import { computeMissionSpent, LEDGER_KIND_MISSION_TRANSACTION_LINK } from "../ledger.js";
import type { LedgerEntry } from "../../state/ledger.js";

let skCounter = 0;
/** A fresh, unique idempotency scoped_key for each logical reservation attempt in these tests — mirrors the `${agentId}:${Idempotency-Key}` convention routes/transactions.ts uses in the real app. */
function nextScopedKey(): string {
  return `agent-root:sk-${skCounter++}`;
}

/** Registers an agent and an active mission with the given budget, ready for reservation tests. */
function setup(budgetMinorUnits = 200_000) {
  const db = openDatabase(":memory:");
  const agents = createAgentStore(db);
  const missions = createMissionStore(db);
  const reservations = createSqliteMissionReservationStore(db);

  agents.register({
    agentId: "agent-root",
    principalId: "principal-1",
    parentAgentId: null,
    delegatedGoal: "Purchase API credits from an approved provider",
    caveats: { maxAmountMinorUnits: 500_000 },
    tokenBase64: "root-token",
    revocationId: "rev-root",
  });

  missions.register({
    missionId: "mission-1",
    agentId: "agent-root",
    principalId: "principal-1",
    goal: "Purchase the required API credits from an approved provider, staying under ₹2,000.",
    budgetMinorUnits,
    currency: "INR",
    allowedCategories: ["api_credits"],
    approvedCounterparties: null,
    expiresAt: "2027-01-01T00:00:00Z",
  });

  return { db, agents, missions, reservations };
}

/** Registers a second, independent agent + mission under a different principal, for isolation tests. */
function registerSecondMission(
  db: ReturnType<typeof openDatabase>,
  { missionId, agentId, principalId, budgetMinorUnits }: { missionId: string; agentId: string; principalId: string; budgetMinorUnits: number }
) {
  const agents = createAgentStore(db);
  const missions = createMissionStore(db);
  if (!agents.get(agentId)) {
    agents.register({
      agentId,
      principalId,
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: `rev-${agentId}`,
    });
  }
  missions.register({
    missionId,
    agentId,
    principalId,
    goal: "x",
    budgetMinorUnits,
    currency: "INR",
    allowedCategories: null,
    approvedCounterparties: null,
    expiresAt: "2027-01-01T00:00:00Z",
  });
}

function getMissionRow(db: ReturnType<typeof openDatabase>, missionId: string): { reserved_minor_units: number; budget_minor_units: number; status: string } {
  return db
    .prepare(`SELECT reserved_minor_units, budget_minor_units, status FROM missions WHERE mission_id = :mission_id`)
    .get({ mission_id: missionId }) as never;
}

function getTicketCount(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM mission_reservation_tickets`).get() as { n: number }).n;
}

/** Simulates a crashed process's idempotency_records row directly via raw SQL — the same technique src/api/__tests__/api-idempotency-concurrency.test.ts uses for its own orphaned-claim tests. */
function insertRawIdempotencyRecord(db: ReturnType<typeof openDatabase>, scopedKey: string, state: "pending" | "completed" | "orphaned"): void {
  db.prepare(
    `INSERT INTO idempotency_records (scoped_key, request_hash, state, created_at) VALUES (:scoped_key, 'hash', :state, :created_at)`
  ).run({ scoped_key: scopedKey, state, created_at: new Date().toISOString() });
}

/**
 * Schedules `n` calls to `fn` as separate microtasks before any of them runs, so all
 * `n` attempts are genuinely "in flight" simultaneously from the JS scheduler's
 * perspective before the first one's synchronous DB work executes — the same
 * interleaving idiom src/api/__tests__/api-idempotency-concurrency.test.ts uses (there
 * via real concurrent HTTP requests; here directly, since there is no HTTP layer yet
 * in this step). This is what actually exercises whether the SQL statement, not
 * JS-level ordering, is the thing preventing an over-reservation.
 */
function concurrently<T>(n: number, fn: (i: number) => T): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => Promise.resolve().then(() => fn(i))));
}

function insertSettledLedgerEntry(
  db: ReturnType<typeof openDatabase>,
  missionId: string,
  amountMinorUnits: number,
  success: boolean
): void {
  db.prepare(
    `INSERT INTO ledger_entries (kind, agent_id, principal_id, data_json, created_at, prev_hash, content_hash, signature)
     VALUES (:kind, 'agent-root', 'principal-1', :data_json, :created_at, 'prev', 'hash', 'sig')`
  ).run({
    kind: LEDGER_KIND_MISSION_TRANSACTION_LINK,
    data_json: JSON.stringify({ missionId, amountMinorUnits, success }),
    created_at: new Date().toISOString(),
  });
}

describe("mission reservation — boundary correctness", () => {
  test("a reservation for exactly the full remaining budget succeeds", () => {
    const { reservations } = setup(200_000);
    assert.deepEqual(reservations.reserve("mission-1", 200_000, nextScopedKey()), { kind: "reserved" });
  });

  test("a reservation for one minor unit over the remaining budget fails with 'insufficient_budget'", () => {
    const { reservations } = setup(200_000);
    assert.deepEqual(reservations.reserve("mission-1", 200_001, nextScopedKey()), { kind: "insufficient_budget" });
  });

  test("after reserving the exact budget, even a 1-unit further reservation fails", () => {
    const { reservations } = setup(200_000);
    assert.equal(reservations.reserve("mission-1", 200_000, nextScopedKey()).kind, "reserved");
    assert.deepEqual(reservations.reserve("mission-1", 1, nextScopedKey()), { kind: "insufficient_budget" });
  });

  test("reserve() against a nonexistent missionId returns 'mission_not_found'", () => {
    const { reservations } = setup();
    assert.deepEqual(reservations.reserve("no-such-mission", 1, nextScopedKey()), { kind: "mission_not_found" });
  });

  for (const status of ["completed", "cancelled", "expired"] as const) {
    test(`reserve() against a "${status}" mission returns 'mission_not_active', never silently reserving`, () => {
      const { reservations, missions } = setup(200_000);
      missions.close("mission-1", status);
      assert.deepEqual(reservations.reserve("mission-1", 100, nextScopedKey()), { kind: "mission_not_active", status });
    });
  }
});

describe("mission reservation — release restores capacity, safely", () => {
  test("release() restores exactly the released amount as available capacity for a subsequent reserve()", () => {
    const { reservations } = setup(200_000);
    const key = nextScopedKey();
    assert.equal(reservations.reserve("mission-1", 150_000, key).kind, "reserved");
    assert.deepEqual(reservations.reserve("mission-1", 60_000, nextScopedKey()), { kind: "insufficient_budget" });

    reservations.release("mission-1", 150_000, key);
    assert.equal(reservations.reserve("mission-1", 150_000, nextScopedKey()).kind, "reserved");
  });

  test("release() on a mission with nothing reserved is a safe, silent no-op — it never throws and never drives reserved_minor_units negative", () => {
    const { reservations, db } = setup(200_000);
    assert.doesNotThrow(() => reservations.release("mission-1", 1, nextScopedKey()));
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 0);
  });

  test("ADVERSARIAL: releasing MORE than is currently reserved is clamped by the WHERE clause guard, not allowed to push reserved_minor_units negative", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    reservations.release("mission-1", 999_999, key); // far more than the 50,000 actually reserved
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 50_000, "the guarded UPDATE must not have matched, leaving reserved_minor_units untouched rather than negative");
  });

  test("ADVERSARIAL: a double-release of the same amount does not create negative accounting or inflate available capacity beyond the original budget", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 100_000, key);
    reservations.release("mission-1", 100_000, key);
    reservations.release("mission-1", 100_000, key); // second release: nothing left to release
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 0);
    // If the double-release had incorrectly gone negative, this reservation would
    // wrongly appear to fit (budget - (-100000) = 300000 >= 250000). It must not.
    assert.deepEqual(reservations.reserve("mission-1", 250_000, nextScopedKey()), { kind: "insufficient_budget" });
  });

  test("release() rejects a non-positive-integer amount just like reserve() does", () => {
    const { reservations } = setup();
    const key = nextScopedKey();
    assert.throws(() => reservations.release("mission-1", 0, key));
    assert.throws(() => reservations.release("mission-1", -5, key));
    assert.throws(() => reservations.release("mission-1", 1.5, key));
  });

  test("reserve() rejects a non-positive-integer amount", () => {
    const { reservations } = setup();
    const key = nextScopedKey();
    assert.throws(() => reservations.reserve("mission-1", 0, key));
    assert.throws(() => reservations.reserve("mission-1", -5, key));
    assert.throws(() => reservations.reserve("mission-1", 1.5, key));
  });
});

describe("mission reservation — adversarial: concurrency (SQL-level atomicity, not application locking)", () => {
  test("five concurrent ₹1,500 reservations against a ₹2,000 mission: only one can reserve", async () => {
    const { reservations, db } = setup(200_000); // ₹2,000 in minor units (paise)
    const results = await concurrently(5, () => reservations.reserve("mission-1", 150_000, nextScopedKey())); // ₹1,500 each

    const successes = results.filter((r) => r.kind === "reserved");
    assert.equal(successes.length, 1, "exactly one of five concurrent ₹1,500 attempts against a ₹2,000 budget must win");
    assert.equal(results.filter((r) => r.kind === "insufficient_budget").length, 4);
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 150_000);
  });

  test("ten concurrent smaller reservations whose total exceeds the remaining budget: accepted reservations never collectively exceed the budget", async () => {
    const { reservations, db } = setup(200_000); // ₹2,000
    const results = await concurrently(10, () => reservations.reserve("mission-1", 30_000, nextScopedKey())); // ₹300 each, 10x = ₹3,000 total requested

    const successCount = results.filter((r) => r.kind === "reserved").length;
    const row = getMissionRow(db, "mission-1");

    assert.ok(row.reserved_minor_units <= row.budget_minor_units, "accepted reservations must never collectively exceed the mission's budget");
    assert.equal(row.reserved_minor_units, successCount * 30_000, "the final reserved total must exactly match successful attempts — no lost or phantom updates");
    assert.equal(successCount, 6, "floor(200000 / 30000) = 6 concurrent ₹300 reservations should fit inside a ₹2,000 budget");
  });

  test("ADVERSARIAL — the atomicity boundary itself: 50 concurrent 1-unit reservations against a budget of exactly 25 land on exactly 25 reserved, never more and never fewer than the budget allows, with no lost-update artifacts", async () => {
    // This is the direct test that the atomic conditional UPDATE — not JS-level
    // ordering, not an in-process mutex (there is none anywhere in reservation.ts) —
    // is what enforces the cap. A read-then-calculate-then-write implementation
    // would, under this much overlap, either overshoot the budget (a classic lost
    // update: two reads both see room, both writes land) or undercount successes
    // (if guarded by an overly conservative lock). Landing on precisely 25 reserved
    // out of 50 attempts is only possible if each attempt's accept/reject decision was
    // made against the true, currently-committed state at the instant it ran.
    const { reservations, db } = setup(25);
    const results = await concurrently(50, () => reservations.reserve("mission-1", 1, nextScopedKey()));

    const successCount = results.filter((r) => r.kind === "reserved").length;
    assert.equal(successCount, 25);
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 25);
  });
});

describe("mission reservation — adversarial: cross-mission and cross-principal isolation", () => {
  test("different missions are completely isolated: exhausting one mission's budget has no effect on a sibling mission's available capacity", () => {
    const { reservations, db } = setup(200_000);
    registerSecondMission(db, { missionId: "mission-2", agentId: "agent-root", principalId: "principal-1", budgetMinorUnits: 200_000 });

    assert.equal(reservations.reserve("mission-1", 200_000, nextScopedKey()).kind, "reserved");
    assert.deepEqual(reservations.reserve("mission-1", 1, nextScopedKey()), { kind: "insufficient_budget" });

    // mission-2, sharing the same agent/principal, must be entirely unaffected.
    assert.equal(reservations.reserve("mission-2", 200_000, nextScopedKey()).kind, "reserved");
    assert.equal(getMissionRow(db, "mission-2").reserved_minor_units, 200_000);
  });

  test("cross-principal isolation: reserving heavily against one principal's mission cannot consume or affect a different principal's mission's reservation capacity", () => {
    const { reservations, db } = setup(200_000);
    registerSecondMission(db, { missionId: "mission-p2", agentId: "agent-p2", principalId: "principal-2", budgetMinorUnits: 50_000 });

    // Exhaust principal-1's mission entirely.
    assert.equal(reservations.reserve("mission-1", 200_000, nextScopedKey()).kind, "reserved");

    // principal-2's mission must still have its full, untouched budget available —
    // this primitive has no principalId parameter at all, so isolation here comes
    // purely from missionId being a distinct primary key per row; verifying it holds
    // is what proves one principal's activity can never touch another's accounting.
    assert.equal(reservations.reserve("mission-p2", 50_000, nextScopedKey()).kind, "reserved");
    assert.deepEqual(reservations.reserve("mission-p2", 1, nextScopedKey()), { kind: "insufficient_budget" });
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 200_000, "principal-2's activity must not have touched principal-1's mission");
  });

  test("concurrent reservations against two different missions never cross-contaminate each other's totals", async () => {
    const { reservations, db } = setup(100_000);
    registerSecondMission(db, { missionId: "mission-2", agentId: "agent-root", principalId: "principal-1", budgetMinorUnits: 100_000 });

    const results = await concurrently(20, (i) => reservations.reserve(i % 2 === 0 ? "mission-1" : "mission-2", 10_000, nextScopedKey()));

    assert.equal(results.filter((r) => r.kind === "reserved").length, 20, "each mission independently has room for its 10 interleaved 10,000-unit reservations");
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 100_000);
    assert.equal(getMissionRow(db, "mission-2").reserved_minor_units, 100_000);
  });
});

describe("mission reservation — interaction with ledger-derived settled spend (Step 3)", () => {
  test("a reservation correctly accounts for already-SUCCESSFUL settled spend recorded in the ledger, not just the reserved_minor_units column", () => {
    const { reservations, db } = setup(200_000);
    insertSettledLedgerEntry(db, "mission-1", 150_000, true); // ₹1,500 already permanently spent

    // Only ₹500 should be available: 200,000 - 0(reserved) - 150,000(settled) = 50,000
    assert.deepEqual(reservations.reserve("mission-1", 50_000, nextScopedKey()), { kind: "reserved" });
    assert.deepEqual(reservations.reserve("mission-1", 1, nextScopedKey()), { kind: "insufficient_budget" });
  });

  test("a FAILED settlement entry in the ledger does not reduce available reservation capacity, matching computeMissionSpent's own semantics", () => {
    const { reservations, db } = setup(200_000);
    insertSettledLedgerEntry(db, "mission-1", 999_999, false); // failed execution — never actually spent

    assert.deepEqual(reservations.reserve("mission-1", 200_000, nextScopedKey()), { kind: "reserved" }, "the full budget must still be available; a failed settlement must not count against it");
  });

  test("a settled spend entry belonging to a DIFFERENT mission does not reduce this mission's available capacity", () => {
    const { reservations, db } = setup(200_000);
    registerSecondMission(db, { missionId: "mission-2", agentId: "agent-root", principalId: "principal-1", budgetMinorUnits: 200_000 });
    insertSettledLedgerEntry(db, "mission-2", 200_000, true);

    assert.deepEqual(reservations.reserve("mission-1", 200_000, nextScopedKey()), { kind: "reserved" });
  });

  test("already-reserved AND already-settled amounts are BOTH subtracted from budget together, not just one or the other", () => {
    const { reservations, db } = setup(200_000);
    insertSettledLedgerEntry(db, "mission-1", 80_000, true); // ₹800 settled
    assert.equal(reservations.reserve("mission-1", 70_000, nextScopedKey()).kind, "reserved"); // ₹700 reserved

    // Available should now be 200,000 - 70,000(reserved) - 80,000(settled) = 50,000
    assert.deepEqual(reservations.reserve("mission-1", 50_001, nextScopedKey()), { kind: "insufficient_budget" });
    assert.deepEqual(reservations.reserve("mission-1", 50_000, nextScopedKey()), { kind: "reserved" });
  });

  test("computeMissionSpent (TypeScript) and the atomic reservation's inline SQL agree on the same ledger data — a consistency safeguard between Step 3's pure reader and Step 4's atomic writer", () => {
    const { reservations, db } = setup(1_000_000);
    insertSettledLedgerEntry(db, "mission-1", 50_000, true);
    insertSettledLedgerEntry(db, "mission-1", 999_999, false); // must be excluded by both
    insertSettledLedgerEntry(db, "mission-1", 30_000, true);

    // Read the same rows back as real LedgerEntry objects the way any real caller
    // (a future route step) would, and feed them through Step 3's pure function.
    const rows = db
      .prepare(`SELECT * FROM ledger_entries WHERE kind = :kind`)
      .all({ kind: LEDGER_KIND_MISSION_TRANSACTION_LINK }) as Array<Record<string, unknown>>;
    const entries: LedgerEntry[] = rows.map((row) => ({
      seq: Number(row.seq),
      kind: String(row.kind),
      agentId: String(row.agent_id),
      principalId: String(row.principal_id),
      data: JSON.parse(String(row.data_json)),
      createdAt: String(row.created_at),
      prevHash: String(row.prev_hash),
      contentHash: String(row.content_hash),
      signature: String(row.signature),
    }));
    const spentPerComputeMissionSpent = computeMissionSpent(entries, "mission-1");
    assert.equal(spentPerComputeMissionSpent, 80_000);

    // The atomic reservation's own inline SQL must derive the identical "already
    // spent" figure: budget(1,000,000) - reserved(0) - spent(80,000) = 920,000
    // available. Reserving exactly that must succeed; one more must not.
    assert.deepEqual(reservations.reserve("mission-1", 1_000_000 - spentPerComputeMissionSpent, nextScopedKey()), { kind: "reserved" });
    assert.deepEqual(reservations.reserve("mission-1", 1, nextScopedKey()), { kind: "insufficient_budget" });
  });
});

describe("mission reservation — crash/restart reconciliation (the Step 4 gap this step closes)", () => {
  test("reserve() writes a reservation ticket alongside the reserved_minor_units increment", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    assert.equal(getTicketCount(db), 1);
  });

  test("release() deletes the ticket alongside the reserved_minor_units decrement", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    reservations.release("mission-1", 50_000, key);
    assert.equal(getTicketCount(db), 0);
  });

  test("a ticket whose idempotency record is 'completed' is resolved cleanly: the ticket is deleted and reserved_minor_units is left exactly as the (already-finished) original request left it", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key); // simulates the original request having reserved...
    insertRawIdempotencyRecord(db, key, "completed"); // ...and having gone on to complete normally (e.g. it was a deny/escalate that released, or a settlement that already re-reserved correctly — either way, resolved)

    const { resolved, stuck } = reconcileMissionReservations(db);
    assert.equal(resolved, 1);
    assert.equal(stuck, 0);
    assert.equal(getTicketCount(db), 0, "a resolved ticket must be cleaned up");
    // Reconciliation for a "completed" ticket must never itself touch reserved_minor_units — whatever the original request left behind (0 if it released, or a settled amount if it consumed) is left untouched.
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 50_000);
  });

  test("ADVERSARIAL — the core crash-safety property: a ticket whose idempotency record is 'orphaned' leaves reserved_minor_units PERMANENTLY stuck rather than releasing it, because it is unknown whether the underlying transaction actually settled", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 150_000, key); // simulates a reservation made just before the process died
    insertRawIdempotencyRecord(db, key, "orphaned"); // simulates idempotency's own restart reconciliation already having run and found this claim abandoned

    const { resolved, stuck } = reconcileMissionReservations(db);
    assert.equal(resolved, 0);
    assert.equal(stuck, 1);
    assert.equal(getTicketCount(db), 0, "the ticket's fate is now permanently settled — it must not linger for a future pass to re-examine");
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 150_000, "the reservation must remain in place — releasing it could let a settled transaction's amount be spent again");

    // The mission must still correctly show reduced (not restored) availability.
    assert.deepEqual(reservations.reserve("mission-1", 50_001, nextScopedKey()), { kind: "insufficient_budget" });
    assert.deepEqual(reservations.reserve("mission-1", 50_000, nextScopedKey()), { kind: "reserved" });
  });

  test("this can NEVER cause a duplicate execution: the same scoped_key that owns a stuck 'orphaned' reservation is, independently, permanently blocked at the idempotency layer — reconciliation here does not need to (and does not) enforce that itself", () => {
    // This test documents and verifies the DIVISION OF RESPONSIBILITY the crash-safety
    // argument depends on: idempotency.ts's own orphan state is what prevents a
    // retry under the same key; reconcileMissionReservations only ever decides what
    // to do with the mission's BUDGET accounting, never whether a request may be
    // retried. Simulating that the idempotency layer has already marked the key
    // "orphaned" (as it would have, before this function ever runs — see the ordering
    // requirement) is sufficient to demonstrate reconciliation never needs to reason
    // about retryability at all.
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    insertRawIdempotencyRecord(db, key, "orphaned");

    assert.doesNotThrow(() => reconcileMissionReservations(db));
    // The idempotency record itself is untouched by mission reconciliation — its
    // permanence is owned entirely by src/api/idempotency.ts, not this module.
    const idempotencyRow = db.prepare(`SELECT state FROM idempotency_records WHERE scoped_key = :k`).get({ k: key }) as { state: string };
    assert.equal(idempotencyRow.state, "orphaned");
  });

  test("a ticket with NO matching idempotency record at all is left completely untouched — fails closed on a genuine anomaly rather than guessing", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    // Deliberately no idempotency_records row inserted for this scoped_key.

    const { resolved, stuck } = reconcileMissionReservations(db);
    assert.equal(resolved, 0);
    assert.equal(stuck, 0);
    assert.equal(getTicketCount(db), 1, "the ticket must be left in place for a future pass to reconsider, not silently discarded");
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 50_000);
  });

  test("a ticket whose idempotency record is still 'pending' (structurally unreachable in the real system, since idempotency reconciliation always runs first) is left completely untouched, never assumed safe to release", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    insertRawIdempotencyRecord(db, key, "pending");

    const { resolved, stuck } = reconcileMissionReservations(db);
    assert.equal(resolved, 0);
    assert.equal(stuck, 0);
    assert.equal(getTicketCount(db), 1);
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 50_000);
  });

  test("reconciliation correctly processes multiple tickets in one pass, with mixed outcomes, and never cross-contaminates their amounts", () => {
    const { reservations, db } = setup(1_000_000);
    registerSecondMission(db, { missionId: "mission-2", agentId: "agent-root", principalId: "principal-1", budgetMinorUnits: 1_000_000 });

    const completedKey = nextScopedKey();
    const orphanedKey = nextScopedKey();
    const unknownKey = nextScopedKey();

    reservations.reserve("mission-1", 10_000, completedKey);
    reservations.reserve("mission-1", 20_000, orphanedKey);
    reservations.reserve("mission-2", 30_000, unknownKey);
    insertRawIdempotencyRecord(db, completedKey, "completed");
    insertRawIdempotencyRecord(db, orphanedKey, "orphaned");
    // unknownKey deliberately has no idempotency record.

    const { resolved, stuck } = reconcileMissionReservations(db);
    assert.equal(resolved, 1);
    assert.equal(stuck, 1);
    assert.equal(getTicketCount(db), 1, "only the unresolved (unknown) ticket should remain");

    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 30_000, "10,000 (completed) + 20,000 (orphaned, stuck) — both untouched by reconciliation itself");
    assert.equal(getMissionRow(db, "mission-2").reserved_minor_units, 30_000, "mission-2's unresolved reservation must be completely unaffected by mission-1's reconciliation outcomes");
  });

  test("reconciliation is idempotent: running it again after everything is already resolved does nothing and does not throw", () => {
    const { reservations, db } = setup(200_000);
    const key = nextScopedKey();
    reservations.reserve("mission-1", 50_000, key);
    insertRawIdempotencyRecord(db, key, "orphaned");

    reconcileMissionReservations(db);
    const second = reconcileMissionReservations(db);
    assert.deepEqual(second, { resolved: 0, stuck: 0 });
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 50_000, "already-reconciled state must be stable across repeated runs");
  });

  test("reconciliation with no tickets at all is a harmless no-op", () => {
    const { db } = setup(200_000);
    assert.deepEqual(reconcileMissionReservations(db), { resolved: 0, stuck: 0 });
  });

  test("reconciliation runs automatically at createSqliteMissionReservationStore construction time, resolving a stuck reservation left by a previous 'process' before any new reserve()/release() call is made", () => {
    const { db } = setup(200_000);
    const key = nextScopedKey();

    // Simulate a full crash: reserve via a first store instance (standing in for the
    // process that died), record its idempotency key as orphaned (standing in for
    // idempotency's own restart reconciliation, which always runs before this one),
    // and only THEN construct a brand-new store instance against the same db — this
    // exercises the automatic constructor-time call, not the exported function directly.
    const firstInstance = createSqliteMissionReservationStore(db);
    firstInstance.reserve("mission-1", 60_000, key);
    insertRawIdempotencyRecord(db, key, "orphaned");

    assert.equal(getTicketCount(db), 1, "precondition: a ticket exists before the 'restart'");
    createSqliteMissionReservationStore(db); // stands in for the process restarting
    assert.equal(getTicketCount(db), 0, "construction must have run reconciliation automatically");
    assert.equal(getMissionRow(db, "mission-1").reserved_minor_units, 60_000, "the reservation must remain safely stuck, exactly as a direct reconcileMissionReservations() call would leave it");
  });
});
