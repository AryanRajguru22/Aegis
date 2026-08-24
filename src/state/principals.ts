import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "./crypto.js";

/**
 * Principal-level API authentication — distinct from, and layered above, the
 * Biscuit capability tokens that govern individual agents' financial authority (see
 * src/capability). A principal API key answers "who is calling the Aegis control
 * plane" (register an agent, revoke one, read the ledger); a capability token answers
 * "what is this specific agent allowed to spend." Mixing these up would let anyone
 * holding an agent's narrow financial-transaction token also perform administrative
 * actions — the two are kept as separate credential types on purpose.
 *
 * Only the SHA-256 hash of a key is ever stored — the raw key is returned to the
 * caller exactly once, at creation, the same way a real API-key issuance flow works.
 */
export interface PrincipalStore {
  /** Creates a new principal and returns its raw API key. Throws if principalId is already taken. */
  create(principalId: string): string;
  /** Returns the principalId for a valid key, or undefined if the key is unrecognized. */
  authenticate(apiKey: string): string | undefined;
  exists(principalId: string): boolean;
}

export function createPrincipalStore(db: DatabaseSync): PrincipalStore {
  const insertStmt = db.prepare(
    `INSERT INTO principals (principal_id, api_key_hash, created_at) VALUES (:principal_id, :api_key_hash, :created_at)`
  );
  const byIdStmt = db.prepare(`SELECT 1 FROM principals WHERE principal_id = :principal_id`);
  const byHashStmt = db.prepare(`SELECT principal_id FROM principals WHERE api_key_hash = :api_key_hash`);

  function exists(principalId: string): boolean {
    return byIdStmt.get({ principal_id: principalId }) !== undefined;
  }

  return {
    exists,
    create(principalId) {
      if (exists(principalId)) {
        throw new Error(`Principal "${principalId}" already exists`);
      }
      const apiKey = randomBytes(32).toString("hex");
      insertStmt.run({
        principal_id: principalId,
        api_key_hash: sha256Hex(apiKey),
        created_at: new Date().toISOString(),
      });
      return apiKey;
    },
    authenticate(apiKey) {
      const row = byHashStmt.get({ api_key_hash: sha256Hex(apiKey) }) as { principal_id: string } | undefined;
      return row?.principal_id;
    },
  };
}
