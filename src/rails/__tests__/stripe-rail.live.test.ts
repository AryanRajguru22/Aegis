import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { StripeTestRailAdapter } from "../stripeTestRail.js";

/**
 * The only test in this repo that makes a real call to Stripe. Opt-in, skipped
 * automatically unless STRIPE_SECRET_KEY is set to a recognizable test key — run
 * explicitly with `npm run test:rails:live` once a Stripe test-mode key is available.
 * Everything else about this adapter (status handling, idempotency, metadata,
 * the live-key safety guard) is proven without network access in stripe-rail.test.ts.
 */
const apiKey = process.env.STRIPE_SECRET_KEY;
const hasTestKey = Boolean(apiKey && (apiKey.startsWith("sk_test_") || apiKey.startsWith("rk_test_")));

describe("StripeTestRailAdapter (live)", { skip: !hasTestKey && "STRIPE_SECRET_KEY is not set to a test key — skipping live Stripe calls" }, () => {
  test("actually settles a PaymentIntent against Stripe test mode", async () => {
    const adapter = new StripeTestRailAdapter({ apiKey });
    const result = await adapter.execute({
      agentId: "agent-flights",
      principalId: "principal-1",
      amountMinorUnits: 3_800,
      currency: "USD",
      category: "flights",
      counterparty: "acme-airlines",
      purpose: "Live Stripe test-mode smoke test",
      idempotencyKey: `live-test-${Date.now()}`,
    });

    if (!result.success) {
      throw new Error(`Stripe live test failed: ${result.error}`);
    }
    assert.equal(result.success, true);
    assert.match(result.reference, /^pi_/);
  });
});
