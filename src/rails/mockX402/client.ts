import type { KeyObject } from "node:crypto";
import type { RailAdapter, RailExecutionRequest, RailExecutionResult } from "../types.js";
import { signPayment, type PaymentPayload, type PaymentRequirements } from "./protocol.js";

export interface MockX402RailAdapterOptions {
  baseUrl: string;
  /** The signing key standing in for this agent's/principal's payment wallet on this rail. In this MVP one key is used per adapter instance rather than per-agent wallet lookup — a named simplification, not a claim of per-agent wallet management. */
  privateKey: KeyObject;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Known limitation, stated rather than hidden: unlike the Stripe rail, this adapter
 * does not use RailExecutionRequest.idempotencyKey to dedupe retries — each attempt
 * fetches a fresh quote (a fresh nonce) and pays it, so a network-level retry of a
 * successful payment would pay twice. The protocol's own replay protection (a nonce
 * can only be redeemed once) prevents a resubmitted *identical* payment from
 * double-charging, but it does not prevent the adapter itself from requesting and
 * paying a *new* quote on retry. A production version would need idempotency
 * tracking at this layer too — out of scope for the isolated core proven here.
 */
export class MockX402RailAdapter implements RailAdapter {
  readonly railId = "mock_x402";
  private readonly baseUrl: string;
  private readonly privateKey: KeyObject;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: MockX402RailAdapterOptions) {
    this.baseUrl = opts.baseUrl;
    this.privateKey = opts.privateKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async execute(request: RailExecutionRequest): Promise<RailExecutionResult> {
    const resource = `${request.counterparty}:${request.category}`;
    try {
      const quoteResponse = await this.post({ resource });
      if (quoteResponse.status !== 402) {
        return this.failure(
          `Expected an HTTP 402 payment-required quote, got ${quoteResponse.status}`,
          await safeJson(quoteResponse)
        );
      }
      const requirements = (await quoteResponse.json()) as PaymentRequirements;

      if (requirements.amountMinorUnits !== request.amountMinorUnits || requirements.currency !== request.currency) {
        // Defense-in-depth, not merchant trust: never pay more (or in a different
        // currency) than what Aegis's policy and risk engines already approved, even
        // if the counterparty's own quote says otherwise.
        return this.failure(
          `Counterparty quoted ${requirements.amountMinorUnits} ${requirements.currency}, which does not match the ${request.amountMinorUnits} ${request.currency} this transaction was authorized for — refusing to pay`,
          requirements
        );
      }

      const unsigned = {
        resource: requirements.resource,
        amountMinorUnits: requirements.amountMinorUnits,
        currency: requirements.currency,
        payTo: requirements.payTo,
        nonce: requirements.nonce,
        payer: request.agentId,
      };
      const payload: PaymentPayload = { ...unsigned, signature: signPayment(this.privateKey, unsigned) };

      const paymentResponse = await this.post(
        { resource },
        { "X-PAYMENT": Buffer.from(JSON.stringify(payload), "utf8").toString("base64") }
      );
      const body = await safeJson(paymentResponse);

      if (paymentResponse.status !== 200) {
        const errorMessage =
          typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "unknown error";
        return this.failure(`Payment rejected (HTTP ${paymentResponse.status}): ${errorMessage}`, body);
      }

      const receipt = body as { reference: string; settledAt: string };
      return { success: true, rail: this.railId, reference: receipt.reference, settledAt: receipt.settledAt, raw: receipt };
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }

  private failure(error: string, raw?: unknown): RailExecutionResult {
    return { success: false, rail: this.railId, reference: "", settledAt: new Date().toISOString(), error, raw };
  }

  private async post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
