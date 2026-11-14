import type { RequestHandler } from "express";

export interface RateLimitOptions {
  /** Maximum requests per client IP per window. */
  max: number;
  windowMs: number;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * A small fixed-window, in-process limiter keyed by client IP. Intended for the two
 * unauthenticated, state-creating endpoints (`POST /principals`, `POST /lab/principals`).
 * It is per-process: with several instances behind a load balancer each keeps its own
 * counters, which is acceptable for abuse dampening but is not a global quota. Behind a
 * reverse proxy, set AEGIS_TRUST_PROXY so `req.ip` is the real client, not the proxy.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const MAX_TRACKED_CLIENTS = 10_000;

  return (req, res, next) => {
    const t = now();
    if (buckets.size > MAX_TRACKED_CLIENTS) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= t) buckets.delete(key);
      }
      // Still full of live buckets: drop the oldest rather than grow without bound.
      if (buckets.size > MAX_TRACKED_CLIENTS) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    }

    const key = req.ip ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - t) / 1000))));
      res.status(429).json({ error: "Too many requests — try again later" });
      return;
    }
    next();
  };
}
