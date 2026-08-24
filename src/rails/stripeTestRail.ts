import Stripe from "stripe";
import type { RailAdapter, RailExecutionRequest, RailExecutionResult } from "./types.js";

/**
 * The minimal subset of the Stripe SDK this adapter actually calls. A real `Stripe`
 * client's `.paymentIntents` satisfies this structurally, so production code just
 * passes an API key; tests inject a fake object matching this narrow interface
 * instead of constructing a real Stripe client or hitting the network — see
 * src/rails/__tests__/stripe-rail.test.ts.
 */
export interface StripePaymentIntentsClient {
  create(
    params: Stripe.PaymentIntentCreateParams,
    options?: Stripe.RequestOptions
  ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
}

export interface StripeTestRailAdapterOptions {
  apiKey?: string;
  /** Inject a fake client for testing instead of constructing a real Stripe instance from apiKey. Mutually exclusive with apiKey in practice — if both are given, client wins. */
  client?: StripePaymentIntentsClient;
  /** Stripe's documented test-mode payment method that always succeeds. Overridable so tests can exercise other test tokens (e.g. ones that decline). */
  testPaymentMethod?: string;
}

const STRIPE_ALWAYS_SUCCEEDS_TEST_PAYMENT_METHOD = "pm_card_visa";

/**
 * A real card-network rail, via Stripe's test mode — PaymentIntent-shaped, confirmed
 * synchronously with a test payment method. This is deliberately one of two
 * structurally different rails in the MVP (see docs/DIFFERENTIATION.md §3.1): a
 * request/response REST API with server-side idempotency keys, as opposed to
 * mockX402's HTTP-native, client-signed paywall handshake. Both are driven through
 * the exact same RailAdapter interface and the same execution orchestrator
 * (src/execution) — that is the rail-agnosticism claim, proven rather than asserted.
 */
export class StripeTestRailAdapter implements RailAdapter {
  readonly railId = "stripe_test";
  private readonly client: StripePaymentIntentsClient;
  private readonly testPaymentMethod: string;

  constructor(opts: StripeTestRailAdapterOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.STRIPE_SECRET_KEY;
      if (!apiKey) {
        throw new Error(
          "StripeTestRailAdapter requires a Stripe API key: pass { apiKey } or { client }, or set STRIPE_SECRET_KEY."
        );
      }
      if (!apiKey.startsWith("sk_test_") && !apiKey.startsWith("rk_test_")) {
        // Hard safety guard, not just documentation: this adapter is built, tested,
        // and demoed as test-mode-only (docs/MVP_SCOPE.md). Refuse to construct at all
        // with anything that isn't recognizably a Stripe TEST key, rather than risk
        // this MVP rail ever moving real money because a live key ended up in an
        // environment variable by accident.
        throw new Error(
          'StripeTestRailAdapter refuses to use a key that is not a Stripe TEST key (expected an "sk_test_" or "rk_test_" prefix). This adapter is test-mode only by design.'
        );
      }
      this.client = new Stripe(apiKey).paymentIntents;
    }
    this.testPaymentMethod = opts.testPaymentMethod ?? STRIPE_ALWAYS_SUCCEEDS_TEST_PAYMENT_METHOD;
  }

  async execute(request: RailExecutionRequest): Promise<RailExecutionResult> {
    try {
      const paymentIntent = await this.client.create(
        {
          amount: request.amountMinorUnits,
          currency: request.currency.toLowerCase(),
          payment_method: this.testPaymentMethod,
          confirm: true,
          off_session: true,
          description: request.purpose,
          metadata: {
            agentId: request.agentId,
            principalId: request.principalId,
            category: request.category,
            counterparty: request.counterparty,
          },
        },
        { idempotencyKey: request.idempotencyKey }
      );

      if (paymentIntent.status !== "succeeded") {
        // A PaymentIntent that comes back in any other state (requires_action,
        // requires_payment_method, processing, ...) is not a settled payment. Reporting
        // this as anything but a failure would be the single easiest way to make this
        // adapter lie about whether money actually moved.
        return {
          success: false,
          rail: this.railId,
          reference: paymentIntent.id,
          settledAt: new Date().toISOString(),
          error: `PaymentIntent ended in status "${paymentIntent.status}", not "succeeded"`,
          raw: paymentIntent,
        };
      }

      return {
        success: true,
        rail: this.railId,
        reference: paymentIntent.id,
        settledAt: new Date().toISOString(),
        raw: paymentIntent,
      };
    } catch (error) {
      return {
        success: false,
        rail: this.railId,
        reference: "",
        settledAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
