export * from "./types.js";
export { ensureWasmReady, ensureWarm } from "./wasm.js";
export { assertValidIdentifier } from "./caveats.js";
export { generateRootKeyPair, loadRootKeyPairFromHex, publicKeyFromHex, privateKeyToHex, publicKeyToHex } from "./keys.js";
export { issueRootToken, attenuateToken, loadToken, getRevocationIdentifiers, countBlocks, extractRootFacts, getOwnRevocationId } from "./token.js";
export type { RootFacts } from "./token.js";
export { createInMemoryRevocationStore, revokeAgentToken } from "./revocation.js";
export type { RevocationStore } from "./revocation.js";
export { verifyTransaction } from "./authorize.js";
