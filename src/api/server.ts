import path from "node:path";
import express, { type Express } from "express";
import "./types.js";
import type { AppDependencies } from "./deps.js";
import { requireAgentToken, requirePrincipalAuth } from "./auth.js";
import { errorHandler } from "./errors.js";
import { createPrincipalsRouter } from "./routes/principals.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createMissionsRouter } from "./routes/missions.js";
import { createTransactionsRouter } from "./routes/transactions.js";
import { createLedgerRouter } from "./routes/ledger.js";
import { createStreamRouter } from "./routes/stream.js";

/**
 * The API is a thin translation layer over the pipeline built and proven in earlier
 * steps (src/capability, src/state, src/risk, src/decision, src/execution) — every
 * route either (a) calls decideTransaction/executeTransaction directly with no
 * re-implementation of policy, risk, or execution logic, or (b) performs a single,
 * narrowly-scoped state mutation (issue/attenuate/revoke a token, append a ledger
 * entry) using the exact same functions proven in isolation in those modules' own
 * test suites. See docs/SYSTEM_ARCHITECTURE.md §8.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  // The dashboard (public/index.html, public/app.js) is static and talks to the API
  // exclusively over the same routes exercised in src/api/__tests__ — it has no
  // server-side rendering and no access of its own to anything privileged.
  app.use(express.static(path.join(import.meta.dirname, "../../public")));

  // Unauthenticated by design: this reveals only a server-wide config flag (whether
  // this instance was started with AEGIS_DEMO_MODE=true — see src/api/demoMode.ts),
  // never anything about a specific principal/agent/account, so it needs no auth
  // boundary — the dashboard fetches it before sign-in to show its demo-mode banner.
  app.get("/demo-mode", (_req, res) => {
    res.status(200).json({ demoMode: Boolean(deps.demoMode) });
  });

  const requirePrincipal = requirePrincipalAuth(deps.principals);
  const requireAgent = requireAgentToken(deps.rootPublicKey, deps.agents);

  app.use(createPrincipalsRouter(deps));
  app.use(createAgentsRouter(deps, requirePrincipal));
  app.use(createMissionsRouter(deps, requirePrincipal));
  app.use(createTransactionsRouter(deps, requireAgent));
  app.use(createLedgerRouter(deps, requirePrincipal));
  app.use(createStreamRouter(deps, requirePrincipal));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);

  return app;
}
