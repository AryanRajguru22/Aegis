import { Router } from "express";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import { parsePrincipalBody } from "../validation.js";

export function createPrincipalsRouter(deps: AppDependencies): Router {
  const router = Router();

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

  return router;
}
