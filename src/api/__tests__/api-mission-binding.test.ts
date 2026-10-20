import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";

import { generateRootKeyPair } from "../../capability/keys.js";
import { openDatabase } from "../../state/db.js";
import { createAgentStore } from "../../state/agents.js";
import { createMissionStore } from "../../state/missions.js";
import { createPrincipalStore } from "../../state/principals.js";
import { createSqliteRevocationStore } from "../../state/revocations.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../../state/index.js";
import { createRailRegistry } from "../../rails/types.js";
import { createApp } from "../server.js";
import { wrapWithNotifications } from "../notifyingLedger.js";
import { createSqliteIdempotencyCache } from "../idempotency.js";
import { createSqliteMissionReservationStore } from "../../mission/reservation.js";
import { LEDGER_KIND_MISSION_POLICY_VERDICT } from "../../mission/index.js";
import type { MissionRecordInput } from "../../state/missions.js";
import { buildHarness, defaultCaveats, defaultTransaction, RecordingRailAdapter, alwaysConsistentJudge } from "./harness.js";

/**
 * F1 (audit finding): mission budgets were opt-in per request — omitting `missionId`
 * skipped the whole mission layer (gate + atomic reservation), so a token holder could
 * spend past a mission's cumulative budget. The remediated invariant tested here is
 * STICKY: once an agent has been assigned any mission (a row in `missions`, in any
 * status), every simulate/execute for that agent must name a mission. Cancelling,
 * completing or expiring every mission never restores mission-less spending. The flag
 * is derived from the missions table itself (rows are never deleted), so it needs no
 * migration and is automatically applied to legacy agents that already have missions.
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

async function registerAgent(app: Express, apiKey: string, agentId: string): Promise<string> {
  const res = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId, delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
  return res.body.token as string;
}

async function setup() {
  const h = buildHarness();
  const apiKey = await registerPrincipal(h.app, "acme-corp");
  const token = await registerAgent(h.app, apiKey, "agent-root");
  return { ...h, apiKey, token };
}

const FLIGHT = () => defaultTransaction({ category: "flights", amountMinorUnits: 38_000 });

function execute(app: Express, token: string, key: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/transactions")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send({ transaction: FLIGHT(), counterparty: "acme-airlines", ...extra });
}

function simulate(app: Express, token: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/simulate")
    .set("Authorization", `Bearer ${token}`)
    .send({ transaction: FLIGHT(), ...extra });
}

type Harness = Awaited<ReturnType<typeof setup>>;

function missionPolicyEntries(h: Pick<Harness, "deps">, agentId = "agent-root") {
  return h.deps.ledger.listByAgent(agentId).filter((e) => e.kind === LEDGER_KIND_MISSION_POLICY_VERDICT);
}

function assertMissionRequiredDenial(res: request.Response) {
  assert.equal(res.status, 200);
  assert.equal(res.body.decision.verdict, "deny");
  assert.equal(res.body.decision.source, "mission");
  assert.match(res.body.decision.reason, /mission/i);
  assert.equal(res.body.execution, undefined, "a denied request never has an execution");
}

describe("F1 — control: an agent that has never been assigned a mission keeps token-only authority", () => {
  test("mission-less simulate and execute behave exactly as before", async () => {
    const h = await setup();
    assert.equal((await simulate(h.app, h.token)).body.decision.verdict, "allow");
    const res = await execute(h.app, h.token, "k-control");
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, true);
    assert.equal(h.stripeRail.calls.length, 1);
  });
});

describe("F1 — a mission-bound agent cannot spend without naming a mission", () => {
  test("execute without missionId is denied by the mission layer: rail never called, nothing reserved, denial ledgered", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput());

    const res = await execute(h.app, h.token, "k-1");
    assertMissionRequiredDenial(res);
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.missions.get("mission-1")!.reservedMinorUnits, 0);

    const entries = missionPolicyEntries(h);
    assert.equal(entries.length, 1);
    const data = entries[0]!.data as Record<string, unknown>;
    assert.equal(data.missionId, null);
    assert.equal(data.allowed, false);
    assert.equal(data.activeMissionCount, 1);
  });

  test("simulate applies the SAME rule as execute (a dry run must not report 'allow' for something execute would deny)", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput());
    assertMissionRequiredDenial(await simulate(h.app, h.token));
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.missions.get("mission-1")!.reservedMinorUnits, 0);
  });

  test("the same agent naming its active mission still works (the rule narrows, never blocks the legitimate path)", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput());
    const res = await execute(h.app, h.token, "k-ok", { missionId: "mission-1" });
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, true);
    assert.equal(h.stripeRail.calls.length, 1);
    assert.equal((await simulate(h.app, h.token, { missionId: "mission-1", counterparty: "acme-airlines" })).body.decision.verdict, "allow");
  });

  test("two active missions: omitting the id is denied, naming either one works", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput({ missionId: "mission-a" }));
    h.deps.missions.register(missionInput({ missionId: "mission-b" }));
    assertMissionRequiredDenial(await execute(h.app, h.token, "k-none"));
    assert.equal((await execute(h.app, h.token, "k-b", { missionId: "mission-b" })).body.execution.success, true);
    assert.equal(h.stripeRail.calls.length, 1);
  });

  test("a different agent of the same principal that was never assigned a mission is unaffected", async () => {
    const h = await setup();
    const otherToken = await registerAgent(h.app, h.apiKey, "agent-other");
    h.deps.missions.register(missionInput());
    const res = await execute(h.app, otherToken, "k-other");
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(h.stripeRail.calls.length, 1);
  });

  test("an idempotent replay of the denial returns the identical cached response, and the same key with a different missionId is a hash mismatch (409)", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput());
    const first = await execute(h.app, h.token, "k-replay");
    const second = await execute(h.app, h.token, "k-replay");
    assert.deepEqual(second.body, first.body);
    assert.equal(missionPolicyEntries(h).length, 1, "a replay must not append a second denial entry");
    const mismatch = await execute(h.app, h.token, "k-replay", { missionId: "mission-1" });
    assert.equal(mismatch.status, 409);
    assert.equal(h.stripeRail.calls.length, 0);
  });
});

describe("F1 — stickiness: ending every mission never restores mission-less spending", () => {
  const closedStates: Array<["cancelled" | "completed" | "expired", string]> = [
    ["cancelled", "cancelled"],
    ["completed", "completed"],
    ["expired", "expired"],
  ];
  for (const [status] of closedStates) {
    test(`all missions "${status}": mission-less execute and simulate are still denied, with a reason that says no mission is active`, async () => {
      const h = await setup();
      h.deps.missions.register(missionInput());
      h.deps.missions.close("mission-1", status);
      const res = await execute(h.app, h.token, `k-${status}`);
      assertMissionRequiredDenial(res);
      assert.match(res.body.decision.reason, /none is currently active/i);
      assertMissionRequiredDenial(await simulate(h.app, h.token));
      assert.equal(h.stripeRail.calls.length, 0);
    });
  }

  test("a mission past its expiresAt whose status is still 'active' (never lazily reconciled) also keeps the agent bound", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const res = await execute(h.app, h.token, "k-clock");
    assertMissionRequiredDenial(res);
    assert.match(res.body.decision.reason, /none is currently active/i);
  });

  test("cancelling through the real API does not unbind the agent", async () => {
    const h = await setup();
    const create = await request(h.app)
      .post("/missions")
      .set("Authorization", `Bearer ${h.apiKey}`)
      .send({
        missionId: "mission-api",
        agentId: "agent-root",
        goal: "Book flights",
        budgetMinorUnits: 100_000,
        currency: "USD",
        allowedCategories: ["flights"],
        approvedCounterparties: ["acme-airlines"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    assert.equal(create.status, 201);
    const cancel = await request(h.app).post("/missions/mission-api/cancel").set("Authorization", `Bearer ${h.apiKey}`);
    assert.equal(cancel.status, 200);
    assertMissionRequiredDenial(await execute(h.app, h.token, "k-after-cancel"));
    assert.equal(h.stripeRail.calls.length, 0);
  });

  test("a NEW mission restores spending, but only through that mission", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput({ missionId: "old" }));
    h.deps.missions.close("old", "cancelled");
    assertMissionRequiredDenial(await execute(h.app, h.token, "k-1"));
    h.deps.missions.register(missionInput({ missionId: "fresh" }));
    assertMissionRequiredDenial(await execute(h.app, h.token, "k-2"));
    assert.equal((await execute(h.app, h.token, "k-3", { missionId: "fresh" })).body.execution.success, true);
  });
});

describe("F1 — newly created missions take effect immediately", () => {
  test("mission-less spending works until the first mission is created, then is denied on the very next request", async () => {
    const h = await setup();
    assert.equal((await execute(h.app, h.token, "k-before")).body.execution.success, true);

    const create = await request(h.app)
      .post("/missions")
      .set("Authorization", `Bearer ${h.apiKey}`)
      .send({
        missionId: "mission-late",
        agentId: "agent-root",
        goal: "Book flights",
        budgetMinorUnits: 100_000,
        currency: "USD",
        allowedCategories: null,
        approvedCounterparties: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    assert.equal(create.status, 201);

    assertMissionRequiredDenial(await execute(h.app, h.token, "k-after"));
    assert.equal(h.stripeRail.calls.length, 1, "only the pre-mission transaction ever reached the rail");
  });
});

describe("F1 — persistence and legacy agents (the flag is derived from the missions table, never from memory)", () => {
  function tempDbPath(): string {
    return path.join(os.tmpdir(), `aegis-binding-test-${randomUUID()}.db`);
  }
  function cleanup(dbPath: string): void {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // never existed / already gone
      }
    }
  }
  function buildOn(dbPath: string, rootKeys: ReturnType<typeof generateRootKeyPair>, ledgerKeys: ReturnType<typeof generateLedgerKeyPair>) {
    const db: DatabaseSync = openDatabase(dbPath);
    const principals = createPrincipalStore(db);
    const agents = createAgentStore(db);
    const ledger = wrapWithNotifications(createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey)));
    const idempotency = createSqliteIdempotencyCache(db);
    const missions = createMissionStore(db);
    const reservations = createSqliteMissionReservationStore(db);
    const rail = new RecordingRailAdapter("stripe_test");
    const app = createApp({
      rootPrivateKey: rootKeys.privateKey,
      rootPublicKey: rootKeys.publicKey,
      principals,
      agents,
      ledger,
      revocationStore: createSqliteRevocationStore(db),
      intentJudge: alwaysConsistentJudge(),
      rails: createRailRegistry([rail]),
      idempotency,
      missions,
      reservations,
      judgeTimeoutMs: 500,
    });
    return { app, db, rail, missions };
  }

  test("a legacy database (agent + mission rows written by an older build, mission since cancelled) is mission-bound on first boot of the new code, and stays bound across a further restart", async () => {
    const dbPath = tempDbPath();
    const rootKeys = generateRootKeyPair();
    const ledgerKeys = generateLedgerKeyPair();
    const opened: DatabaseSync[] = [];
    try {
      // "Old build": mission-less spending was allowed, so this is a state the old code could produce.
      const old = buildOn(dbPath, rootKeys, ledgerKeys);
      opened.push(old.db);
      const apiKey = await registerPrincipal(old.app, "acme-corp");
      const token = await registerAgent(old.app, apiKey, "agent-root");
      old.missions.register(missionInput());
      old.missions.close("mission-1", "cancelled");
      old.db.close();

      for (let boot = 1; boot <= 2; boot++) {
        const next = buildOn(dbPath, rootKeys, ledgerKeys);
        opened.push(next.db);
        const res = await execute(next.app, token, `k-boot-${boot}`);
        assertMissionRequiredDenial(res);
        assert.equal(next.rail.calls.length, 0);
        next.db.close();
      }
    } finally {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      cleanup(dbPath);
    }
  });
});

describe("F1 — malformed mission identifiers are rejected safely (400, before anything executes)", () => {
  const BAD: Array<[string, unknown]> = [
    ["null", null],
    ["empty string", ""],
    ["a number", 123],
    ["a boolean", true],
    ["an array", ["mission-1"]],
    ["an object", { id: "mission-1" }],
    ["a quote and SQL fragment", `x'; DROP TABLE missions;--`],
    ["a path traversal", "../mission-1"],
    ["whitespace inside", "mission 1"],
    ["a percent-encoded NUL", "mission%00"],
    ["a 65-character id", "m".repeat(65)],
    ["a 10 KB id", "m".repeat(10_000)],
    ["non-ASCII", "missión-1"],
  ];

  for (const [label, value] of BAD) {
    test(`missionId = ${label} → 400 on /transactions and /simulate for both a bound and an unbound agent; no rail call, no ledger growth`, async () => {
      const h = await setup();
      const otherToken = await registerAgent(h.app, h.apiKey, "agent-other");
      h.deps.missions.register(missionInput());
      const before = h.deps.ledger.all().length;

      for (const token of [h.token, otherToken]) {
        const ex = await execute(h.app, token, `k-${randomUUID()}`, { missionId: value });
        assert.equal(ex.status, 400, `execute: ${JSON.stringify(ex.body).slice(0, 200)}`);
        const sim = await simulate(h.app, token, { missionId: value, counterparty: "acme-airlines" });
        assert.equal(sim.status, 400);
      }
      assert.equal(h.stripeRail.calls.length, 0);
      assert.equal(h.deps.ledger.all().length, before, "a rejected request must not write anything to the ledger");
      assert.equal(h.deps.missions.get("mission-1")!.status, "active", "the missions table is intact");
    });
  }

  test("a well-formed but nonexistent id → 404 (never 500)", async () => {
    const h = await setup();
    assert.equal((await execute(h.app, h.token, "k-404", { missionId: "no-such-mission" })).status, 404);
    assert.equal((await simulate(h.app, h.token, { missionId: "no-such-mission", counterparty: "acme-airlines" })).status, 404);
  });
});

describe("F1 — cross-agent / cross-principal mission access is denied with a uniform 404 (no existence oracle)", () => {
  test("same principal, different agent: a foreign mission is indistinguishable from a nonexistent one, on both routes", async () => {
    const h = await setup();
    const otherToken = await registerAgent(h.app, h.apiKey, "agent-other");
    h.deps.missions.register(missionInput({ missionId: "owned-by-root" }));

    const foreign = await execute(h.app, otherToken, "k-f", { missionId: "owned-by-root" });
    const missing = await execute(h.app, otherToken, "k-m", { missionId: "does-not-exist" });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(foreign.body.error, `Mission "owned-by-root" not found`);
    assert.equal(missing.body.error, `Mission "does-not-exist" not found`);

    const foreignSim = await simulate(h.app, otherToken, { missionId: "owned-by-root", counterparty: "acme-airlines" });
    const missingSim = await simulate(h.app, otherToken, { missionId: "does-not-exist", counterparty: "acme-airlines" });
    assert.equal(foreignSim.status, 404);
    assert.equal(missingSim.status, 404);
    assert.equal(foreignSim.body.error, foreign.body.error);
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.missions.get("owned-by-root")!.reservedMinorUnits, 0, "a rejected foreign access never reserves anything on the owner's mission");
  });

  test("different principal entirely → the same uniform 404", async () => {
    const h = await setup();
    const apiKeyB = await registerPrincipal(h.app, "principal-b");
    const tokenB = await registerAgent(h.app, apiKeyB, "agent-b");
    h.deps.missions.register(missionInput({ missionId: "a-private-mission" }));
    const res = await execute(h.app, tokenB, "k-x", { missionId: "a-private-mission" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, `Mission "a-private-mission" not found`);
    assert.equal(h.stripeRail.calls.length, 0);
  });

  test("a non-owner cannot observe or trigger expiry reconciliation of someone else's mission", async () => {
    const h = await setup();
    const otherToken = await registerAgent(h.app, h.apiKey, "agent-other");
    h.deps.missions.register(missionInput({ missionId: "stale", expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const res = await execute(h.app, otherToken, "k-s", { missionId: "stale" });
    assert.equal(res.status, 404);
    assert.equal(h.deps.missions.get("stale")!.status, "active", "ownership is checked BEFORE reconciliation, so a non-owner changes and learns nothing");
  });
});

describe("F1 — the original overspend reproduction, and atomic reservation under concurrency", () => {
  test("REPRO: mission budget 40,000 — settle 38,000 under the mission, the second is denied for budget, and the mission-less third can no longer settle", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput({ budgetMinorUnits: 40_000 }));

    const first = await execute(h.app, h.token, "k-1", { missionId: "mission-1" });
    assert.equal(first.body.execution.success, true);
    const second = await execute(h.app, h.token, "k-2", { missionId: "mission-1" });
    assert.equal(second.body.decision.verdict, "deny");
    assert.match(second.body.decision.reason, /budget/i);
    const third = await execute(h.app, h.token, "k-3"); // the bypass that previously settled
    assertMissionRequiredDenial(third);

    assert.equal(h.stripeRail.calls.length, 1, "total real settlements: exactly one, 38,000 ≤ 40,000");
    const mission = await request(h.app).get("/missions/mission-1").set("Authorization", `Bearer ${h.apiKey}`);
    assert.equal(mission.body.spentMinorUnits, 38_000);
    assert.equal(mission.body.reservedMinorUnits, 0);
  });

  test("ADVERSARIAL: 12 concurrent mission-less + 12 concurrent mission-scoped attempts (distinct keys) against a 100,000 budget — mission-less never settle, mission-scoped never exceed the budget, reservation ends at 0", async () => {
    const h = await setup();
    h.deps.missions.register(missionInput({ budgetMinorUnits: 100_000 }));

    const attempts = [
      ...Array.from({ length: 12 }, (_, i) => execute(h.app, h.token, `k-less-${i}`)),
      ...Array.from({ length: 12 }, (_, i) => execute(h.app, h.token, `k-with-${i}`, { missionId: "mission-1" })),
    ];
    const results = await Promise.all(attempts);

    const lessSettled = results.slice(0, 12).filter((r) => r.body.execution?.success === true).length;
    assert.equal(lessSettled, 0, "no mission-less request may settle for a mission-bound agent");
    results.slice(0, 12).forEach((r) => assertMissionRequiredDenial(r));

    const withSettled = results.slice(12).filter((r) => r.body.execution?.success === true).length;
    assert.equal(withSettled, 2, "exactly floor(100000 / 38000) mission-scoped settlements fit");
    assert.equal(h.stripeRail.calls.length, 2);

    const mission = await request(h.app).get("/missions/mission-1").set("Authorization", `Bearer ${h.apiKey}`);
    assert.equal(mission.body.spentMinorUnits, 76_000);
    assert.equal(mission.body.reservedMinorUnits, 0);
    assert.ok(mission.body.spentMinorUnits <= 100_000);
  });
});
