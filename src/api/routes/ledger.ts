import { Router, type RequestHandler } from "express";
import type { AppDependencies } from "../deps.js";
import { requireOwnedAgent } from "../auth.js";
import { ApiError } from "../errors.js";

const MAX_PAGE_LIMIT = 1000;

function parsePositiveInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new ApiError(400, `Query parameter "${name}" must be a positive integer`);
  }
  const n = Number(value);
  if (n > max) throw new ApiError(400, `Query parameter "${name}" must be at most ${max}`);
  return n;
}

export function createLedgerRouter(deps: AppDependencies, requirePrincipal: RequestHandler): Router {
  const router = Router();

  /**
   * Query parameters (all optional; with none, the response is the principal's complete
   * history exactly as before):
   *  - agentId       restrict to one owned agent
   *  - kind          restrict to one entry kind (exact match)
   *  - limit         page size, 1..1000 — returns the NEWEST `limit` matching entries
   *  - beforeSeq     only entries with seq < beforeSeq (the cursor for the next, older page)
   * Entries within a page are always in ascending seq order. `chainValid` always describes
   * the WHOLE global hash chain, never the page — paging cannot hide a broken link.
   */
  router.get("/ledger", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const agentIdFilter = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
    const limit = parsePositiveInt(req.query.limit, "limit", MAX_PAGE_LIMIT);
    const beforeSeq = parsePositiveInt(req.query.beforeSeq, "beforeSeq", Number.MAX_SAFE_INTEGER);
    if (req.query.kind !== undefined && (typeof req.query.kind !== "string" || req.query.kind.length === 0 || req.query.kind.length > 100)) {
      throw new ApiError(400, 'Query parameter "kind" must be a non-empty string of at most 100 characters');
    }
    const kind = req.query.kind as string | undefined;

    let entries;
    if (agentIdFilter) {
      requireOwnedAgent(deps.agents, agentIdFilter, principalId);
      entries = deps.ledger.listByAgent(agentIdFilter);
    } else {
      entries = deps.ledger.listByPrincipal(principalId);
    }

    const filtered = kind !== undefined || beforeSeq !== undefined || limit !== undefined;
    let page: { limit: number | null; total: number; hasMore: boolean; nextBeforeSeq: number | null } | undefined;
    if (filtered) {
      if (kind !== undefined) entries = entries.filter((e) => e.kind === kind);
      if (beforeSeq !== undefined) entries = entries.filter((e) => e.seq < beforeSeq);
      const total = entries.length;
      let hasMore = false;
      if (limit !== undefined && total > limit) {
        entries = entries.slice(total - limit);
        hasMore = true;
      }
      page = { limit: limit ?? null, total, hasMore, nextBeforeSeq: hasMore && entries.length > 0 ? entries[0]!.seq : null };
    }

    // brokenAtSeq/reason are deterministic, non-sensitive facts about the ledger's own
    // structure (which sequence number's link/hash/signature failed, and which of
    // those three failed) — safe to expose, and exactly what a truthful "TAMPERED"
    // state needs to point at. Never populated when valid — see ChainVerification's
    // own contract (src/state/ledger.ts).
    const verification = deps.ledger.verifyChain();
    res.status(200).json({
      entries,
      chainValid: verification.valid,
      brokenAtSeq: verification.brokenAtSeq ?? null,
      reason: verification.reason ?? null,
      // Public by design (an Ed25519 verification key) — the dashboard shows it inside the
      // ready-to-run independent-verifier command. Never a private key.
      ledgerPublicKey: deps.ledger.publicKeyHex,
      ...(page ? { page } : {}),
    });
  });

  return router;
}
