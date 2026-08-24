import { Router, type RequestHandler } from "express";
import type { LedgerEntry } from "../../state/ledger.js";
import type { AppDependencies } from "../deps.js";

export function createStreamRouter(deps: AppDependencies, requirePrincipal: RequestHandler): Router {
  const router = Router();

  router.get("/stream", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`: connected\n\n`);

    const onEntry = (entry: LedgerEntry): void => {
      if (entry.principalId !== principalId) return;
      res.write(`event: ledger_entry\ndata: ${JSON.stringify(entry)}\n\n`);
    };
    deps.ledger.events.on("entry", onEntry);

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      deps.ledger.events.off("entry", onEntry);
    });
  });

  return router;
}
