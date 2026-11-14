import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export type LogSink = (line: string) => void;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Assigns each request a correlation id (honouring a well-formed inbound X-Request-Id,
 * otherwise generating one), echoes it in the response, and — when a sink is supplied —
 * writes one JSON access-log line per finished request.
 *
 * What is logged: time, id, method, path (no query string), status, duration, and the
 * authenticated principal id when there is one. What is never logged: headers (so no
 * Authorization / API keys / capability tokens), query strings, request or response
 * bodies, client IPs.
 */
export function requestLogger(sink?: LogSink): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header("x-request-id");
    const id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.locals.requestId = id;
    res.setHeader("X-Request-Id", id);
    if (sink) {
      const started = process.hrtime.bigint();
      res.on("finish", () => {
        if (req.path === "/healthz" || req.path === "/readyz") return;
        sink(
          JSON.stringify({
            t: new Date().toISOString(),
            level: res.statusCode >= 500 ? "error" : "info",
            msg: "request",
            id,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
            ...(req.principalId ? { principal: req.principalId } : {}),
          })
        );
      });
    }
    next();
  };
}
