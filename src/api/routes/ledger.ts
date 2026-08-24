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

    res.status(200).json({ entries, chainValid: deps.ledger.verifyChain().valid });
  });

  return router;
}
