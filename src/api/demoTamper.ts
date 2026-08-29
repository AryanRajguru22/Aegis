import type { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import type { PrincipalStore } from "../state/principals.js";
import { requirePrincipalAuth } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * Step 13, Scenario C: the ONLY new backend surface in the entire local-demo-theatre
 * feature — a single, narrowly-scoped way to demonstrate the existing, completely
 * unmodified hash-chain tamper-detection guarantee (src/state/ledger.ts's
 * verifyChain(), untouched by this file) against a REAL corruption, not a simulated
 * one. Everything about this module is deliberately narrow:
 *
 *  - It touches the raw SQLite `ledger_entries` table directly, NEVER importing or
 *    extending LedgerStore (src/state/ledger.ts) — that abstraction, used by every
 *    other route in the app, gains no new capability, no new method, nothing.
 *  - It performs exactly ONE fixed, deterministic transformation (see
 *    applyDemoLedgerTamper below) — never an arbitrary "set field X to value Y" write.
 *  - It only ever touches `data_json` — `content_hash`, `signature`, `prev_hash`,
 *    `kind`, `agent_id`, `principal_id`, `created_at` are never read for writing and
 *    never appear on the right-hand side of the UPDATE statement below. This is what
 *    makes the corruption genuine: the stored content changes, but the hash computed
 *    over the ORIGINAL content does not — exactly the same "content-hash mismatch"
 *    failure mode already proven, independently, in
 *    src/state/__tests__/state-core.test.ts.
 *  - It requires real principal authentication and verifies the target entry's
 *    already-stored `principal_id` (set only by LedgerStore.append() from trusted
 *    server-side data at write time — never client-influenced) matches the
 *    authenticated caller, so one principal's demo can never corrupt another's data.
 *  - The router this module exports is NEVER mounted in production — see
 *    src/api/main.ts, which only constructs and mounts it inside the same
 *    `if (demoMode)` branch that already gates every other demo-only behavior.
 */

export interface DemoTamperResult {
  ok: boolean;
  reason?: string;
  seq?: number;
}

/**
 * The one fixed corruption: overwrite the target entry's `data_json` with a variant
 * that carries an added, clearly-labeled tamper marker on top of whatever was already
 * there — never a kind-specific field rewrite (which would mean multiple, branching
 * transformations rather than one), never touching content_hash/signature/prev_hash
 * (which would mean the corruption could re-validate itself, defeating the entire
 * point), and never restorable by calling this again with different arguments (there
 * are no other arguments) — this operation cannot repair, restore, or toggle ledger
 * state; it can only make an entry's stored content diverge further from its
 * already-fixed hash.
 */
export function applyDemoLedgerTamper(db: DatabaseSync, principalId: string, seq: number): DemoTamperResult {
  if (!Number.isInteger(seq) || seq <= 0) {
    return { ok: false, reason: `"seq" must be a positive integer, got ${JSON.stringify(seq)}` };
  }

  const getStmt = db.prepare(`SELECT seq, principal_id, data_json FROM ledger_entries WHERE seq = :seq`);
  const row = getStmt.get({ seq }) as { seq: number; principal_id: string; data_json: string } | undefined;
  if (!row) {
    return { ok: false, reason: `No ledger entry with seq ${seq}` };
  }
  if (row.principal_id !== principalId) {
    // Ownership is checked against the entry's own stored principal_id — written once,
    // by LedgerStore.append(), from server-trusted data at the moment the entry was
    // created. Nothing in this request can influence that stored value, so this check
    // cannot be bypassed by any client-supplied input.
    return { ok: false, reason: `Ledger entry ${seq} does not belong to the authenticated principal` };
  }

  let originalData: Record<string, unknown>;
  try {
    originalData = JSON.parse(row.data_json) as Record<string, unknown>;
  } catch {
    originalData = {};
  }
  const corrupted = {
    ...originalData,
    __demoTamperedAt: new Date().toISOString(),
    __demoTamperNote:
      "This entry's stored content was altered directly in the database, bypassing Aegis's normal ledger write path, " +
      "to demonstrate hash-chain tamper detection in AEGIS_DEMO_MODE. Its content hash and signature were computed " +
      "over the ORIGINAL content and were never recomputed — that mismatch is what verifyChain() below detects.",
  };

  const updateStmt = db.prepare(`UPDATE ledger_entries SET data_json = :data_json WHERE seq = :seq`);
  updateStmt.run({ seq, data_json: JSON.stringify(corrupted) });

  return { ok: true, seq };
}

/**
 * A single-route router, principal-authenticated, that exists purely to expose
 * applyDemoLedgerTamper over HTTP. Constructed and mounted ONLY by main.ts, ONLY
 * inside its existing `if (demoMode)` branch — see that file for why the route is
 * structurally absent (not merely conditionally rejected) in production.
 */
export function createDemoTamperRouter(db: DatabaseSync, principals: PrincipalStore) {
  const router = Router();
  const requirePrincipal = requirePrincipalAuth(principals);

  router.post("/demo/tamper-ledger-entry/:seq", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq <= 0) {
      throw new ApiError(400, `"seq" must be a positive integer`);
    }

    const result = applyDemoLedgerTamper(db, principalId, seq);
    if (!result.ok) {
      throw new ApiError(404, result.reason ?? "Tamper failed");
    }
    res.status(200).json({ tampered: true, seq: result.seq });
  });

  return router;
}
