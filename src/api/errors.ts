import type { ErrorRequestHandler } from "express";

/** A well-formed HTTP error a route deliberately raises — the error-handling middleware trusts its status and message are safe to send to the client. Anything else that reaches the middleware is treated as unexpected and returns a generic 500, logged server-side but not leaked to the caller. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // express.json() reports a malformed request body as a SyntaxError with status 400
  // (set by body-parser) — trust exactly that shape, not an arbitrary err.status from
  // elsewhere, and translate it into the same clean error shape as every other 400.
  if (err instanceof SyntaxError && (err as SyntaxError & { status?: number }).status === 400) {
    res.status(400).json({ error: "Malformed JSON in request body" });
    return;
  }
  // Other client-caused body-parser failures (oversized body, unsupported charset or
  // encoding) carry a 4xx status and a `type` beginning "entity." / "encoding." /
  // "charset." — safe to report by status with a fixed message, never the raw error.
  const parserError = err as { status?: unknown; type?: unknown };
  if (
    typeof parserError.type === "string" &&
    /^(entity|encoding|charset|request)\./.test(parserError.type) &&
    typeof parserError.status === "number" &&
    parserError.status >= 400 &&
    parserError.status < 500
  ) {
    const message = parserError.status === 413 ? "Request body too large" : "Invalid request body";
    res.status(parserError.status).json({ error: message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("Unexpected API error:", err);
  res.status(500).json({ error: "Internal server error" });
};
