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
  /**
   * The same full-chain verification with the same result, but it yields to the event loop
   * between small batches of rows and shares one in-flight pass between concurrent callers.
   * Use this on request paths: the synchronous verifyChain() blocks every other request for
   * the whole pass (~2s at 10k entries, measured).
   */
  verifyChainAsync(): Promise<ChainVerification>;
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
export interface LedgerStoreOptions {
  /** Test hook: called each time verifyChain() performs a real full pass (i.e. is not served from the unchanged-database memo). */
  onFullVerification?: () => void;
}

export function createLedgerStore(
  db: DatabaseSync,
  keys: LedgerKeyMaterial,
  publicKeyHex: string,
  options: LedgerStoreOptions = {}
): LedgerStore {
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

  // Full verification is O(entries) with an Ed25519 verify each (~160us/entry, measured —
  // seconds at tens of thousands of entries) and runs synchronously, blocking every other
  // request. Its RESULT is memoized, but only against a token that changes on ANY write to
  // the database by ANY connection: SQLite's data_version covers other connections/processes,
  // total_changes() covers this one. So a tampered row (an UPDATE/DELETE/INSERT, in-process
  // or out-of-band) always invalidates the memo and forces a fresh full pass — this never
  // trades detection for speed; it only skips re-proving a database that provably has not
  // changed since it was last proven.
  const dataVersionStmt = db.prepare(`PRAGMA data_version`);
  const totalChangesStmt = db.prepare(`SELECT total_changes() AS n`);
  let memo: { token: string; result: ChainVerification } | undefined;
  function changeToken(): string {
    const v = (dataVersionStmt.get() as { data_version: number }).data_version;
    const n = (totalChangesStmt.get() as { n: number }).n;
    return `${v}:${n}`;
  }

  function verifyChain(): ChainVerification {
    const token = changeToken();
    if (memo && memo.token === token) return { ...memo.result };
    const result = verifyChainFull();
    memo = { token, result };
    return { ...result };
  }

  /** Checks one row against the running chain state. Returns the failure, or undefined if the row is sound. Shared by the sync and async passes so they can never disagree. */
  function checkRow(row: Record<string, unknown>, expectedPrevHash: string): ChainVerification | undefined {
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
    return undefined;
  }

  function verifyChainFull(): ChainVerification {
    options.onFullVerification?.();
    const rows = allStmt.all() as Array<Record<string, unknown>>;
    let expectedPrevHash = GENESIS_HASH;
    for (const row of rows) {
      const failure = checkRow(row, expectedPrevHash);
      if (failure) return failure;
      expectedPrevHash = String(row.content_hash);
    }
    return { valid: true };
  }

  // Cooperative variant: the rows examined are exactly those with seq <= the maximum at the
  // moment the pass STARTS (entries are append-only, so rows added during the pass are simply
  // outside this snapshot, like writes that land right after a synchronous check). The memo is
  // stored under the token taken at the start, so any write — including one that lands mid-pass
  // — makes the next call verify again. Concurrent callers for the same token share one pass,
  // so a loop of /ledger reads cannot multiply the CPU cost.
  const maxSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ledger_entries`);
  const batchStmt = db.prepare(`SELECT * FROM ledger_entries WHERE seq > :after AND seq <= :max ORDER BY seq ASC LIMIT :limit`);
  const ASYNC_BATCH_ROWS = 200; // ~30ms of work per batch at ~160us/entry
  let inflight: { token: string; promise: Promise<ChainVerification> } | undefined;

  async function verifyChainCooperatively(token: string): Promise<ChainVerification> {
    options.onFullVerification?.();
    const max = Number((maxSeqStmt.get() as { m: number }).m);
    let after = 0;
    let expectedPrevHash = GENESIS_HASH;
    let result: ChainVerification = { valid: true };
    while (after < max) {
      const rows = batchStmt.all({ after, max, limit: ASYNC_BATCH_ROWS }) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const failure = checkRow(row, expectedPrevHash);
        if (failure) {
          result = failure;
          break;
        }
        expectedPrevHash = String(row.content_hash);
        after = Number(row.seq);
      }
      if (!result.valid) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    memo = { token, result };
    return result;
  }

  function verifyChainAsync(): Promise<ChainVerification> {
    const token = changeToken();
    if (memo && memo.token === token) return Promise.resolve({ ...memo.result });
    if (inflight && inflight.token === token) return inflight.promise.then((r) => ({ ...r }));
    const promise = verifyChainCooperatively(token).finally(() => {
      if (inflight && inflight.promise === promise) inflight = undefined;
    });
    inflight = { token, promise };
    return promise.then((r) => ({ ...r }));
  }

  return {
    append,
    verifyChain,
    verifyChainAsync,
    listByAgent: (agentId) => (byAgentStmt.all({ agent_id: agentId }) as Array<Record<string, unknown>>).map(rowToEntry),
    listByPrincipal: (principalId) =>
      (byPrincipalStmt.all({ principal_id: principalId }) as Array<Record<string, unknown>>).map(rowToEntry),
    all: () => (allStmt.all() as Array<Record<string, unknown>>).map(rowToEntry),
    publicKeyHex,
  };
}
