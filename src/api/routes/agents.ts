import { Router } from "express";
import { attenuateToken, getOwnRevocationId, issueRootToken, revokeAgentToken } from "../../capability/index.js";
import type { Caveats } from "../../capability/types.js";
import type { AgentRecord } from "../../state/agents.js";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import { requireOwnedAgent } from "../auth.js";
import { parseCreateAgentBody, parseRevokeBody } from "../validation.js";

/** Never re-exposes tokenBase64 — like an API key, a capability token is shown once, at creation/attenuation time, and the caller is expected to store it. See docs comment in validation.ts / README for the reasoning. */
function toPublicAgent(agent: AgentRecord) {
  return {
    agentId: agent.agentId,
    principalId: agent.principalId,
    parentAgentId: agent.parentAgentId,
    rootAgentId: agent.rootAgentId,
    delegatedGoal: agent.delegatedGoal,
    caveats: agent.caveats,
    createdAt: agent.createdAt,
  };
}

export function createAgentsRouter(deps: AppDependencies, requirePrincipal: import("express").RequestHandler): Router {
  const router = Router();

  router.post("/agents", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const { agentId, delegatedGoal, caveats } = parseCreateAgentBody(req.body);

    let tokenBase64: string;
    try {
      tokenBase64 = issueRootToken({ principalId, agentId, delegatedGoal, caveats }, deps.rootPrivateKey);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : String(error));
    }
    const revocationId = getOwnRevocationId(tokenBase64, deps.rootPublicKey);

    let record: AgentRecord;
    try {
      record = deps.agents.register({
        agentId,
        principalId,
        parentAgentId: null,
        delegatedGoal,
        caveats: caveats as unknown as Record<string, unknown>,
        tokenBase64,
        revocationId,
      });
    } catch (error) {
      throw new ApiError(409, error instanceof Error ? error.message : String(error));
    }

    deps.ledger.append({
      kind: "agent_registered",
      agentId,
      principalId,
      data: { delegatedGoal, caveats, parentAgentId: null },
    });

    res.status(201).json({ ...toPublicAgent(record), token: tokenBase64 });
  });

  router.post("/agents/:parentId/attenuate", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const parentId = req.params.parentId as string;
    const parent = requireOwnedAgent(deps.agents, parentId, principalId);

    const { agentId, delegatedGoal, caveats } = parseCreateAgentBody(req.body);

    let tokenBase64: string;
    try {
      tokenBase64 = attenuateToken(
        { parentTokenBase64: parent.tokenBase64, parentCaveats: parent.caveats as unknown as Caveats, agentId, caveats },
        deps.rootPublicKey
      );
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : String(error));
    }
    const revocationId = getOwnRevocationId(tokenBase64, deps.rootPublicKey);

    let record: AgentRecord;
    try {
      record = deps.agents.register({
        agentId,
        principalId,
        parentAgentId: parentId,
        delegatedGoal,
        caveats: caveats as unknown as Record<string, unknown>,
        tokenBase64,
        revocationId,
      });
    } catch (error) {
      throw new ApiError(409, error instanceof Error ? error.message : String(error));
    }

    deps.ledger.append({
      kind: "agent_registered",
      agentId,
      principalId,
      data: { delegatedGoal, caveats, parentAgentId: parentId },
    });

    res.status(201).json({ ...toPublicAgent(record), token: tokenBase64 });
  });

  router.post("/agents/:id/revoke", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const id = req.params.id as string;
    const agent = requireOwnedAgent(deps.agents, id, principalId);
    const { reason } = parseRevokeBody(req.body);

    const record = revokeAgentToken(agent.tokenBase64, deps.rootPublicKey, deps.revocationStore, reason);

    deps.ledger.append({
      kind: "revocation",
      agentId: id,
      principalId,
      data: { reason, revokedAt: record.revokedAt, revokedBy: principalId },
    });

    res.status(200).json({ agentId: id, revokedAt: record.revokedAt, reason });
  });

  router.get("/agents", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    res.status(200).json({ agents: deps.agents.listByPrincipal(principalId).map(toPublicAgent) });
  });

  router.get("/agents/:id", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const agent = requireOwnedAgent(deps.agents, req.params.id as string, principalId);
    res.status(200).json(toPublicAgent(agent));
  });

  router.get("/agents/:id/graph", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const agent = requireOwnedAgent(deps.agents, req.params.id as string, principalId);
    const tree = deps.agents.listTree(agent.rootAgentId).map(toPublicAgent);
    res.status(200).json({ rootAgentId: agent.rootAgentId, agents: tree });
  });

  return router;
}
