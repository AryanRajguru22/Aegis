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

/**
 * Throttles clients that keep presenting bad credentials. Every response with status 401
 * counts as a failure against the client's IP; once `maxFailures` is reached inside the
 * window, further requests from that IP get 429 until the window passes. Credentials are
 * 256-bit random values, so guessing is infeasible regardless — this bounds log noise and
 * wasted work from scanners. Per-process and in memory, like createRateLimiter.
 */
export function createAuthFailureLimiter(options: { maxFailures: number; windowMs: number; now?: () => number }): RequestHandler {
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const MAX_TRACKED = 10_000;

  return (req, res, next) => {
    const t = now();
    const key = req.ip ?? "unknown";
    const current = failures.get(key);
    if (current && current.resetAt > t && current.count >= options.maxFailures) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - t) / 1000))));
      res.status(429).json({ error: "Too many failed authentication attempts — try again later" });
      return;
    }
    res.on("finish", () => {
      if (res.statusCode !== 401) return;
      const at = now();
      if (failures.size > MAX_TRACKED) {
        for (const [k, v] of failures) if (v.resetAt <= at) failures.delete(k);
        if (failures.size > MAX_TRACKED) {
          const oldest = failures.keys().next().value;
          if (oldest !== undefined) failures.delete(oldest);
        }
      }
      let entry = failures.get(key);
      if (!entry || entry.resetAt <= at) {
        entry = { count: 0, resetAt: at + options.windowMs };
        failures.set(key, entry);
      }
      entry.count += 1;
    });
    next();
  };
}
