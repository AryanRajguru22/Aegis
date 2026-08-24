import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createRailRegistry } from "../../rails/types.js";
import { StripeTestRailAdapter, type StripePaymentIntentsClient } from "../../rails/stripeTestRail.js";
import { startMockX402Server, MockX402RailAdapter, generatePayerKeyPair, publicKeyToHex } from "../../rails/mockX402/index.js";
import { buildHarness, defaultCaveats, defaultTransaction } from "./harness.js";

describe("rail-agnosticism preserved end to end through the API", () => {
  test("a transaction settles on the real mock x402 rail (real HTTP, real signatures) when submitted through POST /transactions", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const mockServer = await startMockX402Server({
      knownPayers: new Map([["agent-root", publicKeyToHex(publicKey)]]),
      priceResolver: (resource) => (resource === "acme-airlines:flights" ? { amountMinorUnits: 38_000, currency: "USD" } : undefined),
    });

    try {
      const mockX402Adapter = new MockX402RailAdapter({ baseUrl: mockServer.url, privateKey });
      const { app, stripeRail } = buildHarness({ rails: createRailRegistry([mockX402Adapter]) });

      const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
      const apiKey: string = principalRes.body.apiKey;
      const agentRes = await request(app)
        .post("/agents")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
      const token: string = agentRes.body.token;

      const res = await request(app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "k1")
        .send({ transaction: defaultTransaction({ rail: "mock_x402" }), counterparty: "acme-airlines" });

      assert.equal(res.status, 200);
      assert.equal(res.body.decision.verdict, "allow");
      assert.equal(res.body.execution.success, true);
      assert.match(res.body.execution.reference, /^mockx402_/);
      assert.equal(stripeRail.calls.length, 0, "the unrelated stripe adapter must not have been touched");
    } finally {
      await mockServer.close();
    }
  });

  test("a transaction settles on the Stripe-shaped rail when submitted through POST /transactions, and both rails write the same ledger entry-kind sequence", async () => {
    const fakeStripeClient: StripePaymentIntentsClient = {
      async create(params) {
        return { id: "pi_api_integration_test", status: "succeeded", amount: params.amount, currency: params.currency } as never;
      },
    };
    const stripeAdapter = new StripeTestRailAdapter({ client: fakeStripeClient });
    const { app } = buildHarness({ rails: createRailRegistry([stripeAdapter]) });

    const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const apiKey: string = principalRes.body.apiKey;
    const agentRes = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
    const token: string = agentRes.body.token;

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction({ rail: "stripe_test" }), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.reference, "pi_api_integration_test");

    const ledgerRes = await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    const kinds = ledgerRes.body.entries.map((e: { kind: string }) => e.kind);
    assert.deepEqual(kinds, ["agent_registered", "policy_verdict", "risk_verdict", "decision", "execution_result"]);
    assert.equal(ledgerRes.body.chainValid, true);
  });

  test("an allowed transaction on a rail with no registered adapter fails closed with a clear error, and is recorded in the ledger", async () => {
    const { app } = buildHarness({ rails: createRailRegistry([]) });

    const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const apiKey: string = principalRes.body.apiKey;
    const agentRes = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats({ rails: ["mock_x402"] }) });
    const token: string = agentRes.body.token;

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction({ rail: "mock_x402" }), counterparty: "acme-airlines" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, false);
    assert.match(res.body.execution.error, /No rail adapter registered/);
  });
});
