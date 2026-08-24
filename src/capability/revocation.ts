import type { PublicKey } from "@biscuit-auth/biscuit-wasm";
import { getRevocationIdentifiers } from "./token.js";
import type { RevocationRecord } from "./types.js";

/**
 * A revocation store keyed by Biscuit revocation identifier (one per block). Revoking
 * a node's identifier is sufficient to cascade: every token attenuated from that node
 * carries the same identifier in its own ancestry (see token.ts), so a single lookup
 * against this store during verification catches every descendant automatically —
 * there is no need to enumerate or individually invalidate sub-agent tokens.
 *
 * This in-memory implementation is the right shape for the isolated-core proof this
 * module is scoped to (docs/MVP_SCOPE.md). A production deployment swaps this for a
 * persisted, append-only store (see docs/SYSTEM_ARCHITECTURE.md §5, the audit ledger)
 * without changing the interface.
 */
export interface RevocationStore {
  revoke(revocationId: string, reason: string): RevocationRecord;
  isRevoked(revocationId: string): boolean;
  /** Returns the first matching revocation record among the given ids, if any is revoked. */
  findRevoked(revocationIds: string[]): RevocationRecord | undefined;
  list(): RevocationRecord[];
}

export function createInMemoryRevocationStore(): RevocationStore {
  const revoked = new Map<string, RevocationRecord>();

  return {
    revoke(revocationId, reason) {
      const record: RevocationRecord = {
        revocationId,
        revokedAt: new Date().toISOString(),
        reason,
      };
      revoked.set(revocationId, record);
      return record;
    },
    isRevoked(revocationId) {
      return revoked.has(revocationId);
    },
    findRevoked(revocationIds) {
      for (const id of revocationIds) {
        const record = revoked.get(id);
        if (record) return record;
      }
      return undefined;
    },
    list() {
      return Array.from(revoked.values());
    },
  };
}

/**
 * Revokes the agent that a given token was issued to — specifically, the revocation
 * identifier of *that token's own (last-appended) block*, not its ancestors'. Because
 * every token attenuated from this one will carry this same identifier in its own
 * ancestry, this single call cascades to every descendant already issued, without
 * needing to know they exist. It does not affect the parent agent or sibling
 * sub-agents, whose own blocks have different identifiers.
 */
export function revokeAgentToken(
  tokenBase64: string,
  rootPublicKey: PublicKey,
  store: RevocationStore,
  reason: string
): RevocationRecord {
  const identifiers = getRevocationIdentifiers(tokenBase64, rootPublicKey);
  const ownIdentifier = identifiers[identifiers.length - 1];
  if (!ownIdentifier) {
    throw new Error("Token has no blocks — nothing to revoke");
  }
  return store.revoke(ownIdentifier, reason);
}
