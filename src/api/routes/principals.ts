import { Router } from "express";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import { parsePrincipalBody } from "../validation.js";
import { requirePrincipalAuth } from "../auth.js";

export function createPrincipalsRouter(deps: AppDependencies): Router {
  const router = Router();
  const requirePrincipal = requirePrincipalAuth(deps.principals);

  router.post("/principals", (req, res) => {
    const { principalId } = parsePrincipalBody(req.body);
    let apiKey: string;
    try {
      apiKey = deps.principals.create(principalId);
    } catch (error) {
      throw new ApiError(409, error instanceof Error ? error.message : String(error));
    }
    res.status(201).json({ principalId, apiKey });
  });

  /**
   * "Who does this API key belong to" — the one authoritative source the frontend's
   * sign-in form needs to safely verify a user-typed Principal ID against a user-typed
   * API key without ever trusting the client's own claim of identity. req.principalId
   * is set by requirePrincipalAuth from principals.authenticate(apiKey) — derived
   * purely from the key itself (a hash lookup), never from anything the client
   * asserts — so this can never be tricked into returning an identity the presented
   * key doesn't actually own. Previously the dashboard derived this indirectly and
   * unreliably from GET /agents's first agent (which doesn't exist for a principal
   * with no agents yet); this is the direct, always-correct replacement.
   */
  router.get("/principals/me", requirePrincipal, (req, res) => {
    res.status(200).json({ principalId: req.principalId! });
  });

  return router;
}
