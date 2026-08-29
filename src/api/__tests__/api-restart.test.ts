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
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex, type LedgerKeyMaterial } from "../../state/index.js";
import { createRailRegistry } from "../../rails/types.js";
import { createApp } from "../server.js";
import { wrapWithNotifications } from "../notifyingLedger.js";
import { createSqliteIdempotencyCache } from "../idempotency.js";
import { createSqliteMissionReservationStore } from "../../mission/reservation.js";
import type { AppDependencies } from "../deps.js";
import { RecordingRailAdapter, alwaysConsistentJudge, defaultCaveats, defaultTransaction } from "./harness.js";

/**
 * These tests exist specifically to prove the two fixes from this hardening pass
 * survive a REAL restart boundary — not an in-process cache clear. Every object in
 * the dependency graph (DatabaseSync handle, every store, the Express app itself) is
 * discarded and rebuilt from scratch between "before" and "after"; only two things
 * cross that boundary: the on-disk SQLite file, and the root/ledger key material
 * (which in a real deployment is exactly what AEGIS_ROOT_PRIVATE_KEY_HEX /
 * AEGIS_LEDGER_PRIVATE_KEY_HEX, per src/api/main.ts, are for — reusing the same JS
 * key objects here tests the persistence boundary that actually matters without
 * needing to round-trip through hex serialization).
 */

function tempDbPath(): string {
  return path.join(os.tmpdir(), `aegis-restart-test-${randomUUID()}.db`);
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // already closed — fine, this is a best-effort cleanup helper
  }
}

function cleanupDbFile(dbPath: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // fine if it never existed, or the handle was somehow still open
    }
  }
}

interface AppInstance {
  app: Express;
  db: DatabaseSync;
  rail: RecordingRailAdapter;
}

function buildAppInstance(dbPath: string, rootKeys: RootKeyMaterial, ledgerKeys: LedgerKeyMaterial): AppInstance {
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
  const rail = new RecordingRailAdapter("stripe_test"); // matches harness.ts's defaultTransaction()'s default rail

  const deps: AppDependencies = {
    rootPrivateKey: rootKeys.privateKey,
    rootPublicKey: rootKeys.publicKey,
    principals,
    agents,
    ledger,
    revocationStore,
    intentJudge: alwaysConsistentJudge(),
    rails: createRailRegistry([rail]),
    idempotency,
    missions,
    reservations,
    judgeTimeoutMs: 500,
  };

  return { app: createApp(deps), db, rail };
}

/**
 * Runs `scenario` with a fresh temp db path and reusable key material, and
 * guarantees cleanup (closing whichever of `before`/`after`'s db handles are still
 * open, then deleting the file) no matter where in the scenario an assertion throws —
 * so a failing test never leaks a locked, undeleted temp database file for the next
 * run to trip over.
 */
async function withRestartScenario(
  scenario: (ctx: {
    rootKeys: RootKeyMaterial;
    ledgerKeys: LedgerKeyMaterial;
    openBefore: () => AppInstance;
    openAfter: () => AppInstance;
  }) => Promise<void>
): Promise<void> {
  const dbPath = tempDbPath();
  const rootKeys = generateRootKeyPair();
  const ledgerKeys = generateLedgerKeyPair();
  const opened: AppInstance[] = [];

  try {
    await scenario({
      rootKeys,
      ledgerKeys,
      openBefore: () => {
        const instance = buildAppInstance(dbPath, rootKeys, ledgerKeys);
        opened.push(instance);
        return instance;
      },
      openAfter: () => {
        const instance = buildAppInstance(dbPath, rootKeys, ledgerKeys);
        opened.push(instance);
        return instance;
      },
    });
  } finally {
    for (const instance of opened) closeQuietly(instance.db);
    cleanupDbFile(dbPath);
  }
}

describe("revocation survives a real process restart", () => {
  test("a token revoked before restart is still denied after every JS object is rebuilt from the same on-disk file", async () => {
    await withRestartScenario(async ({ openBefore, openAfter }) => {
      const before = openBefore();
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      const revokeRes = await request(before.app)
        .post("/agents/agent-root/revoke")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ reason: "pre-restart revocation" });
      assert.equal(revokeRes.status, 200);

      // sanity: revocation is effective before restart too
      const preRestartAttempt = await request(before.app)
        .post("/simulate")
        .set("Authorization", `Bearer ${token}`)
        .send({ transaction: defaultTransaction() });
      assert.equal(preRestartAttempt.body.decision.verdict, "deny");
      assert.match(preRestartAttempt.body.decision.reason, /revoked/);

      before.db.close(); // release the file, simulating process shutdown

      // --- "after restart": every JS object below is newly constructed ---
      const after = openAfter();
      const postRestartAttempt = await request(after.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "post-restart-attempt-1")
        .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

      assert.equal(postRestartAttempt.status, 200);
      assert.equal(postRestartAttempt.body.decision.verdict, "deny", "the agent must still be denied after restart");
      assert.match(postRestartAttempt.body.decision.reason, /revoked/);
      assert.equal(postRestartAttempt.body.execution, undefined, "a denied transaction must still never execute");
      assert.equal(after.rail.calls.length, 0, "the rail adapter in the post-restart instance must never be called");
    });
  });

  test("revoking a ROOT agent before restart still cascades to a sub-agent's token after restart", async () => {
    await withRestartScenario(async ({ openBefore, openAfter }) => {
      const before = openBefore();
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const rootCaveats = defaultCaveats();
      await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats });

      const subAgentRes = await request(before.app)
        .post("/agents/agent-root/attenuate")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-flights", delegatedGoal: "Book flights only", caveats: { ...rootCaveats, categories: ["flights"] } });
      const subToken: string = subAgentRes.body.token;

      await request(before.app).post("/agents/agent-root/revoke").set("Authorization", `Bearer ${apiKey}`).send({ reason: "cascading pre-restart revocation" });
      before.db.close();

      const after = openAfter();
      const res = await request(after.app).post("/simulate").set("Authorization", `Bearer ${subToken}`).send({ transaction: defaultTransaction() });
      assert.equal(res.body.decision.verdict, "deny");
      assert.match(res.body.decision.reason, /revoked/);
    });
  });
});

describe("idempotency survives a real process restart", () => {
  test("replaying the same Idempotency-Key + body after restart returns the cached result and never re-executes", async () => {
    await withRestartScenario(async ({ openBefore, openAfter }) => {
      const before = openBefore();
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };
      const originalRes = await request(before.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "restart-idem-key-1")
        .send(body);
      assert.equal(originalRes.status, 200);
      assert.equal(originalRes.body.decision.verdict, "allow");
      assert.equal(originalRes.body.execution.success, true);
      assert.equal(before.rail.calls.length, 1, "sanity: executed exactly once before restart");

      before.db.close();

      const after = openAfter();
      const replayRes = await request(after.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "restart-idem-key-1")
        .send(body);

      assert.equal(replayRes.status, 200);
      assert.deepEqual(replayRes.body, originalRes.body, "the replayed response must be byte-identical to the original, proving it came from the cache");
      assert.equal(after.rail.calls.length, 0, "the fresh post-restart rail adapter must never be called — no double execution");
    });
  });

  test("reusing the same Idempotency-Key with a DIFFERENT body after restart is still rejected as a conflict, not silently re-executed", async () => {
    await withRestartScenario(async ({ openBefore, openAfter }) => {
      const before = openBefore();
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      await request(before.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "restart-idem-key-2")
        .send({ transaction: defaultTransaction({ amountMinorUnits: 38_000 }), counterparty: "acme-airlines" });
      before.db.close();

      const after = openAfter();
      const conflictRes = await request(after.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "restart-idem-key-2")
        .send({ transaction: defaultTransaction({ amountMinorUnits: 99_000 }), counterparty: "acme-airlines" });

      assert.equal(conflictRes.status, 409);
      assert.equal(after.rail.calls.length, 0, "a rejected conflict must never execute");
    });
  });
});

describe("combined scenario: one restart, both properties checked together", () => {
  test("register, transact, revoke, restart once, then confirm the revoked agent stays denied AND the earlier transaction's idempotency key stays cached", async () => {
    await withRestartScenario(async ({ openBefore, openAfter }) => {
      const before = openBefore();
      const principalRes = await request(before.app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const rootCaveats = defaultCaveats();
      await request(before.app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats });

      const flightsRes = await request(before.app)
        .post("/agents/agent-root/attenuate")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-flights", delegatedGoal: "Book flights only", caveats: { ...rootCaveats, categories: ["flights"] } });
      const flightsToken: string = flightsRes.body.token;

      const txBody = { transaction: defaultTransaction(), counterparty: "acme-airlines" };
      const originalTxRes = await request(before.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${flightsToken}`)
        .set("Idempotency-Key", "combined-key-1")
        .send(txBody);
      assert.equal(originalTxRes.body.decision.verdict, "allow");

      await request(before.app).post("/agents/agent-root/revoke").set("Authorization", `Bearer ${apiKey}`).send({ reason: "combined test revocation" });

      before.db.close();

      const after = openAfter();

      // property 1: revocation still holds
      const deniedRes = await request(after.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${flightsToken}`)
        .set("Idempotency-Key", "combined-key-2")
        .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });
      assert.equal(deniedRes.body.decision.verdict, "deny");
      assert.match(deniedRes.body.decision.reason, /revoked/);

      // property 2: the earlier, pre-revocation transaction's idempotency key still
      // returns its cached result rather than re-executing (the token itself would
      // now be denied on a fresh attempt, which makes this the sharpest possible
      // version of the test — if idempotency caching didn't survive, this would
      // incorrectly re-run decideTransaction and return "deny" instead of the
      // original cached "allow").
      const replayRes = await request(after.app)
        .post("/transactions")
        .set("Authorization", `Bearer ${flightsToken}`)
        .set("Idempotency-Key", "combined-key-1")
        .send(txBody);
      assert.deepEqual(replayRes.body, originalTxRes.body);
      assert.equal(replayRes.body.decision.verdict, "allow", "the cached pre-revocation result must be returned as-is, not recomputed against the now-revoked token");

      assert.equal(after.rail.calls.length, 0, "neither the denied attempt nor the cached replay may touch the rail adapter");
    });
  });
});
