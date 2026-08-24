import { KeyPair, PrivateKey, PublicKey, SignatureAlgorithm } from "@biscuit-auth/biscuit-wasm";
import { ensureWasmReady } from "./wasm.js";

export interface RootKeyMaterial {
  privateKey: PrivateKey;
  publicKey: PublicKey;
}

/** Generates a fresh Ed25519 root keypair. In production this key's private half must live in an HSM/KMS, never in application memory — see docs/THREAT_MODEL.md §10. */
export function generateRootKeyPair(): RootKeyMaterial {
  ensureWasmReady();
  const kp = new KeyPair(SignatureAlgorithm.Ed25519);
  return { privateKey: kp.getPrivateKey(), publicKey: kp.getPublicKey() };
}

/** Reconstitutes a root keypair from a persisted hex-encoded private key (e.g. loaded from a secrets manager). */
export function loadRootKeyPairFromHex(privateKeyHex: string): RootKeyMaterial {
  ensureWasmReady();
  const privateKey = PrivateKey.fromString(privateKeyHex);
  const kp = KeyPair.fromPrivateKey(privateKey);
  return { privateKey, publicKey: kp.getPublicKey() };
}

export function publicKeyFromHex(publicKeyHex: string): PublicKey {
  ensureWasmReady();
  return PublicKey.fromString(publicKeyHex, SignatureAlgorithm.Ed25519);
}

export function privateKeyToHex(key: PrivateKey): string {
  return key.toString();
}

export function publicKeyToHex(key: PublicKey): string {
  return key.toString();
}