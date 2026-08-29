import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * Independent reimplementation of Aegis's ledger canonicalization/hashing/signature
 * contract, written fresh from the documented algorithm — never imports
 * src/state/crypto.ts or src/state/ledger.ts. Only Node's built-in `node:crypto` is
 * used, for the standard SHA-256/Ed25519 primitives themselves (not "Aegis's own
 * verification logic" — those are the same primitives any independent implementation
 * of this protocol would use).
 *
 * The exact algorithm this file reimplements is documented at
 * src/state/crypto.ts's `stableStringify` and src/state/ledger.ts's
 * `canonicalContent`/`append`/`verifyChain`. Divergence here would cause every
 * genuinely valid ledger entry to be reported as tampered — see
 * verifier/__tests__/canonical.test.ts's golden fixtures (real hashes/signatures
 * produced by the actual production code once, hardcoded as static data) for the
 * proof that this reimplementation agrees with production, byte for byte.
 */

export interface CanonicalContentFields {
  kind: string;
  agentId: string;
  principalId: string;
  data: unknown;
  createdAt: string;
  prevHash: string;
}

/**
 * Deterministic JSON serialization: object keys sorted lexicographically at every
 * nesting level, arrays preserve their original order, primitives serialize via
 * plain `JSON.stringify`. Must match src/state/crypto.ts's `stableStringify` exactly.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

/** Must match src/state/ledger.ts's `canonicalContent` exactly — same field order, same "\n" join, `seq` deliberately excluded. */
export function canonicalContent(fields: CanonicalContentFields): string {
  return [fields.kind, fields.agentId, fields.principalId, stableStringify(fields.data), fields.createdAt, fields.prevHash].join("\n");
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Reconstructs an Ed25519 public KeyObject from the same SPKI-DER-hex encoding src/state/crypto.ts's `ledgerPublicKeyToHex` produces. */
export function publicKeyFromHex(hex: string): KeyObject {
  return createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" });
}

/** Never throws on a malformed signature/key — a malformed signature is exactly the kind of thing that must fail closed as "not verified", never crash the tool or be mistaken for a tool bug. */
export function verifySignature(publicKey: KeyObject, data: string, signatureHex: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(data, "utf8"), publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export const GENESIS_HASH = "0".repeat(64);
