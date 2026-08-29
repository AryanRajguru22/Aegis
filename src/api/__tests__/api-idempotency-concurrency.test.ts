import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";

import { generateRootKeyPair, type RootKeyMaterial } from "../../capability/keys.js";
import { openDatabase } from "../../state/db.js";
import { createAgentStore } from "../../state/agents.js";
import { createMissionStore } from "../../state/missions.js";
import { createPrincipalStore } from "../../state/principals.js";
import { createSqliteRevocationStore } from "../../state/revocations.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex, sha256Hex, stableStringify, type LedgerKeyMaterial } from "../../state/index.js";
import { createRailRegistry } from "../../rails/types.js";
import { createApp } from "../server.js";
import { wrapWithNotifications } from "../notifyingLedger.js";
import { createSqliteIdempotencyCache } from "../idempotency.js";
import { createSqliteMissionReservationStore } from "../../mission/reservation.js";
import type { AppDependencies } from "../deps.js";
import type { NotifyingLedgerStore } from "../notifyingLedger.js";
import type { IdempotencyCache, IdempotencyRecord } from "../idempotency.js";
import { buildHarness, defaultCaveats, defaultTransaction, RecordingRailAdapter } from "./harness.js";

/**
 * Proves the atomic-claim redesign in src/api/idempotency.ts + src/api/routes/
 * transactions.ts actually eliminates the check-then-act race documented in the
 * hostile security re-audit — where 5 truly concurrent identical requests produced 5
 * separate rail executions. Every test here fires genuinely concurrent HTTP requests
 * (Promise.all, not sequential awaits) against a real createApp() instance.
 */

async function createPrincipalAndAgent(app: Express, principalId = "acme-corp", agentId = "agent-root") {
  const principalRes = await request(app).post("/principals").send({ principalId });
  const apiKey: string = principalRes.body.apiKey;
  const agentRes = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId, delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
  const token: string = agentRes.body.token;
  return { apiKey, token };
}

function tempDbPath(): string {
  return path.join(os.tmpdir(), `aegis-concurrency-restart-${randomUUID()}.db`);
}
function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
function cleanupDbFile(dbPath: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* fine */
    }
  }
}
function buildAppInstance(dbPath: string, rootKeys: RootKeyMaterial, ledgerKeys: LedgerKeyMaterial) {
  const db = openDatabase(dbPath);
  const principals = createPrincipalStore(db);
  const agents = createAgentStore(db);
  const ledger = wrapWithNotifications(createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey)));
  const revocationStore = createSqliteRevocationStore(db);
  // idempotency must be constructed before reservations — see
  // src/mission/reservation.ts's ordering requirement on
  // createSqliteMissionReservationStore.
  const idempotency = createSqliteIdempotencyCache(db);
  const missions = createMissionStore(db);
  const reservations = createSqliteMissionReservationStore(db);
  const rail = new RecordingRailAdapter("stripe_test");
  const deps: AppDependencies = {
    rootPrivateKey: rootKeys.privateKey,
    rootPublicKey: rootKeys.publicKey,
    principals,
    agents,
    ledger,
    revocationStore,
    intentJudge: {
      async judge() {
        return { verdict: "consistent", rationale: "fine" };
      },
    },
    rails: createRailRegistry([rail]),
    idempotency,
    missions,
    reservations,
    idempotencyPollIntervalMs: 5,
    idempotencyWaitTimeoutMs: 2000,
  };
  return { app: createApp(deps), db, rail };
}

describe("5+ truly concurrent identical requests execute exactly once", () => {
  test("5 concurrent POSTs with the same Idempotency-Key and body → 1 rail execution, 1 settlement, identical responses to all 5 callers", async () => {
    const { app, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "concurrent-key-1").send(body)
      )
    );

    for (const res of responses) {
      assert.equal(res.status, 200);
    }
    assert.equal(stripeRail.calls.length, 1, "the rail adapter must be called exactly once across all 5 concurrent requests");

    const references = new Set(responses.map((r) => r.body.execution?.reference));
    assert.equal(references.size, 1, "every caller must see the SAME settlement reference, not 5 different ones");

    const bodies = responses.map((r) => JSON.stringify(r.body));
    assert.ok(
      bodies.every((b) => b === bodies[0]),
      "every one of the 5 responses must be byte-identical"
    );
  });

  test("10 concurrent requests still execute exactly once (stress beyond the minimum)", async () => {
    const { app, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "concurrent-key-2").send(body)
      )
    );

    assert.equal(stripeRail.calls.length, 1);
    for (const res of responses) assert.equal(res.status, 200);
  });
});

describe("concurrent requests with the same key but DIFFERENT bodies", () => {
  test("only one body ever executes; every conflicting concurrent request is rejected, never executed", async () => {
    const { app, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const { token } = await createPrincipalAndAgent(app);

    const responses = await Promise.all([
      request(app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "conflict-key-1")
        .send({ transaction: defaultTransaction({ amountMinorUnits: 38_000 }), counterparty: "acme-airlines" }),
      request(app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "conflict-key-1")
        .send({ transaction: defaultTransaction({ amountMinorUnits: 99_000 }), counterparty: "acme-airlines" }),
      request(app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "conflict-key-1")
        .send({ transaction: defaultTransaction({ amountMinorUnits: 150_000 }), counterparty: "acme-airlines" }),
    ]);

    const statuses = responses.map((r) => r.status).sort();
    // Exactly one of the three distinct bodies gets to execute (200); the other two,
    // whichever they were, are rejected as a hash mismatch (409) — never silently
    // executed and never silently coalesced into someone else's body.
    assert.deepEqual(statuses, [200, 409, 409]);
    assert.equal(stripeRail.calls.length, 1, "at most one of the conflicting bodies may ever reach the rail adapter");
  });
});

describe("different principals using the same raw Idempotency-Key value are fully isolated", () => {
  test("both execute independently — the key value alone never collides across principals/agents", async () => {
    const { app, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const a = await createPrincipalAndAgent(app, "principal-a", "agent-a");
    const b = await createPrincipalAndAgent(app, "principal-b", "agent-b");
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const [resA, resB] = await Promise.all([
      request(app).post("/transactions").set("Authorization", `Bearer ${a.token}`).set("Idempotency-Key", "shared-raw-key").send(body),
      request(app).post("/transactions").set("Authorization", `Bearer ${b.token}`).set("Idempotency-Key", "shared-raw-key").send(body),
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(stripeRail.calls.length, 2, "each principal's identically-keyed request must execute on its own");
    assert.notEqual(resA.body.execution?.reference, resB.body.execution?.reference);
  });
});

describe("execution failure never leaves a permanently stuck claim", () => {
  test("an unexpected throw during execution releases the claim, so a retry with the same key can succeed", async () => {
    const db = openDatabase(":memory:");
    const { privateKey: rootPrivateKey, publicKey: rootPublicKey } = generateRootKeyPair();
    const principals = createPrincipalStore(db);
    const agents = createAgentStore(db);
    const ledgerKeys = generateLedgerKeyPair();
    const realLedger = wrapWithNotifications(createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey)));
    const rail = new RecordingRailAdapter("stripe_test");
    const idempotency = createSqliteIdempotencyCache(db);
    const missions = createMissionStore(db);
    const reservations = createSqliteMissionReservationStore(db);

    // Armed explicitly (not "fail on call N") so agent registration's own ledger
    // write — which happens first, before any transaction is attempted — is
    // unaffected. Only the transaction attempt itself is faulted, simulating a
    // genuinely unexpected infrastructure failure (a DB write erroring mid-flow), not
    // a normal deny/escalate/execution-failure outcome.
    const fault = { armed: false };
    const ledger: NotifyingLedgerStore = {
      ...realLedger,
      append(entry) {
        if (fault.armed) {
          fault.armed = false;
          throw new Error("simulated ledger write failure");
        }
        return realLedger.append(entry);
      },
    };

    const deps: AppDependencies = {
      rootPrivateKey,
      rootPublicKey,
      principals,
      agents,
      ledger,
      revocationStore: createSqliteRevocationStore(db),
      intentJudge: { async judge() { return { verdict: "consistent", rationale: "fine" }; } },
      rails: createRailRegistry([rail]),
      idempotency,
      missions,
      reservations,
      idempotencyPollIntervalMs: 5,
      idempotencyWaitTimeoutMs: 2000,
    };
    const app = createApp(deps);

    const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const apiKey: string = principalRes.body.apiKey;
    const agentRes = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats() });
    const token: string = agentRes.body.token;
    assert.equal(agentRes.status, 201, "agent setup itself must succeed, unaffected by the fault armed below");

    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    fault.armed = true;
    const firstAttempt = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "flaky-key-1").send(body);
    assert.equal(firstAttempt.status, 500, "the simulated infrastructure failure must surface as a server error, not a fabricated result");
    assert.equal(rail.calls.length, 0, "the rail must never be reached when decideTransaction itself throws before a verdict exists");

    const retry = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "flaky-key-1").send(body);
    assert.equal(retry.status, 200, "the key must be claimable again — no permanently stuck pending record");
    assert.equal(retry.body.decision.verdict, "allow");
    assert.equal(rail.calls.length, 1);
  });

  test("a NORMAL execution failure (e.g. no rail adapter registered) is cached deterministically like any other outcome — replay does not re-attempt", async () => {
    const { app } = buildHarness({ rails: createRailRegistry([]), idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 2000 });
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const first = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "no-rail-key").send(body);
    assert.equal(first.status, 200, "a decided-but-failed-to-settle transaction is a normal, cacheable outcome, not a server error");
    assert.equal(first.body.decision.verdict, "allow");
    assert.equal(first.body.execution.success, false);
    assert.match(first.body.execution.error, /No rail adapter registered/);

    const replay = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "no-rail-key").send(body);
    assert.deepEqual(replay.body, first.body, "replaying must return the exact cached failure, not attempt execution again");
  });
});

describe("restart after successful execution — replay remains cached via the atomic-claim implementation", () => {
  test("a transaction executed before restart, replayed after restart with the same key+body, returns the cached result and does not re-execute", async () => {
    const dbPath = tempDbPath();
    const rootKeys = generateRootKeyPair();
    const ledgerKeys = generateLedgerKeyPair();

    try {
      const before = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };
      const original = await request(before.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "restart-concurrency-key").send(body);
      assert.equal(original.status, 200);
      assert.equal(before.rail.calls.length, 1);
      before.db.close();

      const after = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      try {
        const replay = await request(after.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "restart-concurrency-key").send(body);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, original.body);
        assert.equal(after.rail.calls.length, 0, "no execution may occur on the fresh post-restart instance for a replayed key");

        // and concurrent replays post-restart still collapse to one another correctly
        const concurrentReplays = await Promise.all(
          Array.from({ length: 3 }, () =>
            request(after.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "restart-concurrency-key").send(body)
          )
        );
        for (const r of concurrentReplays) assert.deepEqual(r.body, original.body);
        assert.equal(after.rail.calls.length, 0);
      } finally {
        closeQuietly(after.db);
      }
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

describe("complete() failure after a successful execution never causes a second execution", () => {
  function flakyCompleteCache(real: IdempotencyCache, failCount: number): IdempotencyCache {
    let attempts = 0;
    return {
      ...real,
      complete(scopedKey: string, record: IdempotencyRecord) {
        attempts++;
        if (attempts <= failCount) {
          throw new Error(`simulated cache write failure (attempt ${attempts})`);
        }
        real.complete(scopedKey, record);
      },
    };
  }

  test("a transient complete() failure that recovers within the retry budget is absorbed silently — one execution, correctly cached", async () => {
    const real = createSqliteIdempotencyCache(openDatabase(":memory:"));
    const idempotency = flakyCompleteCache(real, 1); // fails once, the route's internal retry then succeeds
    const { app, stripeRail } = buildHarness({ idempotency, idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 2000 });
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const res = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "flaky-complete-1").send(body);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(stripeRail.calls.length, 1);

    const replay = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "flaky-complete-1").send(body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, res.body, "the retry-recovered cache write must serve the replay correctly, from the actual completed record");
    assert.equal(stripeRail.calls.length, 1, "still exactly one execution — the retry recovered the write, it did not re-execute");
  });

  test("a PERSISTENT complete() failure still returns the true, successful result to the original caller — never a fabricated error, and never releases the claim", async () => {
    const real = createSqliteIdempotencyCache(openDatabase(":memory:"));
    const idempotency = flakyCompleteCache(real, Number.POSITIVE_INFINITY); // never recovers
    const { app, stripeRail } = buildHarness({ idempotency, idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 200 });
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const res = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "flaky-complete-2").send(body);
    assert.equal(res.status, 200, "the transaction genuinely executed and must be reported accurately, even though caching the result failed");
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, true);
    assert.equal(stripeRail.calls.length, 1);

    // A second attempt with the same key must NOT re-execute. Because the cache write
    // never succeeded, the claim is deliberately left "pending" forever rather than
    // released — the second attempt polls and times out (409) rather than either
    // re-executing (unsafe) or fabricating a cached response it doesn't actually have.
    const second = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "flaky-complete-2").send(body);
    assert.equal(second.status, 409);
    assert.equal(stripeRail.calls.length, 1, "the rail must never be called a second time, even though the first attempt's result could not be cached");
  });
});

describe("orphaned pending claims after a hard process restart are safely reconciled, never silently reclaimed", () => {
  test("a claim left 'pending' by a simulated crashed process is reconciled to 'orphaned' on the next construction, and can never be claimed, executed, or replayed again", async () => {
    const dbPath = tempDbPath();
    const rootKeys = generateRootKeyPair();
    const ledgerKeys = generateLedgerKeyPair();

    try {
      // --- "before restart": register everything normally, then simulate the process
      // dying mid-transaction by inserting a 'pending' idempotency row directly via
      // raw SQL — exactly the state a real crash between claiming and
      // completing/releasing would leave behind, without needing to actually kill a
      // process.
      const before = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      const scopedKey = "agent-root:orphan-test-key";
      const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };
      // hashRequest is a pure function of the body — compute it the same way
      // idempotency.ts does, without constructing a second cache instance against the
      // same live db (which would itself trigger reconciliation prematurely).
      const requestHash = sha256Hex(stableStringify({ transaction: body.transaction, counterparty: body.counterparty }));
      before.db
        .prepare(`INSERT INTO idempotency_records (scoped_key, request_hash, state, created_at) VALUES (?, ?, 'pending', ?)`)
        .run(scopedKey, requestHash, new Date().toISOString());
      before.db.close();

      // --- "after restart": a fresh store construction must reconcile the orphaned row.
      const after = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      try {
        const row = after.db.prepare(`SELECT state FROM idempotency_records WHERE scoped_key = ?`).get(scopedKey) as { state: string } | undefined;
        assert.equal(row?.state, "orphaned", "reconciliation at construction time must mark the leftover pending row as orphaned");

        const attempt = await request(after.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "orphan-test-key").send(body);
        assert.equal(attempt.status, 409);
        assert.match(attempt.body.error, /restart/i);
        assert.equal(after.rail.calls.length, 0, "an orphaned claim must never be executed, regardless of whether the crashed process had actually reached the rail");

        // it stays permanently blocked, not just blocked once
        const secondAttempt = await request(after.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "orphan-test-key").send(body);
        assert.equal(secondAttempt.status, 409);
        assert.equal(after.rail.calls.length, 0);
      } finally {
        closeQuietly(after.db);
      }
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  test("reconciliation only affects genuinely orphaned rows — a completed claim from before the restart still replays correctly", async () => {
    const dbPath = tempDbPath();
    const rootKeys = generateRootKeyPair();
    const ledgerKeys = generateLedgerKeyPair();

    try {
      const before = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };
      const completedBefore = await request(before.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "genuinely-completed-key").send(body);
      assert.equal(completedBefore.status, 200);

      // ALSO leave a genuinely orphaned row for a different key, to prove
      // reconciliation is scoped per-row, not a blunt "wipe everything" operation.
      before.db
        .prepare(`INSERT INTO idempotency_records (scoped_key, request_hash, state, created_at) VALUES (?, ?, 'pending', ?)`)
        .run("agent-root:a-different-orphan", "irrelevant-hash", new Date().toISOString());
      before.db.close();

      const after = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      try {
        const replay = await request(after.app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "genuinely-completed-key").send(body);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, completedBefore.body, "a genuinely completed claim must replay normally after restart, unaffected by reconciliation of an unrelated orphaned row");
        assert.equal(after.rail.calls.length, 0, "the completed claim must not re-execute");

        const rows = after.db.prepare(`SELECT scoped_key, state FROM idempotency_records ORDER BY scoped_key`).all() as Array<{ scoped_key: string; state: string }>;
        const completedRow = rows.find((r) => r.scoped_key.includes("genuinely-completed-key"));
        const orphanRow = rows.find((r) => r.scoped_key === "agent-root:a-different-orphan");
        assert.equal(completedRow?.state, "completed");
        assert.equal(orphanRow?.state, "orphaned");
      } finally {
        closeQuietly(after.db);
      }
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
