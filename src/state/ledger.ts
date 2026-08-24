import type { DatabaseSync } from "node:sqlite";
import { sha256Hex, sign, stableStringify, verify, type LedgerKeyMaterial } from "./crypto.js";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEntryInput {
  /** Free-form event type — e.g. "agent_registered", "policy_verdict", "revocation". The ledger itself is deliberately agnostic to what kinds exist; callers (the policy engine, risk engine, rail adapters, built in later steps) define their own. */
  kind: string;
  agentId: string;
  principalId: string;
  data: Record<string, unknown>;
}

export interface LedgerEntry extends LedgerEntryInput {
  seq: number;
  createdAt: string;
  prevHash: string;
  contentHash: string;
  signature: string;
}

export interface ChainVerification {
  valid: boolean;
  brokenAtSeq?: number;
  reason?: string;
}

export interface LedgerStore {
  append(entry: LedgerEntryInput): LedgerEntry;
  verifyChain(): ChainVerification;
  listByAgent(agentId: string): LedgerEntry[];
  listByPrincipal(principalId: string): LedgerEntry[];
  all(): LedgerEntry[];
  publicKeyHex: string;
}

function canonicalContent(fields: {
  kind: string;
  agentId: string;
  principalId: string;
  data: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
}): string {
  // seq is deliberately excluded: chain integrity comes from the prevHash link
  // pointing at a specific prior content hash, not from the row's own position —
  // see the module doc comment above for why that's sufficient.
  return [
    fields.kind,
    fields.agentId,
    fields.principalId,
    stableStringify(fields.data),
    fields.createdAt,
    fields.prevHash,
  ].join("\n");
}

function rowToEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    seq: Number(row.seq),
    kind: String(row.kind),
    agentId: String(row.agent_id),
    principalId: String(row.principal_id),
    data: JSON.parse(String(row.data_json)),
    createdAt: String(row.created_at),
    prevHash: String(row.prev_hash),
    contentHash: String(row.content_hash),
    signature: String(row.signature),
  };
}

/**
 * A hash-chained, append-only, signed ledger. Each entry's content hash covers its
 * own fields plus the previous entry's content hash, and is itself signed with the
 * ledger's private key. Tampering with a past entry breaks the chain two independent
 * ways: (1) the stored content hash no longer matches what's recomputed from the
 * (now-different) stored fields, and (2) even if an attacker also recomputes and
 * overwrites the stored hash to hide that, they cannot produce a valid signature over
 * the new hash without the private key — so `verifyChain()` still catches it. Both
 * failure modes are exercised directly in the test suite, not just asserted.
 *
 * This gives a **tamper-evident** record with a single trusted signer (this process's
 * key) — not a trustless/decentralized guarantee. docs/SYSTEM_ARCHITECTURE.md §5 notes
 * the production path (periodic root-hash anchoring to a public chain) for
 * third-party-verifiable evidence beyond "trust this instance's key"; that is out of
 * scope for this isolated core.
 *
 * Note on concurrency: `append` reads the last entry's hash and writes the new row
 * synchronously with no `await` between them, which is safe for a single Node.js
 * process (node:sqlite's DatabaseSync API is synchronous, so there is no interleaving
 * point). A networked, multi-process deployment needs a real transaction/locking
 * strategy around this read-then-write — noted as a production concern, not solved
 * here.
 */
export function createLedgerStore(db: DatabaseSync, keys: LedgerKeyMaterial, publicKeyHex: string): LedgerStore {
  const insertStmt = db.prepare(`
    INSERT INTO ledger_entries (kind, agent_id, principal_id, data_json, created_at, prev_hash, content_hash, signature)
    VALUES (:kind, :agent_id, :principal_id, :data_json, :created_at, :prev_hash, :content_hash, :signature)
  `);
  const lastEntryStmt = db.prepare(`SELECT content_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1`);
  const allStmt = db.prepare(`SELECT * FROM ledger_entries ORDER BY seq ASC`);
  const byAgentStmt = db.prepare(`SELECT * FROM ledger_entries WHERE agent_id = :agent_id ORDER BY seq ASC`);
  const byPrincipalStmt = db.prepare(`SELECT * FROM ledger_entries WHERE principal_id = :principal_id ORDER BY seq ASC`);

  function append(input: LedgerEntryInput): LedgerEntry {
    const last = lastEntryStmt.get() as { content_hash: string } | undefined;
    const prevHash = last?.content_hash ?? GENESIS_HASH;
    const createdAt = new Date().toISOString();
    const contentHash = sha256Hex(
      canonicalContent({ kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash })
    );
    const signature = sign(keys.privateKey, contentHash);

    const result = insertStmt.run({
      kind: input.kind,
      agent_id: input.agentId,
      principal_id: input.principalId,
      data_json: JSON.stringify(input.data),
      created_at: createdAt,
      prev_hash: prevHash,
      content_hash: contentHash,
      signature,
    });

    return { ...input, seq: Number(result.lastInsertRowid), createdAt, prevHash, contentHash, signature };
  }

  function verifyChain(): ChainVerification {
    const rows = allStmt.all() as Array<Record<string, unknown>>;
    let expectedPrevHash = GENESIS_HASH;
    for (const row of rows) {
      const entry = rowToEntry(row);

      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAtSeq: entry.seq,
          reason: "prevHash does not match the previous entry's content hash — the chain link is broken",
        };
      }

      const recomputed = sha256Hex(
        canonicalContent({
          kind: entry.kind,
          agentId: entry.agentId,
          principalId: entry.principalId,
          data: entry.data,
          createdAt: entry.createdAt,
          prevHash: entry.prevHash,
        })
      );
      if (recomputed !== entry.contentHash) {
        return {
          valid: false,
          brokenAtSeq: entry.seq,
          reason: "stored content hash does not match the entry's own fields — the entry's content was modified after being written",
        };
      }

      if (!verify(keys.publicKey, entry.contentHash, entry.signature)) {
        return {
          valid: false,
          brokenAtSeq: entry.seq,
          reason: "signature verification failed — the hash was changed without access to the ledger's private key",
        };
      }

      expectedPrevHash = entry.contentHash;
    }
    return { valid: true };
  }

  return {
    append,
    verifyChain,
    listByAgent: (agentId) => (byAgentStmt.all({ agent_id: agentId }) as Array<Record<string, unknown>>).map(rowToEntry),
    listByPrincipal: (principalId) =>
      (byPrincipalStmt.all({ principal_id: principalId }) as Array<Record<string, unknown>>).map(rowToEntry),
    all: () => (allStmt.all() as Array<Record<string, unknown>>).map(rowToEntry),
    publicKeyHex,
  };
}
