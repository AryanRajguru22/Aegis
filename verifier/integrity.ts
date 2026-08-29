import { canonicalContent, sha256Hex, publicKeyFromHex, verifySignature, GENESIS_HASH } from "./canonical.js";
import type { ExportedLedgerEntry } from "./schema.js";

export interface IntegrityResult {
  valid: boolean;
  entriesChecked: number;
  /** Which independent check failed first, in the order they're actually run — never conflated into one generic message. */
  failure?: {
    stage: "sequence_continuity" | "prev_hash_continuity" | "content_hash" | "signature";
    atSeq: number;
    reason: string;
  };
}

/**
 * Proof 1, implemented completely independently of src/state/ledger.ts's
 * verifyChain() — this function is never called by, and never calls, that function.
 * Given the artifact's public key and its entries, re-derives every fact from
 * scratch:
 *
 *  1. sequence continuity — entries, sorted by their own claimed `seq`, must start
 *     at seq 1 and increase by exactly 1 with no gaps (an interior gap is exactly
 *     what a deleted entry, or a non-full/scoped export, would produce).
 *  2. prevHash continuity — each entry's `prevHash` must equal the immediately
 *     preceding entry's `contentHash` (the first entry's `prevHash` must equal the
 *     fixed genesis hash) — this is what makes a deleted, reordered, or forged
 *     interior entry visible, and it is also what makes the FIRST entry's own
 *     integrity checkable: if entries were deleted from the very beginning of the
 *     ledger, the new "first" entry's prevHash will not equal the genesis hash, and
 *     this check catches it. (Deleting entries from the very END, after which nothing
 *     remains to reveal the gap, is NOT detectable this way — see
 *     verifier/compareExports.ts and the project's documented evidence limitations.)
 *  3. content-hash recomputation — independently reconstructs the canonical string
 *     for each entry's own fields and recomputes its SHA-256, comparing against the
 *     stored contentHash.
 *  4. signature verification — independently verifies the stored signature over the
 *     stored contentHash against the supplied PUBLIC verification key.
 *
 * Stops and reports the FIRST failure found, walking in ascending seq order — mirrors
 * how a reader would want to know "where does trust first break down", not just
 * "something, somewhere, is wrong".
 */
export function verifyIntegrity(publicKeyHex: string, entries: readonly ExportedLedgerEntry[]): IntegrityResult {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const publicKey = publicKeyFromHex(publicKeyHex);

  let expectedSeq = 1;
  let expectedPrevHash = GENESIS_HASH;

  for (const entry of sorted) {
    if (entry.seq !== expectedSeq) {
      return {
        valid: false,
        entriesChecked: sorted.length,
        failure: {
          stage: "sequence_continuity",
          atSeq: entry.seq,
          reason: `expected seq ${expectedSeq} next, found ${entry.seq} — an entry is missing, duplicated, or this is not a full, unscoped export`,
        },
      };
    }

    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        entriesChecked: sorted.length,
        failure: {
          stage: "prev_hash_continuity",
          atSeq: entry.seq,
          reason: "prevHash does not match the preceding entry's content hash — the chain link is broken",
        },
      };
    }

    const recomputedContent = canonicalContent({
      kind: entry.kind,
      agentId: entry.agentId,
      principalId: entry.principalId,
      data: entry.data,
      createdAt: entry.createdAt,
      prevHash: entry.prevHash,
    });
    const recomputedHash = sha256Hex(recomputedContent);
    if (recomputedHash !== entry.contentHash) {
      return {
        valid: false,
        entriesChecked: sorted.length,
        failure: {
          stage: "content_hash",
          atSeq: entry.seq,
          reason: "stored content hash does not match the entry's own fields — the entry was modified after being written",
        },
      };
    }

    if (!verifySignature(publicKey, entry.contentHash, entry.signature)) {
      return {
        valid: false,
        entriesChecked: sorted.length,
        failure: {
          stage: "signature",
          atSeq: entry.seq,
          reason: "signature verification failed against the supplied public key — the hash was changed without access to the private key",
        },
      };
    }

    expectedSeq += 1;
    expectedPrevHash = entry.contentHash;
  }

  return { valid: true, entriesChecked: sorted.length };
}
