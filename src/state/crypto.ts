import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export interface LedgerKeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** The ledger's own signing key — deliberately distinct from the Biscuit capability-token root key (src/capability/keys.ts), since they protect different things: one signs delegated authority, this one signs the historical record of decisions. In production both live in an HSM/KMS; see docs/THREAT_MODEL.md §10. */
export function generateLedgerKeyPair(): LedgerKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

export function ledgerPublicKeyToHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "spki", format: "der" })).toString("hex");
}

export function ledgerPublicKeyFromHex(hex: string): KeyObject {
  return createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" });
}

export function ledgerPrivateKeyToHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "pkcs8", format: "der" })).toString("hex");
}

export function ledgerPrivateKeyFromHex(hex: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(hex, "hex"), format: "der", type: "pkcs8" });
}

/** Reconstitutes a full keypair from a persisted private key, deriving the matching public key from it (Node's createPublicKey supports this directly for Ed25519) rather than requiring the public half to be stored separately, which would risk the two ever getting out of sync. */
export function ledgerKeyPairFromPrivateHex(hex: string): LedgerKeyMaterial {
  const privateKey = ledgerPrivateKeyFromHex(hex);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function sign(privateKey: KeyObject, data: string): string {
  return cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("hex");
}

export function verify(publicKey: KeyObject, data: string, signatureHex: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(data, "utf8"), publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Deterministic JSON serialization (recursively sorted object keys) so that hashing
 * the same logical content always produces the same string, regardless of the
 * insertion order a caller happened to build the object in.
 *
 * Must match JSON.stringify's own handling of `undefined` exactly, field for field —
 * `data_json` (what actually gets persisted and later reloaded — see
 * src/state/ledger.ts's `append`/`rowToEntry`) is written with plain JSON.stringify,
 * and this function's output is what gets hashed. Any divergence between the two
 * means a legitimate, never-tampered entry can permanently fail re-verification
 * after a reload, purely because of how it happened to be serialized — not because
 * anything was altered. JSON.stringify OMITS an object property whose value is
 * `undefined` entirely, and substitutes `null` for an `undefined` array element;
 * both are matched here on purpose, not merely preserved by accident. This is a real
 * shape in this codebase, not a hypothetical: e.g.
 * src/mission/ledger.ts's MissionPipelineOutcomeData has `execution`/`risk` fields
 * that are genuinely absent for non-"allow"/policy-denied outcomes, and the call site
 * that builds that data (src/api/routes/transactions.ts) writes them as
 * `field: possiblyAbsentValue`, which creates an own `undefined`-valued property on
 * the object being hashed.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
