import type { RequestHandler } from "express";

/**
 * Baseline response headers for the dashboard and API. The dashboard is same-origin
 * (no CORS is configured, deliberately: browsers on other origins cannot read API
 * responses) and loads exactly one script, `/app.js`, plus Google Fonts. Inline styles
 * are used by the markup, so `style-src` allows them; inline *scripts* are not allowed.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Only meaningful (and only sent) when the request really arrived over TLS — either
  // directly or via a proxy the operator declared with AEGIS_TRUST_PROXY.
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  // API responses carry credentials-derived data; never let an intermediary cache them.
  if (!/\.(?:js|css|png|jpe?g|svg|ico|woff2?)$/.test(req.path) && req.path !== "/") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
};
