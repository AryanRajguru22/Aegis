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
import { LEDGER_KIND_MISSION_TRANSACTION_LINK, LEDGER_KIND_MISSION_POLICY_VERDICT } from "../../mission/index.js";
import type { AppDependencies } from "../deps.js";
import type { MissionRecordInput } from "../../state/missions.js";
import { buildHarness, defaultCaveats, defaultTransaction, RecordingRailAdapter, ScriptedIntentJudge, alwaysConsistentJudge } from "./harness.js";

/**
 * Integration tests for the mission-to-transaction wiring in
 * routes/transactions.ts — the critical boundary connecting the mission modules
 * (src/mission, src/state/missions.ts) built in Steps 1-4 to the existing, unmodified
 * capability -> decision -> risk -> execution -> ledger pipeline. These tests exercise
 * the full HTTP route, not the underlying primitives in isolation (which already have
 * their own thorough test suites — see src/mission/__tests__).
 */

function missionInput(overrides: Partial<MissionRecordInput> = {}): MissionRecordInput {
  return {
    missionId: "mission-1",
    agentId: "agent-root",
    principalId: "acme-corp",
    goal: "Purchase the required flights from an approved provider, staying under $2,000.",
    budgetMinorUnits: 200_000,
    currency: "USD",
    allowedCategories: ["flights"],
    approvedCounterparties: ["acme-airlines"],
    expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

async function registerPrincipal(app: Express, principalId: string): Promise<string> {
  const res = await request(app).post("/principals").send({ principalId });
  return res.body.apiKey as string;
}

async function registerAgent(
  app: Express,
  apiKey: string,
  agentId: string,
  caveats: Record<string, unknown> = defaultCaveats()
): Promise<string> {
  const res = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId, delegatedGoal: "Book conference travel", caveats });
  return res.body.token as string;
}

/** Registers a principal + agent in one call and returns the agent's bearer token. */
async function createPrincipalAndAgent(
  app: Express,
  { principalId = "acme-corp", agentId = "agent-root", caveats = defaultCaveats() } = {}
): Promise<{ apiKey: string; token: string }> {
  const apiKey = await registerPrincipal(app, principalId);
  const token = await registerAgent(app, apiKey, agentId, caveats);
  return { apiKey, token };
}

function postTransaction(app: Express, token: string, idempotencyKey: string, body: Record<string, unknown>) {
  return request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idempotencyKey).send(body);
}

/** Builds a second Express app reusing the SAME underlying stores (same db, same agents/missions/ledger/reservations state) as an existing harness's deps, swapping only the given fields — e.g. a different rail registry or intent judge for the "retry after the first attempt was denied/escalated/failed" tests. */
function rebuildApp(deps: AppDependencies, overrides: Partial<AppDependencies> = {}): Express {
  return createApp({ ...deps, ...overrides });
}

describe("mission integration — valid mission transaction (happy path)", () => {
  test("a candidate transaction within budget, allowed category, and approved counterparty executes through the full unmodified pipeline and settles", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, true);
    assert.equal(stripeRail.calls.length, 1);
  });
});

describe("mission integration — ownership and authority boundaries", () => {
  test("mission not owned by the authenticated agent: a DIFFERENT agent under the SAME principal is rejected before anything executes", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    await registerAgent(app, apiKey, "agent-owner");
    const otherToken = await registerAgent(app, apiKey, "agent-other");
    deps.missions.register(missionInput({ agentId: "agent-owner" }));

    const res = await postTransaction(app, otherToken, "key-1", {
      transaction: defaultTransaction({ category: "flights" }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });

    assert.equal(res.status, 403);
    assert.equal(stripeRail.calls.length, 0);
  });

  test("cross-principal mission isolation: an agent belonging to a DIFFERENT principal entirely cannot use another principal's mission", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    await registerAgent(app, apiKeyA, "agent-a");
    const apiKeyB = await registerPrincipal(app, "principal-b");
    const tokenB = await registerAgent(app, apiKeyB, "agent-b");
    deps.missions.register(missionInput({ agentId: "agent-a", principalId: "principal-a" }));

    const res = await postTransaction(app, tokenB, "key-1", {
      transaction: defaultTransaction({ category: "flights" }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });

    assert.equal(res.status, 403);
    assert.equal(stripeRail.calls.length, 0);
  });

  test("a nonexistent missionId is rejected with 404 before anything executes", async () => {
    const { app, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights" }),
      counterparty: "acme-airlines",
      missionId: "no-such-mission",
    });

    assert.equal(res.status, 404);
    assert.equal(stripeRail.calls.length, 0);
  });

  test("ADVERSARIAL: a mission wider than the agent's own capability token (a category the token never granted) is rejected — a mission can never widen authority", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, { caveats: defaultCaveats({ categories: ["flights"] }) });
    // Bypasses any hypothetical creation-time gate (none exists yet) by registering
    // directly — exactly how an inconsistent mission could exist in practice.
    deps.missions.register(missionInput({ allowedCategories: ["flights", "gift_cards"] }));

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights" }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });

    assert.equal(res.status, 409);
    assert.match(res.body.error ?? JSON.stringify(res.body), /exceeds the agent's own capability token/);
    assert.equal(stripeRail.calls.length, 0);
  });
});

describe("mission integration — deterministic mission-policy denials (checkMissionGate)", () => {
  test("unauthorized category: a transaction outside the mission's allowed categories is denied by the mission gate before the real pipeline runs, and recorded on the ledger", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, { caveats: defaultCaveats({ categories: ["flights", "software"] }) });
    deps.missions.register(missionInput({ allowedCategories: ["flights"] }));

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "software", rail: "stripe_test" }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(res.body.decision.source, "mission");
    assert.equal(stripeRail.calls.length, 0, "the mission gate must deny before any rail is ever touched");

    const link = deps.ledger.listByAgent("agent-root").find((e) => e.kind === LEDGER_KIND_MISSION_POLICY_VERDICT);
    assert.ok(link, "the mission-level denial must be recorded on the ledger");
    assert.equal((link!.data as { allowed: boolean }).allowed, false);
  });

  test("unauthorized counterparty: a transaction to a vendor outside the mission's approved list is denied, even though amount and category are both otherwise fine", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights" }),
      counterparty: "shady-marketplace",
      missionId: "mission-1",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(res.body.decision.source, "mission");
    assert.equal(stripeRail.calls.length, 0);
  });
});

describe("mission integration — budget exhaustion and concurrency", () => {
  test("budget exhaustion: a second transaction after the mission's budget is fully consumed is denied, with the rail called only once total", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ budgetMinorUnits: 38_000 }));

    const first = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.decision.verdict, "allow");

    const second = await postTransaction(app, token, "key-2", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 1 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.decision.verdict, "deny");

    assert.equal(stripeRail.calls.length, 1, "the rail must never be called for the budget-exhausted second attempt");
  });

  test("ADVERSARIAL: concurrent transactions (different Idempotency-Keys, same mission) whose total exceeds the mission's budget: accepted transactions never collectively exceed it", async () => {
    const { app, deps, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ budgetMinorUnits: 100_000 })); // room for exactly 3 of the 30,000 attempts below

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postTransaction(app, token, `concurrent-key-${i}`, {
          transaction: defaultTransaction({ category: "flights", amountMinorUnits: 30_000 }),
          counterparty: "acme-airlines",
          missionId: "mission-1",
        })
      )
    );

    for (const res of responses) assert.equal(res.status, 200);
    const allowed = responses.filter((r) => r.body.decision.verdict === "allow");
    const denied = responses.filter((r) => r.body.decision.verdict === "deny");

    assert.equal(allowed.length, 3, "floor(100000 / 30000) = 3 concurrent transactions should fit inside the mission's budget");
    assert.equal(denied.length, 2);
    assert.equal(stripeRail.calls.length, 3, "the rail must be called exactly once per genuinely allowed transaction, never for a denied one");
  });
});

describe("mission integration — deny/escalate release the reservation and never touch the rail", () => {
  test("a pipeline-level DENY (capability token ceiling exceeded) releases the mission reservation and calls the rail zero times", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, { caveats: defaultCaveats({ maxAmountMinorUnits: 40_000 }) });
    deps.missions.register(missionInput({ budgetMinorUnits: 50_000 })); // would be fully consumed if the first denied attempt's reservation were never released

    const denied = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 50_000 }), // exceeds the token's own 40,000 ceiling
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.decision.verdict, "deny");
    assert.equal(denied.body.decision.source, undefined, "a pipeline-level deny is NOT a mission-gate denial — it must come from the real policy layer");
    assert.equal(stripeRail.calls.length, 0);

    // If the reservation had not been released, only 0 of the 50,000 budget would
    // remain and this second, token-legal transaction would be wrongly denied too.
    const second = await postTransaction(app, token, "key-2", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(second.body.decision.verdict, "allow", "the first denial's reservation must have been released for this to fit");
    assert.equal(stripeRail.calls.length, 1);
  });

  test("a pipeline-level ESCALATE (intent-consistency judge flags the transaction) releases the mission reservation and calls the rail zero times", async () => {
    const inconsistentJudge = new ScriptedIntentJudge(() => ({ verdict: "inconsistent", rationale: "does not serve the delegated goal" }));
    const { app, deps, stripeRail } = buildHarness({ intentJudge: inconsistentJudge });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ budgetMinorUnits: 38_000 }));

    const escalated = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(escalated.status, 200);
    assert.equal(escalated.body.decision.verdict, "escalate");
    assert.equal(stripeRail.calls.length, 0);

    // Swap in a consistent judge and retry with a fresh key: must succeed, proving
    // the escalated attempt's reservation was released, not left stuck.
    const appWithConsistentJudge = rebuildApp(deps, { intentJudge: alwaysConsistentJudge() });
    const retry = await postTransaction(appWithConsistentJudge, token, "key-2", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(retry.body.decision.verdict, "allow", "the escalated attempt's reservation must have been released for this to fit");
  });
});

describe("mission integration — settlement bookkeeping", () => {
  test("a successful execution writes EXACTLY ONE mission_transaction_link ledger entry, matching the settled amount", async () => {
    const { app, deps } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());

    await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });

    const links = deps.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK);
    assert.equal(links.length, 1);
    assert.deepEqual(links[0]!.data, { missionId: "mission-1", amountMinorUnits: 38_000, success: true });
  });

  test("execution failure (rail itself fails): no mission_transaction_link is written, and the reservation is released so a later transaction can still use that budget", async () => {
    const failingRail = new RecordingRailAdapter("stripe_test", (req) => ({
      success: false,
      rail: "stripe_test",
      reference: "",
      settledAt: new Date().toISOString(),
      error: "simulated rail failure",
      raw: { idempotencyKey: req.idempotencyKey },
    }));
    const { app, deps } = buildHarness({ rails: createRailRegistry([failingRail]) });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ budgetMinorUnits: 38_000 }));

    const failed = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.decision.verdict, "allow");
    assert.equal(failed.body.execution.success, false);

    const links = deps.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK);
    assert.equal(links.length, 0, "a failed execution never settled — no spend should be recorded");

    // A retry (fresh key, same amount) proves the reservation was released, not stuck.
    const workingRail = new RecordingRailAdapter("stripe_test");
    const appWithWorkingRail = rebuildApp(deps, { rails: createRailRegistry([workingRail]) });
    const retry = await postTransaction(appWithWorkingRail, token, "key-2", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(retry.body.execution.success, true);
    assert.equal(workingRail.calls.length, 1);
  });
});

describe("mission integration — concurrent identical idempotency requests are preserved", () => {
  test("5 concurrent POSTs with the same Idempotency-Key AND the same missionId execute exactly once: 1 rail call, 1 mission ledger link, identical responses", async () => {
    const { app, deps, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());
    const body = { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" };

    const responses = await Promise.all(Array.from({ length: 5 }, () => postTransaction(app, token, "shared-key", body)));

    for (const res of responses) assert.equal(res.status, 200);
    assert.equal(stripeRail.calls.length, 1, "the rail must be called exactly once across all 5 concurrent identical requests");

    const bodies = responses.map((r) => JSON.stringify(r.body));
    assert.ok(bodies.every((b) => b === bodies[0]), "all 5 responses must be byte-identical");

    const links = deps.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK);
    assert.equal(links.length, 1, "the mission must be charged exactly once, not once per concurrent caller");
  });
});

describe("mission integration — a mission can never be used after completion/cancellation/expiry", () => {
  for (const status of ["completed", "cancelled", "expired"] as const) {
    test(`a "${status}" mission rejects a transaction attempt; the rail is never called`, async () => {
      const { app, deps, stripeRail } = buildHarness();
      const { token } = await createPrincipalAndAgent(app);
      deps.missions.register(missionInput());
      deps.missions.close("mission-1", status);

      const res = await postTransaction(app, token, "key-1", {
        transaction: defaultTransaction({ category: "flights" }),
        counterparty: "acme-airlines",
        missionId: "mission-1",
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.decision.verdict, "deny");
      assert.equal(stripeRail.calls.length, 0);
    });
  }
});

describe("mission integration — process restart during/after a reservation", () => {
  function tempDbPath(): string {
    return path.join(os.tmpdir(), `aegis-mission-restart-${randomUUID()}.db`);
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
    // Ordering matters — see src/mission/reservation.ts's ordering requirement.
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
      intentJudge: alwaysConsistentJudge(),
      rails: createRailRegistry([rail]),
      idempotency,
      missions,
      reservations,
      idempotencyPollIntervalMs: 5,
      idempotencyWaitTimeoutMs: 2000,
    };
    return { app: createApp(deps), db, rail };
  }

  test("a reservation left mid-flight by a crashed process is safely reconciled on restart: permanently stuck (never silently released), the original key is permanently blocked, and a fresh transaction correctly sees reduced (never inflated) available budget", async () => {
    const dbPath = tempDbPath();
    const rootKeys = generateRootKeyPair();
    const ledgerKeys = generateLedgerKeyPair();
    let before: AppInstance | undefined;
    let after: AppInstance | undefined;

    try {
      before = buildAppInstance(dbPath, rootKeys, ledgerKeys);
      const { token } = await createPrincipalAndAgent(before.app); // registers "acme-corp" / "agent-root"

      const missionsStore = createMissionStore(before.db);
      missionsStore.register(missionInput({ budgetMinorUnits: 100_000 }));

      // Simulate a crash: a process had already atomically claimed the idempotency
      // key AND reserved 60,000 against the mission — exactly the state reserve()
      // leaves behind — but died before ever resolving it (deny/escalate/settle).
      const crashedIdempotencyKey = "crashed-key";
      const scopedKey = `agent-root:${crashedIdempotencyKey}`;
      const transaction = defaultTransaction({ category: "flights", amountMinorUnits: 60_000 });
      const counterparty = "acme-airlines";
      const requestHash = sha256Hex(stableStringify({ transaction, counterparty, missionId: "mission-1" }));

      before.db
        .prepare(`INSERT INTO idempotency_records (scoped_key, request_hash, state, created_at) VALUES (:k, :h, 'pending', :c)`)
        .run({ k: scopedKey, h: requestHash, c: new Date().toISOString() });

      const reservationStore = createSqliteMissionReservationStore(before.db);
      const reserveOutcome = reservationStore.reserve("mission-1", 60_000, scopedKey);
      assert.equal(reserveOutcome.kind, "reserved");

      closeQuietly(before.db);

      // Restart: a brand-new process, same file-backed db, same root/ledger keys.
      after = buildAppInstance(dbPath, rootKeys, ledgerKeys);

      // 1. The original key is now permanently blocked — never silently retryable.
      const retryOriginal = await postTransaction(after.app, token, crashedIdempotencyKey, { transaction, counterparty, missionId: "mission-1" });
      assert.equal(retryOriginal.status, 409);
      assert.match(retryOriginal.body.error, /restart/i);
      assert.equal(after.rail.calls.length, 0, "the rail must never be called for a scoped_key the server cannot confirm the outcome of");

      // 2. The mission's remaining budget correctly reflects the stuck reservation:
      //    100,000 - 60,000(stuck) = 40,000 available. A transaction just over that
      //    must be denied...
      const tooMuch = await postTransaction(after.app, token, "fresh-key-1", {
        transaction: defaultTransaction({ category: "flights", amountMinorUnits: 40_001 }),
        counterparty,
        missionId: "mission-1",
      });
      assert.equal(tooMuch.body.decision.verdict, "deny", "the stuck reservation must reduce available budget, not silently vanish");
      assert.equal(after.rail.calls.length, 0);

      // ...while a transaction that fits within the true remaining 40,000 succeeds —
      // proving the reconciliation is precise (conservative, not maximally paranoid to
      // the point of uselessness).
      const fits = await postTransaction(after.app, token, "fresh-key-2", {
        transaction: defaultTransaction({ category: "flights", amountMinorUnits: 40_000 }),
        counterparty,
        missionId: "mission-1",
      });
      assert.equal(fits.body.decision.verdict, "allow");
      assert.equal(after.rail.calls.length, 1);
    } finally {
      if (before) closeQuietly(before.db);
      if (after) closeQuietly(after.db);
      cleanupDbFile(dbPath);
    }
  });
});
