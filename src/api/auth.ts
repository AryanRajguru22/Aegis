import type { NextFunction, Request, Response } from "express";
import type { PublicKey } from "@biscuit-auth/biscuit-wasm";
import { getOwnRevocationId } from "../capability/index.js";
import type { AgentStore } from "../state/agents.js";
import type { PrincipalStore } from "../state/principals.js";
import type { MissionStore, MissionRecord } from "../state/missions.js";
import { ApiError } from "./errors.js";

function extractBearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ") || header.length <= 7) {
    throw new ApiError(401, 'Missing or malformed Authorization header (expected "Bearer <credential>")');
  }
  return header.slice(7);
}

/** Authenticates control-plane requests (register/attenuate/revoke agents, read the ledger) by principal API key. Sets req.principalId. */
export function requirePrincipalAuth(principals: PrincipalStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const apiKey = extractBearer(req);
      const principalId = principals.authenticate(apiKey);
      if (!principalId) {
        throw new ApiError(401, "Invalid API key");
      }
      req.principalId = principalId;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Authenticates financial-transaction requests (/simulate, /transactions) by
 * capability token, resolving the token to exactly the agent it was issued for.
 * There is deliberately no request field a caller can use to assert "I am agent X" —
 * identity comes only from the token's own revocation id, looked up against the
 * AgentStore record created at issuance time (see src/capability/token.ts's
 * getOwnRevocationId and docs there for why this is more reliable than parsing the
 * token's embedded facts). Sets req.agent and req.agentToken.
 */
export function requireAgentToken(rootPublicKey: PublicKey, agents: AgentStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const tokenBase64 = extractBearer(req);

      let ownRevocationId: string;
      try {
        ownRevocationId = getOwnRevocationId(tokenBase64, rootPublicKey);
      } catch (error) {
        throw new ApiError(401, `Invalid capability token: ${error instanceof Error ? error.message : String(error)}`);
      }

      const agent = agents.getByRevocationId(ownRevocationId);
      if (!agent) {
        throw new ApiError(401, "Token does not correspond to any registered agent");
      }

      req.agent = agent;
      req.agentToken = tokenBase64;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** For principal-authenticated routes that act on a specific agent (revoke, graph, single-agent lookup): confirms the authenticated principal actually owns that agent. */
export function requireOwnedAgent(agents: AgentStore, agentId: string, principalId: string) {
  const agent = agents.get(agentId);
  if (!agent) {
    throw new ApiError(404, `Agent "${agentId}" not found`);
  }
  if (agent.principalId !== principalId) {
    throw new ApiError(403, `Agent "${agentId}" does not belong to this principal`);
  }
  return agent;
}

/**
 * For principal-authenticated routes that act on a specific mission by id
 * (GET /missions/:id, POST /missions/:id/cancel). Deliberately stricter than
 * requireOwnedAgent above: a mission belongs to someone else returns the exact same
 * 404 as a mission that doesn't exist at all, never a 403 — so a caller guessing
 * missionIds can never learn that a given id exists (and thus, indirectly, sniff
 * missionId patterns/existence) merely by observing a 403-vs-404 status difference. A
 * bare agentId is treated as lower-sensitivity information elsewhere in this API
 * (requireOwnedAgent's 403 does confirm existence); a mission additionally carries a
 * financial goal and budget, which this endpoint holds to a stricter disclosure bar.
 */
export function requireOwnedMission(missions: MissionStore, missionId: string, principalId: string): MissionRecord {
  const mission = missions.get(missionId);
  if (!mission || mission.principalId !== principalId) {
    throw new ApiError(404, `Mission "${missionId}" not found`);
  }
  return mission;
}
