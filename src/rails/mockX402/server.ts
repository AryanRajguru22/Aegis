import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { publicKeyFromHex, verifyPaymentSignature, type PaymentPayload, type PaymentRequirements } from "./protocol.js";

/**
 * A real local HTTP server standing in for a merchant that accepts x402-style
 * payments — deliberately implemented as actual sockets (node:http), not an in-process
 * function call, so the adapter in client.ts genuinely exercises an HTTP round trip
 * with real status codes, not a simulation of one.
 */
export interface MockX402ServerOptions {
  /** payerId -> hex-encoded Ed25519 public key. The server only accepts payments from payers it has a registered key for. */
  knownPayers: Map<string, string>;
  priceResolver: (resource: string) => { amountMinorUnits: number; currency: string } | undefined;
  payTo?: string;
  quoteTtlMs?: number;
}

export interface MockX402Server {
  url: string;
  close(): Promise<void>;
}

const DEFAULT_QUOTE_TTL_MS = 30_000;

export async function startMockX402Server(opts: MockX402ServerOptions): Promise<MockX402Server> {
  const payTo = opts.payTo ?? "merchant-mock-x402";
  const quoteTtlMs = opts.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  const pendingQuotes = new Map<string, PaymentRequirements & { redeemed: boolean }>();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/pay") {
      res.writeHead(404).end();
      return;
    }

    const body = await readJsonBody(req);
    const resource = String((body as { resource?: unknown }).resource ?? "");
    const price = opts.priceResolver(resource);
    if (!price) {
      respondJson(res, 404, { error: `Unknown resource: ${resource}` });
      return;
    }

    const paymentHeader = req.headers["x-payment"];
    if (!paymentHeader || typeof paymentHeader !== "string") {
      const nonce = randomBytes(16).toString("hex");
      const requirements: PaymentRequirements = {
        x402Version: 1,
        resource,
        amountMinorUnits: price.amountMinorUnits,
        currency: price.currency,
        payTo,
        nonce,
        expiresAt: new Date(Date.now() + quoteTtlMs).toISOString(),
      };
      pendingQuotes.set(nonce, { ...requirements, redeemed: false });
      respondJson(res, 402, requirements);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
    } catch {
      respondJson(res, 400, { error: "Malformed X-PAYMENT header" });
      return;
    }

    const quote = pendingQuotes.get(payload.nonce);
    if (!quote) {
      respondJson(res, 400, { error: "Unknown nonce — no matching quote was ever issued" });
      return;
    }
    if (quote.redeemed) {
      respondJson(res, 409, { error: "Payment already redeemed for this nonce (replay rejected)" });
      return;
    }
    if (new Date(quote.expiresAt).getTime() < Date.now()) {
      respondJson(res, 410, { error: "Quote expired" });
      return;
    }
    if (
      payload.resource !== quote.resource ||
      payload.amountMinorUnits !== quote.amountMinorUnits ||
      payload.currency !== quote.currency ||
      payload.payTo !== quote.payTo
    ) {
      respondJson(res, 400, { error: "Payment payload does not match the original quote" });
      return;
    }

    const payerPublicKeyHex = opts.knownPayers.get(payload.payer);
    if (!payerPublicKeyHex) {
      respondJson(res, 401, { error: `Unknown payer: ${payload.payer}` });
      return;
    }
    if (!verifyPaymentSignature(publicKeyFromHex(payerPublicKeyHex), payload)) {
      respondJson(res, 401, { error: "Invalid payment signature" });
      return;
    }

    quote.redeemed = true;
    respondJson(res, 200, {
      settled: true,
      reference: `mockx402_${randomUUID()}`,
      settledAt: new Date().toISOString(),
    });
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
