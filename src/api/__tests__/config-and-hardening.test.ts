import { test, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import { envString, parsePort, parseSignupRateLimit, parseTrustProxy } from "../config.js";
import { createRateLimiter } from "../rateLimit.js";
import { buildHarness } from "./harness.js";

describe("environment parsing", () => {
  test("blank values count as unset (a copied .env.example must boot)", () => {
    assert.equal(envString(undefined), undefined);
    assert.equal(envString(""), undefined);
    assert.equal(envString("   "), undefined);
    assert.equal(envString(" x "), "x");
    assert.equal(parsePort(""), 8787);
    assert.equal(parseTrustProxy(""), undefined);
    assert.equal(parseSignupRateLimit(""), 30);
  });

  test("PORT must be a valid port", () => {
    assert.equal(parsePort("9000"), 9000);
    for (const bad of ["0", "65536", "abc", "-1", "80.5"]) assert.throws(() => parsePort(bad), /PORT/);
  });

  test("AEGIS_TRUST_PROXY variants", () => {
    assert.equal(parseTrustProxy("false"), undefined);
    assert.equal(parseTrustProxy("true"), true);
    assert.equal(parseTrustProxy("1"), 1);
    assert.equal(parseTrustProxy("loopback, 10.0.0.0/8"), "loopback, 10.0.0.0/8");
  });

  test("AEGIS_SIGNUP_RATE_LIMIT must be a whole number", () => {
    assert.equal(parseSignupRateLimit("5"), 5);
    assert.equal(parseSignupRateLimit("0"), 0);
    assert.throws(() => parseSignupRateLimit("many"), /AEGIS_SIGNUP_RATE_LIMIT/);
  });
});

describe("rate limiter", () => {
  test("allows up to max per window, then 429 with Retry-After; resets after the window", async () => {
    let t = 1_000;
    const app = express();
    app.post("/x", createRateLimiter({ max: 2, windowMs: 60_000, now: () => t }), (_req, res) => {
      res.json({ ok: true });
    });
    assert.equal((await request(app).post("/x")).status, 200);
    assert.equal((await request(app).post("/x")).status, 200);
    const blocked = await request(app).post("/x");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    t += 61_000;
    assert.equal((await request(app).post("/x")).status, 200);
  });
});

describe("security headers, health and body limits", () => {
  test("every response carries the baseline security headers; the CSP forbids inline script", async () => {
    const { app } = buildHarness();
    for (const path of ["/", "/healthz", "/nope"]) {
      const res = await request(app).get(path);
      assert.equal(res.headers["x-content-type-options"], "nosniff", path);
      assert.equal(res.headers["x-frame-options"], "DENY", path);
      assert.equal(res.headers["x-powered-by"], undefined, path);
      const csp = String(res.headers["content-security-policy"]);
      assert.match(csp, /script-src 'self'(;|$)/, path);
      assert.match(csp, /frame-ancestors 'none'/, path);
    }
  });

  test("API responses are not cacheable", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/healthz");
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("/healthz is 200 when the probe passes and 503 with no detail when it throws", async () => {
    const ok = buildHarness({ healthCheck: () => {} });
    assert.equal((await request(ok.app).get("/healthz")).status, 200);
    const bad = buildHarness({
      healthCheck: () => {
        throw new Error("database is locked: /secret/path");
      },
    });
    const res = await request(bad.app).get("/healthz");
    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /secret|locked/);
  });

  test("an oversized JSON body is rejected, not parsed", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post("/principals")
      .send({ principalId: "x", pad: "a".repeat(200_000) });
    assert.equal(res.status, 413);
  });

  test("unexpected errors never leak a stack trace or message", async () => {
    const { app } = buildHarness({
      healthCheck: () => {},
    });
    const res = await request(app).post("/principals").set("Content-Type", "application/json").send("{bad json");
    assert.equal(res.status, 400);
    assert.doesNotMatch(JSON.stringify(res.body), /at .*\.js|SyntaxError/);
  });
});
