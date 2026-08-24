import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

import { StripeTestRailAdapter, type StripePaymentIntentsClient } from "../stripeTestRail.js";
import type { RailExecutionRequest } from "../types.js";

function baseRequest(overrides: Partial<RailExecutionRequest> = {}): RailExecutionRequest {
  return {
    agentId: "agent-flights",
    principalId: "principal-1",
    amountMinorUnits: 38_000,
    currency: "USD",
    category: "flights",
    counterparty: "acme-airlines",
    purpose: "Round-trip flight for Q3 conference",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function fakeClient(
  respond: (params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions) => Promise<Partial<Stripe.PaymentIntent>>
): StripePaymentIntentsClient & { calls: Array<{ params: Stripe.PaymentIntentCreateParams; options?: Stripe.RequestOptions }> } {
  const calls: Array<{ params: Stripe.PaymentIntentCreateParams; options?: Stripe.RequestOptions }> = [];
  return {
    calls,
    async create(params, options) {
      calls.push({ params, options });
      return (await respond(params, options)) as Stripe.Response<Stripe.PaymentIntent>;
    },
  };
}

describe("StripeTestRailAdapter — construction safety", () => {
  test("refuses to construct with a live secret key", () => {
    assert.throws(() => new StripeTestRailAdapter({ apiKey: "sk_live_abc123" }), /TEST key/);
  });

  test("refuses to construct with a live restricted key", () => {
    assert.throws(() => new StripeTestRailAdapter({ apiKey: "rk_live_abc123" }), /TEST key/);
  });

  test("refuses to construct with no key, no client, and no env var", () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.throws(() => new StripeTestRailAdapter({}));
    } finally {
      if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved;
    }
  });

  test("accepts an injected client without requiring any key at all", () => {
    const client = fakeClient(async () => ({ id: "pi_x", status: "succeeded" }));
    assert.doesNotThrow(() => new StripeTestRailAdapter({ client }));
  });
});

describe("StripeTestRailAdapter — execution semantics", () => {
  test("reports success only when the PaymentIntent status is exactly 'succeeded'", async () => {
    const client = fakeClient(async () => ({ id: "pi_123", status: "succeeded" }));
    const adapter = new StripeTestRailAdapter({ client });

    const result = await adapter.execute(baseRequest());
    assert.equal(result.success, true);
    assert.equal(result.reference, "pi_123");
    assert.equal(result.rail, "stripe_test");
  });

  test("reports failure — not success — when the PaymentIntent requires further action", async () => {
    const client = fakeClient(async () => ({ id: "pi_456", status: "requires_action" }));
    const adapter = new StripeTestRailAdapter({ client });

    const result = await adapter.execute(baseRequest());
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /requires_action/);
    assert.equal(result.reference, "pi_456", "the reference should still be captured even on a non-succeeded outcome");
  });

  test("reports failure — not an uncaught throw — when the Stripe client rejects", async () => {
    const client = fakeClient(async () => {
      throw new Error("card_declined");
    });
    const adapter = new StripeTestRailAdapter({ client });

    const result = await adapter.execute(baseRequest());
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /card_declined/);
  });

  test("passes the exact authorized amount and currency through to Stripe, in minor units", async () => {
    const client = fakeClient(async () => ({ id: "pi_1", status: "succeeded" }));
    const adapter = new StripeTestRailAdapter({ client });

    await adapter.execute(baseRequest({ amountMinorUnits: 12_345, currency: "USD" }));
    assert.equal(client.calls[0]?.params.amount, 12_345);
    assert.equal(client.calls[0]?.params.currency, "usd");
  });

  test("passes the idempotency key through as a request option, not as a body parameter", async () => {
    const client = fakeClient(async () => ({ id: "pi_1", status: "succeeded" }));
    const adapter = new StripeTestRailAdapter({ client });

    await adapter.execute(baseRequest({ idempotencyKey: "unique-attempt-42" }));
    assert.equal(client.calls[0]?.options?.idempotencyKey, "unique-attempt-42");
  });

  test("confirms the payment synchronously off-session rather than creating an unconfirmed intent", async () => {
    const client = fakeClient(async () => ({ id: "pi_1", status: "succeeded" }));
    const adapter = new StripeTestRailAdapter({ client });

    await adapter.execute(baseRequest());
    assert.equal(client.calls[0]?.params.confirm, true);
    assert.equal(client.calls[0]?.params.off_session, true);
  });

  test("carries agent/principal/category/counterparty into metadata for audit correlation", async () => {
    const client = fakeClient(async () => ({ id: "pi_1", status: "succeeded" }));
    const adapter = new StripeTestRailAdapter({ client });

    await adapter.execute(baseRequest({ agentId: "agent-x", principalId: "principal-y" }));
    assert.deepEqual(client.calls[0]?.params.metadata, {
      agentId: "agent-x",
      principalId: "principal-y",
      category: "flights",
      counterparty: "acme-airlines",
    });
  });
});
