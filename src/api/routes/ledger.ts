import { Router, type RequestHandler } from "express";
import type { AppDependencies } from "../deps.js";
import { requireOwnedAgent } from "../auth.js";

export function createLedgerRouter(deps: AppDependencies, requirePrincipal: RequestHandler): Router {
  const router = Router();

  router.get("/ledger", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const agentIdFilter = typeof req.query.agentId === "string" ? req.query.agentId : undefined;

    let entries;
    if (agentIdFilter) {
      requireOwnedAgent(deps.agents, agentIdFilter, principalId);
      entries = deps.ledger.listByAgent(agentIdFilter);
    } else {
      entries = deps.ledger.listByPrincipal(principalId);
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
    });
  });

  return router;
}
