import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { buildHarness, defaultCaveats, defaultTransaction, ScriptedIntentJudge, RecordingRailAdapter } from "./harness.js";
import { executeApprovedEscalation, LEDGER_KIND_PRE_EXECUTION_RECHECK, LEDGER_KIND_EXECUTION_RESULT } from "../../execution/index.js";
import { createRailRegistry } from "../../rails/types.js";
import { LEDGER_KIND_ESCALATION_OPENED, LEDGER_KIND_ESCALATION_RESOLVED, createEscalationStore, escalationExecutionKey } from "../../state/escalations.js";
import { createSqliteMissionReservationStore } from "../../mission/reservation.js";

/**
 * Operator resolution of escalated transactions. An ESCALATE verdict (risk stage doubt)
 * parks the transaction as a pending escalation; the owning principal approves or
 * rejects it. Approval re-runs every safeguard except the risk stage; rejection never
 * reaches a rail; every decision is in the hash-chained ledger.
 */

const ambiguousJudge = () => new ScriptedIntentJudge(() => ({ verdict: "ambiguous", rationale: "cannot tell" }));
const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

async function setup(opts: { mission?: { budget: number } | false } = {}) {
  const h = buildHarness({ intentJudge: ambiguousJudge() });
  const apiKey = (await request(h.app).post("/principals").send({ principalId: "acme-corp" })).body.apiKey as string;
  const agentRes = await request(h.app)
    .post("/agents")
    .set(auth(apiKey))
    .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
  const token = agentRes.body.token as string;
  const withMission = opts.mission !== false;
  if (withMission) {
    const budget = opts.mission ? opts.mission.budget : 200_000;
    const m = await request(h.app)
      .post("/missions")
      .set(auth(apiKey))
      .send({
        missionId: "mission-1",
        agentId: "agent-root",
        goal: "Purchase the required flights from an approved provider.",
        budgetMinorUnits: budget,
        currency: "USD",
        allowedCategories: ["flights"],
        approvedCounterparties: ["acme-airlines"],
        expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      });
    assert.equal(m.status, 201);
  }
  return { ...h, apiKey, token, withMission };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function escalate(h: Ctx, key: string, amount = 38_000) {
  const res = await request(h.app)
    .post("/transactions")
    .set({ Authorization: `Bearer ${h.token}`, "Idempotency-Key": key })
    .send({
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: amount }),
      counterparty: "acme-airlines",
      ...(h.withMission ? { missionId: "mission-1" } : {}),
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision.verdict, "escalate");
  return res;
}

const approve = (h: Ctx, id: string, reason = "Verified with the traveller", apiKey = h.apiKey) =>
  request(h.app).post(`/escalations/${id}/approve`).set(auth(apiKey)).send({ reason });
const reject = (h: Ctx, id: string, reason = "Not part of the trip", apiKey = h.apiKey) =>
  request(h.app).post(`/escalations/${id}/reject`).set(auth(apiKey)).send({ reason });

function kinds(h: Ctx, kind: string) {
  return h.deps.ledger.listByAgent("agent-root").filter((e) => e.kind === kind);
}
const reserved = (h: Ctx) => h.deps.missions.get("mission-1")!.reservedMinorUnits;

describe("an escalated transaction becomes a pending escalation", () => {
  test("/transactions returns an escalation handle, ledgers escalation_opened, holds no budget and calls no rail", async () => {
    const h = await setup();
    const res = await escalate(h, "k1");
    assert.equal(res.body.escalation.status, "pending");
    assert.match(res.body.escalation.escalationId, /^esc_/);
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(reserved(h), 0, "nothing is reserved while an escalation is pending");
    const opened = kinds(h, LEDGER_KIND_ESCALATION_OPENED);
    assert.equal(opened.length, 1);
    assert.equal((opened[0]!.data as { escalationId: string }).escalationId, res.body.escalation.escalationId);

    const detail = await request(h.app).get(`/escalations/${res.body.escalation.escalationId}`).set(auth(h.apiKey));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "pending");
    assert.equal(detail.body.transaction.amountMinorUnits, 38_000);
    assert.equal(detail.body.risk.intentJudgment.verdict, "ambiguous", "the operator sees the evidence behind the escalation");
  });

  test("a retry with the same Idempotency-Key replays the same escalation — it never opens a second one", async () => {
    const h = await setup();
    const first = await escalate(h, "dup");
    const second = await escalate(h, "dup");
    assert.equal(second.body.escalation.escalationId, first.body.escalation.escalationId);
    assert.equal((await request(h.app).get("/escalations").set(auth(h.apiKey))).body.escalations.length, 1);
  });

  test("/simulate never opens an escalation", async () => {
    const h = await setup();
    const res = await request(h.app)
      .post("/simulate")
      .set({ Authorization: `Bearer ${h.token}` })
      .send({ transaction: defaultTransaction({ category: "flights" }), counterparty: "acme-airlines", missionId: "mission-1" });
    assert.equal(res.body.decision.verdict, "escalate");
    assert.equal(res.body.escalation, undefined);
    assert.equal((await request(h.app).get("/escalations").set(auth(h.apiKey))).body.escalations.length, 0);
  });

  test("an allowed or denied transaction opens no escalation", async () => {
    const h = buildHarness();
    const apiKey = (await request(h.app).post("/principals").send({ principalId: "p" })).body.apiKey as string;
    const token = (await request(h.app).post("/agents").set(auth(apiKey)).send({ agentId: "a", delegatedGoal: "g", caveats: defaultCaveats() })).body.token;
    const res = await request(h.app).post("/transactions").set({ Authorization: `Bearer ${token}`, "Idempotency-Key": "x" }).send({ transaction: defaultTransaction(), counterparty: "c" });
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.escalation, undefined);
  });
});

describe("authorized approval", () => {
  test("executes exactly once through the rail, settles against the mission budget, and is fully ledgered", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;

    const res = await approve(h, escalationId, "Verified with the traveller");
    assert.equal(res.status, 200);
    assert.equal(res.body.escalation.status, "approved");
    assert.equal(res.body.escalation.resolvedBy, "acme-corp");
    assert.equal(res.body.escalation.resolutionReason, "Verified with the traveller");
    assert.equal(res.body.escalation.outcome, "settled");
    assert.equal(res.body.execution.success, true);

    assert.equal(h.stripeRail.calls.length, 1);
    assert.equal(h.stripeRail.calls[0]!.idempotencyKey, escalationExecutionKey(escalationId), "the rail sees a stable key derived from the escalation");
    assert.equal(h.stripeRail.calls[0]!.amountMinorUnits, 38_000);

    const resolved = kinds(h, LEDGER_KIND_ESCALATION_RESOLVED);
    assert.equal(resolved.length, 1);
    const data = resolved[0]!.data as Record<string, unknown>;
    assert.equal(data.decision, "approve");
    assert.equal(data.resolvedBy, "acme-corp");
    assert.equal(data.reason, "Verified with the traveller");
    assert.equal(typeof data.resolvedAt, "string");
    const exec = kinds(h, LEDGER_KIND_EXECUTION_RESULT);
    assert.equal(exec.length, 1);
    assert.equal((exec[0]!.data as { escalationId: string }).escalationId, escalationId);

    const mission = (await request(h.app).get("/missions/mission-1").set(auth(h.apiKey))).body;
    assert.equal(mission.spentMinorUnits, 38_000);
    assert.equal(mission.reservedMinorUnits, 0);
    assert.equal(mission.remainingMinorUnits, 162_000);

    assert.equal((await request(h.app).get("/ledger").set(auth(h.apiKey))).body.chainValid, true);
  });

  test("works for a mission-less agent (no reservation involved)", async () => {
    const h = await setup({ mission: false });
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const res = await approve(h, escalationId);
    assert.equal(res.status, 200);
    assert.equal(res.body.escalation.outcome, "settled");
    assert.equal(h.stripeRail.calls.length, 1);
  });

  test("the agent can poll its own escalation's status with its token — and sees the outcome but not who decided", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const poll = () => request(h.app).get(`/transactions/escalations/${escalationId}`).set({ Authorization: `Bearer ${h.token}` });
    assert.equal((await poll()).body.status, "pending");
    await approve(h, escalationId);
    const after = await poll();
    assert.equal(after.body.status, "approved");
    assert.equal(after.body.outcome, "settled");
    assert.equal("resolvedBy" in after.body, false);
  });

  test("a rail failure after approval is recorded as 'failed': nothing is spent and the reservation is returned", async () => {
    const failing = new RecordingRailAdapter("stripe_test", () => ({ success: false, rail: "stripe_test", reference: "", settledAt: new Date().toISOString(), error: "card declined" }));
    const h = await setup();
    h.deps.rails = createRailRegistry([failing]);
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const res = await approve(h, escalationId);
    assert.equal(res.status, 200);
    assert.equal(res.body.escalation.outcome, "failed");
    assert.equal(failing.calls.length, 1);
    assert.equal(reserved(h), 0);
    assert.equal((await request(h.app).get("/missions/mission-1").set(auth(h.apiKey))).body.spentMinorUnits, 0);
    // The same escalation can never be re-executed to "retry" the failed payment.
    assert.equal((await approve(h, escalationId)).body.replayed, true);
    assert.equal(failing.calls.length, 1);
  });
});

describe("unauthorized resolution", () => {
  test("no credential, a bad key, and the AGENT'S OWN capability token are all rejected with 401 — an agent cannot approve its own escalation", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    for (const action of ["approve", "reject"] as const) {
      const none = await request(h.app).post(`/escalations/${escalationId}/${action}`).send({ reason: "x" });
      assert.equal(none.status, 401);
      const bad = await request(h.app).post(`/escalations/${escalationId}/${action}`).set(auth("nope")).send({ reason: "x" });
      assert.equal(bad.status, 401);
      const agentToken = await request(h.app).post(`/escalations/${escalationId}/${action}`).set(auth(h.token)).send({ reason: "self-approval" });
      assert.equal(agentToken.status, 401, `agent token must not be accepted on /${action}`);
    }
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.escalations.get(escalationId)!.status, "pending");
  });

  test("another principal gets 404 (indistinguishable from a missing id) on read, approve and reject — and nothing changes", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const otherKey = (await request(h.app).post("/principals").send({ principalId: "rival" })).body.apiKey as string;
    assert.equal((await request(h.app).get(`/escalations/${escalationId}`).set(auth(otherKey))).status, 404);
    assert.equal((await approve(h, escalationId, "x", otherKey)).status, 404);
    assert.equal((await reject(h, escalationId, "x", otherKey)).status, 404);
    assert.equal((await approve(h, "esc_does-not-exist")).status, 404);
    assert.equal((await request(h.app).get("/escalations").set(auth(otherKey))).body.escalations.length, 0);
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(h.deps.escalations.get(escalationId)!.status, "pending");
  });

  test("another agent's token cannot read this agent's escalation status", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const other = await request(h.app).post("/agents").set(auth(h.apiKey)).send({ agentId: "agent-2", delegatedGoal: "g", caveats: defaultCaveats() });
    const res = await request(h.app).get(`/transactions/escalations/${escalationId}`).set({ Authorization: `Bearer ${other.body.token}` });
    assert.equal(res.status, 404);
  });

  test("a reason is required (and bounded): approval/rejection without one is a 400 and changes nothing", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    assert.equal((await request(h.app).post(`/escalations/${escalationId}/approve`).set(auth(h.apiKey)).send({})).status, 400);
    assert.equal((await approve(h, escalationId, "   ")).status, 400);
    assert.equal((await reject(h, escalationId, "x".repeat(501))).status, 400);
    assert.equal(h.deps.escalations.get(escalationId)!.status, "pending");
    assert.equal(h.stripeRail.calls.length, 0);
  });
});

describe("rejection", () => {
  test("a rejected transaction never reaches the rail, is ledgered with the operator's identity and reason, and cannot be approved afterwards", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const res = await reject(h, escalationId, "Not part of the trip");
    assert.equal(res.status, 200);
    assert.equal(res.body.escalation.status, "rejected");
    assert.equal(res.body.escalation.resolvedBy, "acme-corp");
    assert.equal(res.body.escalation.outcome, null);

    const entry = kinds(h, LEDGER_KIND_ESCALATION_RESOLVED)[0]!.data as Record<string, unknown>;
    assert.equal(entry.decision, "reject");
    assert.equal(entry.resolvedBy, "acme-corp");
    assert.equal(entry.reason, "Not part of the trip");

    const late = await approve(h, escalationId);
    assert.equal(late.status, 409);
    assert.match(late.body.error, /already rejected/);
    assert.equal(h.stripeRail.calls.length, 0);
    assert.equal(kinds(h, LEDGER_KIND_EXECUTION_RESULT).length, 0);
    assert.equal(reserved(h), 0);
  });

  test("retrying the rejected request does not execute it: the same Idempotency-Key replays the cached escalation, and a fresh key is a fresh evaluation that escalates again", async () => {
    const h = await setup();
    const first = await escalate(h, "k1");
    await reject(h, first.body.escalation.escalationId);
    const replay = await escalate(h, "k1");
    assert.equal(replay.body.escalation.escalationId, first.body.escalation.escalationId);
    const fresh = await escalate(h, "k2");
    assert.notEqual(fresh.body.escalation.escalationId, first.body.escalation.escalationId);
    assert.equal(h.stripeRail.calls.length, 0);
  });
});

describe("duplicate and conflicting resolutions", () => {
  test("approving twice is idempotent: the second call reports the same state and the rail is called exactly once", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const a = await approve(h, escalationId);
    const b = await approve(h, escalationId);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.body.replayed, true);
    assert.equal(h.stripeRail.calls.length, 1);
    assert.equal(kinds(h, LEDGER_KIND_ESCALATION_RESOLVED).length, 1);
    assert.equal(kinds(h, LEDGER_KIND_EXECUTION_RESULT).length, 1);
  });

  test("rejecting twice is idempotent", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    await reject(h, escalationId);
    const again = await reject(h, escalationId);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(kinds(h, LEDGER_KIND_ESCALATION_RESOLVED).length, 1);
  });

  test("conflicting resolutions: reject after approve and approve after reject are both 409, and the first decision stands", async () => {
    const h = await setup();
    const a = (await escalate(h, "a")).body.escalation.escalationId;
    await approve(h, a);
    const rejectAfter = await reject(h, a);
    assert.equal(rejectAfter.status, 409);
    assert.equal(h.deps.escalations.get(a)!.status, "approved");

    const b = (await escalate(h, "b")).body.escalation.escalationId;
    await reject(h, b);
    assert.equal((await approve(h, b)).status, 409);
    assert.equal(h.deps.escalations.get(b)!.status, "rejected");
    assert.equal(h.stripeRail.calls.length, 1, "only the approved one ever executed");
  });

  test("concurrent approve + approve + reject for one escalation: exactly one decision wins, and the rail is called at most once", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const results = await Promise.all([approve(h, escalationId), approve(h, escalationId), reject(h, escalationId), approve(h, escalationId)]);
    const final = h.deps.escalations.get(escalationId)!;
    assert.ok(final.status === "approved" || final.status === "rejected");
    assert.equal(kinds(h, LEDGER_KIND_ESCALATION_RESOLVED).length, 1, "exactly one resolution is ever recorded");
    assert.equal(h.stripeRail.calls.length, final.status === "approved" ? 1 : 0);
    for (const r of results) assert.ok([200, 409].includes(r.status), `unexpected status ${r.status}`);
    assert.equal(reserved(h), 0);
  });
});

describe("approval is refused when authority has gone away (the escalation stays pending and can still be rejected)", () => {
  async function assertRefused(h: Ctx, escalationId: string, pattern: RegExp) {
    const res = await approve(h, escalationId);
    assert.equal(res.status, 409);
    assert.match(res.body.error, pattern);
    assert.equal(h.stripeRail.calls.length, 0, "no rail call");
    assert.equal(reserved(h), 0, "no reservation left behind");
    assert.equal(h.deps.escalations.get(escalationId)!.status, "pending");
    assert.equal(kinds(h, LEDGER_KIND_EXECUTION_RESULT).length, 0);
    assert.equal((await reject(h, escalationId, "closing it out")).status, 200, "the operator can still reject");
  }

  test("expired mission (by clock)", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    h.db.prepare("UPDATE missions SET expires_at = ? WHERE mission_id = 'mission-1'").run(new Date(Date.now() - 1000).toISOString());
    await assertRefused(h, escalationId, /no longer active.*expired/);
  });

  test("cancelled mission", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    assert.equal((await request(h.app).post("/missions/mission-1/cancel").set(auth(h.apiKey))).status, 200);
    await assertRefused(h, escalationId, /no longer active.*cancelled/);
  });

  test("revoked capability (the agent was revoked after the escalation opened)", async () => {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    assert.equal((await request(h.app).post("/agents/agent-root/revoke").set(auth(h.apiKey)).send({ reason: "compromised" })).status, 200);
    await assertRefused(h, escalationId, /capability no longer authorizes/);
  });

  test("revoked ancestor: revoking the PARENT of an escalated sub-agent also blocks approval", async () => {
    const h = await setup({ mission: false });
    const child = await request(h.app)
      .post("/agents/agent-root/attenuate")
      .set(auth(h.apiKey))
      .send({ agentId: "agent-child", delegatedGoal: "Book flights", caveats: { ...(h.deps.agents.get("agent-root")!.caveats), maxAmountMinorUnits: 100_000 } });
    assert.equal(child.status, 201);
    const res = await request(h.app)
      .post("/transactions")
      .set({ Authorization: `Bearer ${child.body.token}`, "Idempotency-Key": "c1" })
      .send({ transaction: defaultTransaction({ category: "flights" }), counterparty: "acme-airlines" });
    assert.equal(res.body.decision.verdict, "escalate");
    await request(h.app).post("/agents/agent-root/revoke").set(auth(h.apiKey)).send({ reason: "parent compromised" });
    const out = await approve(h, res.body.escalation.escalationId);
    assert.equal(out.status, 409);
    assert.equal(h.stripeRail.calls.length, 0);
  });

  test("mission-less escalation whose agent has since been assigned a mission (sticky mission binding)", async () => {
    const h = await setup({ mission: false });
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    await request(h.app).post("/missions").set(auth(h.apiKey)).send({
      missionId: "late-mission", agentId: "agent-root", goal: "g", budgetMinorUnits: 100_000, currency: "USD",
      allowedCategories: null, approvedCounterparties: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const res = await approve(h, escalationId);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /mission/i);
    assert.equal(h.stripeRail.calls.length, 0);
  });
});

describe("the last-moment recheck inside executeApprovedEscalation (approval followed by a revocation / mission change)", () => {
  async function direct() {
    const h = await setup();
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    const rail = new RecordingRailAdapter("stripe_test");
    const input = {
      tokenBase64: h.token,
      rootPublicKey: h.deps.rootPublicKey,
      agentId: "agent-root",
      principalId: "acme-corp",
      delegatedGoal: "g",
      counterparty: "acme-airlines",
      transaction: defaultTransaction({ category: "flights" }) as never,
      escalationId,
      approvedBy: "acme-corp",
    };
    const deps = { revocationStore: h.deps.revocationStore, ledger: h.deps.ledger, intentJudge: h.deps.intentJudge, rails: createRailRegistry([rail]) };
    return { h, rail, input, deps };
  }

  test("control: with authority intact the rail is called once, under the escalation-derived key", async () => {
    const { rail, input, deps } = await direct();
    const result = await executeApprovedEscalation(input, deps);
    assert.equal(result.blocked, false);
    assert.equal(rail.calls.length, 1);
    assert.equal(rail.calls[0]!.idempotencyKey, `escalation:${input.escalationId}`);
  });

  test("a revocation that lands after the operator's decision but before the rail withdraws the execution and ledgers it", async () => {
    const { h, rail, input, deps } = await direct();
    await request(h.app).post("/agents/agent-root/revoke").set(auth(h.apiKey)).send({ reason: "revoked right after approval" });
    const result = await executeApprovedEscalation(input, deps);
    assert.equal(result.blocked, true);
    assert.equal(rail.calls.length, 0);
    const entry = h.deps.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_PRE_EXECUTION_RECHECK).at(-1)!.data as Record<string, unknown>;
    assert.equal(entry.originalVerdict, "escalate");
    assert.equal(entry.stage, "capability");
    assert.equal(entry.escalationId, input.escalationId);
  });

  test("a failing preExecutionGuard (mission closed) withdraws the execution; a throwing guard fails closed", async () => {
    const { h, rail, input, deps } = await direct();
    const closed = await executeApprovedEscalation(input, { ...deps, preExecutionGuard: () => ({ ok: false, reason: "mission cancelled" }) });
    assert.equal(closed.blocked, true);
    const thrown = await executeApprovedEscalation(input, {
      ...deps,
      preExecutionGuard: () => {
        throw new Error("boom");
      },
    });
    assert.equal(thrown.blocked, true);
    assert.equal(rail.calls.length, 0);
    assert.ok(h.deps.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_PRE_EXECUTION_RECHECK).length >= 2);
  });
});

describe("budget correctness across approvals", () => {
  test("two escalations that each fit the budget but not together: the second approval is refused for budget, stays pending, and the first's spend is intact", async () => {
    const h = await setup({ mission: { budget: 60_000 } });
    const a = (await escalate(h, "a", 38_000)).body.escalation.escalationId;
    const b = (await escalate(h, "b", 38_000)).body.escalation.escalationId;
    assert.equal(reserved(h), 0, "pending escalations hold no budget");
    assert.equal((await approve(h, a)).status, 200);
    const second = await approve(h, b);
    assert.equal(second.status, 409);
    assert.match(second.body.error, /exceed the mission's remaining budget/);
    assert.equal(h.deps.escalations.get(b)!.status, "pending");
    assert.equal(h.stripeRail.calls.length, 1);
    const mission = (await request(h.app).get("/missions/mission-1").set(auth(h.apiKey))).body;
    assert.equal(mission.spentMinorUnits, 38_000);
    assert.equal(mission.reservedMinorUnits, 0);
  });

  test("concurrent approvals of two escalations racing for the same budget never overspend it", async () => {
    const h = await setup({ mission: { budget: 60_000 } });
    const a = (await escalate(h, "a", 38_000)).body.escalation.escalationId;
    const b = (await escalate(h, "b", 38_000)).body.escalation.escalationId;
    const [ra, rb] = await Promise.all([approve(h, a), approve(h, b)]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
    assert.equal(h.stripeRail.calls.length, 1);
    const mission = (await request(h.app).get("/missions/mission-1").set(auth(h.apiKey))).body;
    assert.ok(mission.spentMinorUnits <= 60_000);
    assert.equal(mission.reservedMinorUnits, 0);
  });
});

describe("crash recovery: an approved escalation is never re-executed", () => {
  test("an approved row with no recorded outcome becomes 'indeterminate' at startup; its reservation stays held (fail closed), and approving again does nothing", async () => {
    const h = await setup({ mission: { budget: 100_000 } });
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    // Simulate a process that died right after approval and the budget reservation, before the rail outcome was recorded.
    assert.equal(h.deps.reservations.reserve("mission-1", 38_000, escalationExecutionKey(escalationId)).kind, "reserved");
    assert.equal(h.deps.escalations.resolve(escalationId, "approved", "acme-corp", "approved just before the crash"), true);
    assert.equal(reserved(h), 38_000);

    // "Restart": construct the stores again over the same database.
    const restartedEscalations = createEscalationStore(h.db);
    createSqliteMissionReservationStore(h.db);
    const after = restartedEscalations.get(escalationId)!;
    assert.equal(after.outcome, "indeterminate");
    assert.equal(reserved(h), 38_000, "the amount stays reserved: the rail may have been reached");
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM mission_reservation_tickets WHERE scoped_key = ?").get(escalationExecutionKey(escalationId))!.n, 0);

    const again = await approve(h, escalationId);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(h.stripeRail.calls.length, 0, "never re-executed");
  });

  test("a reservation taken for an escalation that was still pending when the process died is simply returned", async () => {
    const h = await setup({ mission: { budget: 100_000 } });
    const { escalationId } = (await escalate(h, "k1")).body.escalation;
    assert.equal(h.deps.reservations.reserve("mission-1", 38_000, escalationExecutionKey(escalationId)).kind, "reserved");
    createSqliteMissionReservationStore(h.db); // restart
    assert.equal(reserved(h), 0);
    assert.equal(h.deps.escalations.get(escalationId)!.status, "pending");
  });
});

describe("listing", () => {
  test("GET /escalations lists only the caller's, filters by status, and rejects an unknown status", async () => {
    const h = await setup();
    const a = (await escalate(h, "a")).body.escalation.escalationId;
    const b = (await escalate(h, "b")).body.escalation.escalationId;
    await reject(h, a);
    const list = async (q = "") => (await request(h.app).get(`/escalations${q}`).set(auth(h.apiKey))).body.escalations as Array<{ escalationId: string }>;
    assert.equal((await list()).length, 2);
    assert.deepEqual((await list("?status=pending")).map((e) => e.escalationId), [b]);
    assert.deepEqual((await list("?status=rejected")).map((e) => e.escalationId), [a]);
    assert.equal((await request(h.app).get("/escalations?status=bogus").set(auth(h.apiKey))).status, 400);
  });
});
