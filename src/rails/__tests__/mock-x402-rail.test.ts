import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockX402Server, type MockX402Server, type MockX402ServerOptions } from "../mockX402/server.js";
import { MockX402RailAdapter } from "../mockX402/client.js";
import {
  generatePayerKeyPair,
  publicKeyToHex,
  signPayment,
  type PaymentPayload,
  type PaymentRequirements,
} from "../mockX402/protocol.js";
import type { RailExecutionRequest } from "../types.js";

const AGENT_ID = "agent-flights";
const PRICE = { amountMinorUnits: 38_000, currency: "USD" };

async function withServer(
  opts: Partial<MockX402ServerOptions> & { knownPayers: Map<string, string> },
  fn: (server: MockX402Server) => Promise<void>
): Promise<void> {
  const server = await startMockX402Server({
    priceResolver: (resource) => (resource === "acme-airlines:flights" ? PRICE : undefined),
    ...opts,
  });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

function baseRequest(overrides: Partial<RailExecutionRequest> = {}): RailExecutionRequest {
  return {
    agentId: AGENT_ID,
    principalId: "principal-1",
    amountMinorUnits: PRICE.amountMinorUnits,
    currency: PRICE.currency,
    category: "flights",
    counterparty: "acme-airlines",
    purpose: "Round-trip flight for Q3 conference",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

describe("MockX402RailAdapter — happy path", () => {
  test("pays a correctly-quoted resource and receives a settled receipt", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer({ knownPayers }, async (server) => {
      const adapter = new MockX402RailAdapter({ baseUrl: server.url, privateKey });
      const result = await adapter.execute(baseRequest());

      assert.equal(result.success, true);
      assert.equal(result.rail, "mock_x402");
      assert.match(result.reference, /^mockx402_/);
    });
  });
});

describe("MockX402RailAdapter — client-side defense in depth", () => {
  test("refuses to pay when the counterparty quotes a different amount than what was authorized", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer(
      { knownPayers, priceResolver: () => ({ amountMinorUnits: 999_999, currency: "USD" }) },
      async (server) => {
        const adapter = new MockX402RailAdapter({ baseUrl: server.url, privateKey });
        const result = await adapter.execute(baseRequest());

        assert.equal(result.success, false);
        assert.match(result.error ?? "", /does not match the .* authorized/);
      }
    );
  });

  test("refuses to pay when the counterparty quotes a different currency", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer(
      { knownPayers, priceResolver: () => ({ amountMinorUnits: PRICE.amountMinorUnits, currency: "EUR" }) },
      async (server) => {
        const adapter = new MockX402RailAdapter({ baseUrl: server.url, privateKey });
        const result = await adapter.execute(baseRequest());
        assert.equal(result.success, false);
      }
    );
  });

  test("reports failure (not a thrown exception) for an unknown resource", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer({ knownPayers }, async (server) => {
      const adapter = new MockX402RailAdapter({ baseUrl: server.url, privateKey });
      const result = await adapter.execute(baseRequest({ counterparty: "totally-unknown-vendor" }));
      assert.equal(result.success, false);
    });
  });
});

describe("mock x402 server — protocol-level adversarial cases (raw HTTP, bypassing the adapter)", () => {
  test("rejects a replayed payment for an already-redeemed nonce", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer({ knownPayers }, async (server) => {
      const quoteRes = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(quoteRes.status, 402);
      const requirements = (await quoteRes.json()) as PaymentRequirements;

      const unsigned = {
        resource: requirements.resource,
        amountMinorUnits: requirements.amountMinorUnits,
        currency: requirements.currency,
        payTo: requirements.payTo,
        nonce: requirements.nonce,
        payer: AGENT_ID,
      };
      const payload: PaymentPayload = { ...unsigned, signature: signPayment(privateKey, unsigned) };
      const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

      const first = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": header },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(first.status, 200);

      const replay = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": header },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(replay.status, 409);
      const replayBody = (await replay.json()) as { error: string };
      assert.match(replayBody.error, /already redeemed|replay/i);
    });
  });

  test("rejects a payment whose amount was tampered with after signing", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer({ knownPayers }, async (server) => {
      const quoteRes = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      const requirements = (await quoteRes.json()) as PaymentRequirements;

      const unsigned = {
        resource: requirements.resource,
        amountMinorUnits: requirements.amountMinorUnits,
        currency: requirements.currency,
        payTo: requirements.payTo,
        nonce: requirements.nonce,
        payer: AGENT_ID,
      };
      const signature = signPayment(privateKey, unsigned);
      // Sign for the real amount, then submit a lower amount with the same signature —
      // the classic "pay less than you signed for" attack. The quote-mismatch check
      // catches this first and cheaply (before any signature math runs); the deeper
      // guarantee — that the signature itself covers the amount and would fail to
      // verify even without that check — is exercised independently by the
      // "signed by a key other than the registered payer's" case below, which holds
      // every field identical to the quote and varies only the signing key.
      const tamperedPayload: PaymentPayload = { ...unsigned, amountMinorUnits: 1, signature };
      const header = Buffer.from(JSON.stringify(tamperedPayload), "utf8").toString("base64");

      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": header },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /match|quote/i);
    });
  });

  test("rejects a payment signed by a key other than the registered payer's", async () => {
    const registered = generatePayerKeyPair();
    const impostor = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(registered.publicKey)]]);

    await withServer({ knownPayers }, async (server) => {
      const quoteRes = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      const requirements = (await quoteRes.json()) as PaymentRequirements;

      const unsigned = {
        resource: requirements.resource,
        amountMinorUnits: requirements.amountMinorUnits,
        currency: requirements.currency,
        payTo: requirements.payTo,
        nonce: requirements.nonce,
        payer: AGENT_ID,
      };
      // Signed with the impostor's key, but still claiming to be AGENT_ID.
      const payload: PaymentPayload = { ...unsigned, signature: signPayment(impostor.privateKey, unsigned) };
      const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": header },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(res.status, 401);
    });
  });

  test("rejects a payment from a payer the server has no registered key for", async () => {
    const { privateKey } = generatePayerKeyPair();
    const knownPayers = new Map<string, string>(); // nobody registered

    await withServer({ knownPayers }, async (server) => {
      const quoteRes = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      const requirements = (await quoteRes.json()) as PaymentRequirements;
      const unsigned = {
        resource: requirements.resource,
        amountMinorUnits: requirements.amountMinorUnits,
        currency: requirements.currency,
        payTo: requirements.payTo,
        nonce: requirements.nonce,
        payer: "agent-nobody-registered",
      };
      const payload: PaymentPayload = { ...unsigned, signature: signPayment(privateKey, unsigned) };
      const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": header },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(res.status, 401);
    });
  });

  test("rejects a payment for a quote that has expired", async () => {
    const { privateKey, publicKey } = generatePayerKeyPair();
    const knownPayers = new Map([[AGENT_ID, publicKeyToHex(publicKey)]]);

    await withServer({ knownPayers, quoteTtlMs: 10 }, async (server) => {
      const quoteRes = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      const requirements = (await quoteRes.json()) as PaymentRequirements;

      await new Promise((resolve) => setTimeout(resolve, 30));

      const unsigned = {
        resource: requirements.resource,
        amountMinorUnits: requirements.amountMinorUnits,
        currency: requirements.currency,
        payTo: requirements.payTo,
        nonce: requirements.nonce,
        payer: AGENT_ID,
      };
      const payload: PaymentPayload = { ...unsigned, signature: signPayment(privateKey, unsigned) };
      const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": header },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(res.status, 410);
    });
  });

  test("rejects a malformed X-PAYMENT header instead of crashing", async () => {
    const knownPayers = new Map<string, string>();
    await withServer({ knownPayers }, async (server) => {
      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": "not-valid-base64-json!!" },
        body: JSON.stringify({ resource: "acme-airlines:flights" }),
      });
      assert.equal(res.status, 400);
    });
  });

  test("returns 404 for an unknown resource on the initial quote request", async () => {
    const knownPayers = new Map<string, string>();
    await withServer({ knownPayers }, async (server) => {
      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "nonexistent:thing" }),
      });
      assert.equal(res.status, 404);
    });
  });
});
