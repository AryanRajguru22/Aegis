import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { buildHarness, defaultCaveats, defaultTransaction, ScriptedIntentJudge } from "./harness.js";

async function createPrincipalAndAgent(app: import("express").Express, caveats = defaultCaveats()) {
  const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
  const apiKey: string = principalRes.body.apiKey;
  const agentRes = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId: "agent-root", delegatedGoal: "Book the cheapest flights and hotels for our Q3 conferences.", caveats });
  const token: string = agentRes.body.token;
  return { apiKey, token };
}

describe("POST /simulate", () => {
  test("rejects a request with no Authorization header", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/simulate").send({ transaction: defaultTransaction() });
    assert.equal(res.status, 401);
  });

  test("rejects a malformed transaction body", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send({ transaction: { amountMinorUnits: "not-a-number" } });
    assert.equal(res.status, 400);
  });

  test("rejects a request body with no transaction field at all", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send({});
    assert.equal(res.status, 400);
  });

  test("an allowed transaction returns verdict allow and does not execute anything", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send({ transaction: defaultTransaction() });
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.decision.execution, undefined, "/simulate must never include an execution result");
  });

  test("a policy-violating transaction (over the cap) returns verdict deny as a normal 200 response, not an HTTP error", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, defaultCaveats({ maxAmountMinorUnits: 10_000 }));
    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction({ amountMinorUnits: 50_000 }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "deny");
  });

  test("a goal-inconsistent transaction returns verdict escalate", async () => {
    const { app } = buildHarness({ intentJudge: new ScriptedIntentJudge(() => ({ verdict: "inconsistent", rationale: "off-goal" })) });
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send({ transaction: defaultTransaction() });
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "escalate");
  });
});

describe("POST /transactions — deny/escalate never execute (the core security property)", () => {
  test("a denied transaction returns no execution field and never calls the rail adapter", async () => {
    const { app, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, defaultCaveats({ maxAmountMinorUnits: 10_000 }));

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction({ amountMinorUnits: 50_000 }), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(res.body.execution, undefined);
    assert.equal(stripeRail.calls.length, 0);
  });

  test("an escalated transaction returns no execution field and never calls the rail adapter", async () => {
    const { app, stripeRail } = buildHarness({ intentJudge: new ScriptedIntentJudge(() => ({ verdict: "ambiguous", rationale: "unclear" })) });
    const { token } = await createPrincipalAndAgent(app);

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "escalate");
    assert.equal(res.body.execution, undefined);
    assert.equal(stripeRail.calls.length, 0);
  });

  test("an allowed transaction executes exactly once and reports success", async () => {
    const { app, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, true);
    assert.equal(stripeRail.calls.length, 1);
  });
});

describe("POST /transactions — validation", () => {
  test("requires an Idempotency-Key header", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Idempotency-Key/);
  });

  test("requires a counterparty field", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction() });
    assert.equal(res.status, 400);
  });

  test("rejects a non-integer amount", async () => {
    const { app } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction({ amountMinorUnits: 199.99 }), counterparty: "acme-airlines" });
    assert.equal(res.status, 400);
  });
});

describe("POST /transactions — idempotency and replay", () => {
  test("replaying the same Idempotency-Key with the same body returns the cached result and does not execute twice", async () => {
    const { app, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const first = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "same-key").send(body);
    const second = await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "same-key").send(body);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body, "a replayed request must return the exact original response");
    assert.equal(stripeRail.calls.length, 1, "the rail adapter must be called exactly once despite two HTTP requests");
  });

  test("reusing the same Idempotency-Key with a DIFFERENT body is rejected as a conflict, not silently executed or silently cached", async () => {
    const { app, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);

    const first = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "reused-key")
      .send({ transaction: defaultTransaction({ amountMinorUnits: 38_000 }), counterparty: "acme-airlines" });
    assert.equal(first.status, 200);

    const second = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "reused-key")
      .send({ transaction: defaultTransaction({ amountMinorUnits: 99_000 }), counterparty: "acme-airlines" });

    assert.equal(second.status, 409);
    assert.equal(stripeRail.calls.length, 1, "the conflicting second request must not have executed anything");
  });

  test("two distinct Idempotency-Keys for logically identical bodies are each executed — a client must opt in per attempt", async () => {
    const { app, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "key-1").send(body);
    await request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "key-2").send(body);

    assert.equal(stripeRail.calls.length, 2);
  });

  test("idempotency keys are scoped per agent — the same key for two different agents does not collide", async () => {
    const { app, stripeRail } = buildHarness();
    const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const apiKey: string = principalRes.body.apiKey;
    const caveats = defaultCaveats();
    const agentA = await request(app).post("/agents").set("Authorization", `Bearer ${apiKey}`).send({ agentId: "agent-a", delegatedGoal: "g", caveats });
    const agentB = await request(app).post("/agents").set("Authorization", `Bearer ${apiKey}`).send({ agentId: "agent-b", delegatedGoal: "g", caveats });

    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };
    const resA = await request(app).post("/transactions").set("Authorization", `Bearer ${agentA.body.token}`).set("Idempotency-Key", "shared-key").send(body);
    const resB = await request(app).post("/transactions").set("Authorization", `Bearer ${agentB.body.token}`).set("Idempotency-Key", "shared-key").send(body);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(stripeRail.calls.length, 2, "both agents' transactions must execute — the idempotency key alone does not collapse across different agents");
  });
});

describe("revoked-agent behavior through the API", () => {
  test("revoking an agent causes its subsequent transactions to be denied, not executed", async () => {
    const { app, stripeRail } = buildHarness();
    const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const apiKey: string = principalRes.body.apiKey;
    const agentRes = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats() });
    const token: string = agentRes.body.token;

    const revokeRes = await request(app).post("/agents/agent-root/revoke").set("Authorization", `Bearer ${apiKey}`).send({ reason: "emergency shutdown" });
    assert.equal(revokeRes.status, 200);

    const txRes = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(txRes.status, 200);
    assert.equal(txRes.body.decision.verdict, "deny");
    assert.match(txRes.body.decision.reason, /revoked/);
    assert.equal(stripeRail.calls.length, 0);
  });

  test("revoking someone else's agent is forbidden", async () => {
    const { app } = buildHarness();
    const principalA = await request(app).post("/principals").send({ principalId: "principal-a" });
    const principalB = await request(app).post("/principals").send({ principalId: "principal-b" });
    await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${principalA.body.apiKey}`)
      .send({ agentId: "agent-a", delegatedGoal: "g", caveats: defaultCaveats() });

    const res = await request(app)
      .post("/agents/agent-a/revoke")
      .set("Authorization", `Bearer ${principalB.body.apiKey}`)
      .send({ reason: "trying to revoke someone else's agent" });
    assert.equal(res.status, 403);
  });

  test("revoking a nonexistent agent is a 404", async () => {
    const { app } = buildHarness();
    const principal = await request(app).post("/principals").send({ principalId: "principal-a" });
    const res = await request(app)
      .post("/agents/does-not-exist/revoke")
      .set("Authorization", `Bearer ${principal.body.apiKey}`)
      .send({ reason: "x" });
    assert.equal(res.status, 404);
  });
});
