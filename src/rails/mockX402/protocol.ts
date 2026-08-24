import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/**
 * A protocol modeled on the shape of Coinbase's x402 (HTTP 402 Payment Required, a
 * signed payment payload presented via retry) — see docs/MARKET_AND_COMPETITION.md
 * §2.4. This is explicitly our own mock, built to exercise the same HTTP-native,
 * client-signed handshake pattern, not a verified implementation of the real x402.org
 * wire schema. Field names and the exact handshake are our own; the point is
 * structural difference from the Stripe rail (REST resource creation + idempotency
 * keys) in service of the rail-agnosticism claim, not spec compliance with x402
 * itself — see docs/MVP_SCOPE.md §4, which names a real x402 integration as an
 * explicit stretch goal, not an MVP requirement.
 */
export const X402_VERSION = 1;

export interface PaymentRequirements {
  x402Version: 1;
  resource: string;
  amountMinorUnits: number;
  currency: string;
  payTo: string;
  nonce: string;
  expiresAt: string;
}

export interface PaymentPayload {
  resource: string;
  amountMinorUnits: number;
  currency: string;
  payTo: string;
  nonce: string;
  /** The paying agent's identifier — looked up against the server's known-payer public key registry. */
  payer: string;
  /** Hex-encoded Ed25519 signature over canonicalPaymentString(this, minus signature). */
  signature: string;
}

export function canonicalPaymentString(p: Omit<PaymentPayload, "signature">): string {
  return [p.resource, p.amountMinorUnits, p.currency, p.payTo, p.nonce, p.payer].join("|");
}

export function generatePayerKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

export function publicKeyToHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "spki", format: "der" })).toString("hex");
}

export function publicKeyFromHex(hex: string): KeyObject {
  return createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" });
}

export function signPayment(privateKey: KeyObject, unsigned: Omit<PaymentPayload, "signature">): string {
  return cryptoSign(null, Buffer.from(canonicalPaymentString(unsigned), "utf8"), privateKey).toString("hex");
}

export function verifyPaymentSignature(publicKey: KeyObject, payload: PaymentPayload): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalPaymentString(payload), "utf8"),
      publicKey,
      Buffer.from(payload.signature, "hex")
    );
  } catch {
    return false;
  }
}
