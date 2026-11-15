import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";

import { buildHarness, defaultCaveats, defaultTransaction, ScriptedIntentJudge } from "./harness.js";
import { LEDGER_KIND_PRE_EXECUTION_RECHECK } from "../../execution/index.js";

/**
 * Last-moment re-check before a rail is invoked. decideTransaction verifies the
 * capability at its start and then awaits the intent judge — seconds, in production.
 * Anything that changes in that window (revocation, mission cancellation, an agent's
 * first mission being created) must still stop the payment: the rail must never be
 * called, the budget reservation must come back, and the withdrawal must be ledgered.
 *
 * Each test holds the judge open on a promise the test controls, makes the change while
 * the request is provably in flight, then releases the judge and inspects the outcome.
 */

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  return { open, opened, entered, enteredPromise };
}

function blockingJudge() {
  const g = gate();
  const judge = new ScriptedIntentJudge(async () => {
    g.entered();
    await g.opened;
    return { verdict: "consistent", rationale: "fine" };
  });
  return { judge, ...g };
}

async function setup(withMission: boolean) {
  const blocker = blockingJudge();
  // The harness's default judge timeout is 500ms; this test must hold the judge open
  // deliberately, so give it a generous one that the gate always beats.
  const h = buildHarness({ intentJudge: blocker.judge, judgeTimeoutMs: 30_000 });
  const keyRes = await request(h.app).post("/principals").send({ principalId: "acme-corp" });
  const apiKey = keyRes.body.apiKey as string;
  const agentRes = await request(h.app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
  const token = agentRes.body.token as string;
  if (withMission) {
    const m = await request(h.app)
      .post("/missions")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        missionId: "mission-1",
        agentId: "agent-root",
        goal: "Purchase the required flights from an approved provider, staying under $2,000.",
        budgetMinorUnits: 200_000,
        currency: "USD",
        allowedCategories: ["flights"],
        approvedCounterparties: ["acme-airlines"],
        expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      });
    assert.equal(m.status, 201);
  }
  return { ...h, ...blocker, apiKey, token };
}

function submit(app: Express, token: string, key: string, missionId?: string) {
  const req = request(app)
    .post("/transactions")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send({
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      ...(missionId ? { missionId } : {}),
    });
  // supertest requests are lazy thenables; start it now so it is genuinely in flight.
  return req.then((r) => r);
}

function recheckEntries(h: { deps: { ledger: { listByAgent(id: string): Array<{ kind: string; data: unknown }> } } }) {
  return h.deps.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_PRE_EXECUTION_RECHECK);
}

describe("pre-rail recheck — control", () => {
  test("with nothing changing during the judge wait, the transaction still executes normally and writes no recheck entry", async () => {
    const h = await setup(true);
    const inflight = submit(h.app, h.token, "k-control", "mission-1");
    await h.enteredPromise;
    h.open();
    const res = await inflight;
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, true);
    assert.equal(h.stripeRail.calls.length, 1);
    assert.equal(recheckEntries(h).length, 0);
  });
});

describe("pre-rail recheck — revocation during the judge wait", () => {
  test("revoking the agent while the judge is pending denies the transaction: rail never called, reservation returned, withdrawal ledgered", async () => {
    const h = await setup(true);
    const inflight = submit(h.app, h.token, "k-revoke", "mission-1");
    await h.enteredPromise;

    // Provably in flight: the budget is reserved but nothing has executed.
    assert.equal(h.deps.missions.get("mission-1")!.reservedMinorUnits, 38_000);
    const revoke = await request(h.app)
      .post("/agents/agent-root/revoke")
      .set("Authorization", `Bearer ${h.apiKey}`)
      .send({ reason: "compromised mid-flight" });
    assert.equal(revoke.status, 200);

    h.open();
    const res = await inflight;

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "deny");
    assert.match(res.body.decision.reason, /revoked/i);
    assert.equal(res.body.execution, undefined, "a withdrawn authorization has no execution");
    assert.equal(h.stripeRail.calls.length, 0, "no rail call after revocation");
    assert.equal(h.deps.missions.get("mission-1")!.reservedMinorUnits, 0, "reservation returned");

    const entries = recheckEntries(h);
    assert.equal(entries.length, 1);
    assert.equal((entries[0]!.data as { stage: string }).stage, "capability");
    assert.equal(h.deps.ledger.verifyChain().valid, true);
  });

  test("the same holds for a mission-less agent (no mission layer involved)", async () => {
    const h = await setup(false);
    const inflight = submit(h.app, h.token, "k-revoke-nomission");
    await h.enteredPromise;
    await request(h.app).post("/agents/agent-root/revoke").set("Authorization", `Bearer ${h.apiKey}`).send({ reason: "stop" });
    h.open();
    const res = await inflight;
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(recheckEntries(h).length, 1);
  });

  test("a replay of the same Idempotency-Key returns the same denial and still never reaches the rail", async () => {
    const h = await setup(true);
    const inflight = submit(h.app, h.token, "k-replay", "mission-1");
    await h.enteredPromise;
    await request(h.app).post("/agents/agent-root/revoke").set("Authorization", `Bearer ${h.apiKey}`).send({ reason: "stop" });
    h.open();
    const first = await inflight;
    const replay = await submit(h.app, h.token, "k-replay", "mission-1");
    assert.deepEqual(replay.body, first.body);
    assert.equal(h.stripeRail.calls.length, 0);
  });
});

describe("pre-rail recheck — mission state during the judge wait", () => {
  test("cancelling the mission while the judge is pending denies the transaction before the rail", async () => {
    const h = await setup(true);
    const inflight = submit(h.app, h.token, "k-cancel", "mission-1");
    await h.enteredPromise;
    const cancel = await request(h.app).post("/missions/mission-1/cancel").set("Authorization", `Bearer ${h.apiKey}`);
    assert.equal(cancel.status, 200);

    h.open();
    const res = await inflight;

    assert.equal(res.body.decision.verdict, "deny");
    assert.match(res.body.decision.reason, /no longer active/i);
    assert.equal(res.body.execution, undefined);
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.missions.get("mission-1")!.reservedMinorUnits, 0);
    assert.equal((recheckEntries(h)[0]!.data as { stage: string }).stage, "guard");
  });

  test("a mission expiring (by clock) while the judge is pending denies the transaction before the rail", async () => {
    const h = await setup(true);
    const inflight = submit(h.app, h.token, "k-expire", "mission-1");
    await h.enteredPromise;
    // Move the mission's expiry into the past directly in storage, as the clock would.
    h.db.prepare(`UPDATE missions SET expires_at = :t WHERE mission_id = 'mission-1'`).run({ t: new Date(Date.now() - 1000).toISOString() });

    h.open();
    const res = await inflight;
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.missions.get("mission-1")!.status, "expired");
    assert.equal(h.deps.missions.get("mission-1")!.reservedMinorUnits, 0);
  });

  test("F5: a mission-less request in flight when the agent's FIRST mission is created is denied before the rail", async () => {
    const h = await setup(false);
    const inflight = submit(h.app, h.token, "k-f5");
    await h.enteredPromise;
    const created = await request(h.app)
      .post("/missions")
      .set("Authorization", `Bearer ${h.apiKey}`)
      .send({
        missionId: "mission-late",
        agentId: "agent-root",
        goal: "Purchase the required flights from an approved provider, staying under $2,000.",
        budgetMinorUnits: 50_000,
        currency: "USD",
        allowedCategories: ["flights"],
        approvedCounterparties: ["acme-airlines"],
        expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      });
    assert.equal(created.status, 201);

    h.open();
    const res = await inflight;
    assert.equal(res.body.decision.verdict, "deny");
    assert.match(res.body.decision.reason, /mission/i);
    assert.equal(h.stripeRail.calls.length, 0, "an unbudgeted payment must not slip past a mission created mid-flight");
  });
});
