import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { buildHarness, defaultCaveats, defaultTransaction, ScriptedIntentJudge } from "./harness.js";
import { ClassifiedJudgeError } from "../../risk/types.js";

async function createPrincipalAndAgent(app: import("express").Express, caveats = defaultCaveats(), agentId = "agent-root") {
  const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
  const apiKey: string = principalRes.body.apiKey;
  const agentRes = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId, delegatedGoal: "Book the cheapest flights and hotels for our Q3 conferences.", caveats });
  const token: string = agentRes.body.token;
  return { apiKey, token };
}

/**
 * Covers the Simulate -> Execute intent-judgment reuse feature at the HTTP layer, and
 * the error-sanitization requirement that a raw provider error/JSON body must never
 * reach an API response. See src/decision/__tests__/simulation-cache.test.ts for the
 * lower-level fingerprint and decideTransaction unit coverage this complements.
 */
describe("POST /simulate then POST /transactions — intent-judgment reuse", () => {
  test("an unchanged transaction reuses the Simulate judgment: the intent judge is called exactly once total", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "Consistent with the delegated goal." }));
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);
    const body = { transaction: defaultTransaction(), counterparty: "acme-airlines" };

    const sim = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send(body);
    assert.equal(sim.status, 200);
    assert.equal(sim.body.decision.verdict, "allow");
    assert.equal(judge.calls.length, 1);

    const exec = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send(body);

    assert.equal(exec.status, 200);
    assert.equal(exec.body.decision.verdict, "allow");
    assert.equal(judge.calls.length, 1, "Execute must reuse the prior Simulate judgment rather than calling the judge a second time");
    assert.equal(exec.body.decision.risk.intentJudgment.reused, true);
    assert.equal(exec.body.execution.success, true, "deterministic execution must still proceed normally on a reused judgment");
  });

  test("changing the amount before Execute invalidates reuse — the judge is called again", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });
    assert.equal(judge.calls.length, 1);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction({ amountMinorUnits: 39_000 }), counterparty: "acme-airlines" });

    assert.equal(judge.calls.length, 2, "a changed amount must invalidate the cached simulation and force a fresh judgment");
  });

  test("changing the category before Execute invalidates reuse", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction({ category: "software" }), counterparty: "acme-airlines" });

    assert.equal(judge.calls.length, 2);
  });

  test("changing the counterparty before Execute invalidates reuse", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction(), counterparty: "a-totally-different-vendor" });

    assert.equal(judge.calls.length, 2);
  });

  test("changing the purpose before Execute invalidates reuse", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction({ purpose: "A materially different stated purpose" }), counterparty: "acme-airlines" });

    assert.equal(judge.calls.length, 2);
  });

  test("a different agent's token (different authority context) never reuses another agent's simulation", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));
    const { app } = buildHarness({ intentJudge: judge });
    const { token: tokenA } = await createPrincipalAndAgent(app, defaultCaveats(), "agent-a");

    const principalRes2 = await request(app).post("/principals").send({ principalId: "beta-corp" });
    const apiKey2: string = principalRes2.body.apiKey;
    const agentB = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey2}`)
      .send({ agentId: "agent-b", delegatedGoal: "Book the cheapest flights and hotels for our Q3 conferences.", caveats: defaultCaveats() });
    const tokenB: string = agentB.body.token;

    await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });
    assert.equal(judge.calls.length, 1);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(judge.calls.length, 2, "a different agent's token must never reuse another agent's cached simulation judgment");
  });

  test("deterministic policy DENY on Execute still wins even though Simulate returned a favorable, cacheable judgment", async () => {
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));
    const { app, stripeRail } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app, defaultCaveats({ maxAmountMinorUnits: 200_000 }));

    const body = { transaction: defaultTransaction({ amountMinorUnits: 38_000 }), counterparty: "acme-airlines" };
    const sim = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send(body);
    assert.equal(sim.body.decision.verdict, "allow");

    // Execute with an amount that now violates policy — reuse must never be
    // possible here since the fingerprint (amount) differs, and even if it were,
    // the deterministic policy check runs first and denies before risk/cache are
    // ever consulted.
    const exec = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction({ amountMinorUnits: 900_000 }), counterparty: "acme-airlines" });

    assert.equal(exec.body.decision.verdict, "deny");
    assert.equal(exec.body.execution, undefined);
    assert.equal(stripeRail.calls.length, 0);
  });
});

describe("provider failures never leak raw error content into API responses", () => {
  test("a 429/quota-shaped failure during /simulate is classified into a safe, static reason — never the raw error text", async () => {
    const rawSensitiveDetail =
      '{"error":{"code":429,"message":"RESOURCE_EXHAUSTED: quota exceeded","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}';
    const judge = new ScriptedIntentJudge(() => {
      throw new ClassifiedJudgeError("quota", `Gemini quota/rate limit exceeded (HTTP 429): ${rawSensitiveDetail}`);
    });
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "escalate", "the existing security result must remain: unavailable -> escalate, never allow");

    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes("RESOURCE_EXHAUSTED"), false, "the raw provider error body must never reach the API response");
    assert.equal(serialized.includes("QuotaFailure"), false);
    assert.equal(serialized.includes("googleapis.com"), false, "no provider URL should ever be exposed");

    assert.equal(res.body.decision.risk.intentJudgment.verdict, "unavailable");
    assert.equal(res.body.decision.risk.intentJudgment.category, "quota");
    assert.match(res.body.decision.risk.intentJudgment.rationale, /quota/i);
    assert.match(res.body.decision.reason, /escalating for human review/i);
  });

  test("a timeout is classified as unavailable -> escalate, with a safe static reason", async () => {
    const judge = new ScriptedIntentJudge(() => new Promise<never>(() => {}));
    const { app } = buildHarness({ intentJudge: judge, judgeTimeoutMs: 40 });
    const { token } = await createPrincipalAndAgent(app);

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "escalate");
    assert.equal(res.body.decision.risk.intentJudgment.category, "timeout");
    assert.match(res.body.decision.risk.intentJudgment.rationale, /timed out/i);
    assert.equal(JSON.stringify(res.body).includes("intent judge timed out after"), false, "the internal diagnostic timeout message must not reach the API response");
  });

  test("a generic/unknown provider failure is classified as unavailable -> escalate, never allow, and never echoes the thrown message", async () => {
    const judge = new ScriptedIntentJudge(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443 — internal upstream host detail");
    });
    const { app } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "escalate");
    assert.equal(JSON.stringify(res.body).includes("ECONNREFUSED"), false, "no internal network/host detail should ever reach the API response");
    assert.equal(JSON.stringify(res.body).includes("10.0.0.1"), false);
  });

  test("a provider failure surfaced during Execute (no prior Simulate) also escalates safely, without leaking raw detail", async () => {
    const judge = new ScriptedIntentJudge(() => {
      throw new ClassifiedJudgeError("provider_unavailable", "Gemini is unavailable (HTTP 503): The model is overloaded, internal trace id abc-123-def");
    });
    const { app, stripeRail } = buildHarness({ intentJudge: judge });
    const { token } = await createPrincipalAndAgent(app);

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attempt-1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "escalate");
    assert.equal(res.body.execution, undefined, "escalated transactions must never execute, even when caused by a provider failure");
    assert.equal(stripeRail.calls.length, 0);
    assert.equal(JSON.stringify(res.body).includes("abc-123-def"), false, "no internal trace id should ever reach the API response");
    assert.equal(JSON.stringify(res.body).includes("overloaded"), false);
  });
});
