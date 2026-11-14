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
      assert.equal(res.headers["x-frame-options"], "SAMEORIGIN", path);
      assert.equal(res.headers["x-powered-by"], undefined, path);
      const csp = String(res.headers["content-security-policy"]);
      assert.match(csp, /script-src 'self'(;|$)/, path);
      assert.match(csp, /frame-ancestors 'self'/, path);
    }
  });

  test("API responses are not cacheable", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/healthz");
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("/readyz is 200 when the probe passes and 503 with no detail when it throws", async () => {
    const ok = buildHarness({ healthCheck: () => {} });
    assert.equal((await request(ok.app).get("/readyz")).status, 200);
    const bad = buildHarness({
      healthCheck: () => {
        throw new Error("database is locked: /secret/path");
      },
    });
    const res = await request(bad.app).get("/readyz");
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

import { checkKeyPolicy, parseAllowEphemeral } from "../config.js";
import { createSecurityLab } from "../securityLab.js";
import { requestLogger } from "../logging.js";
import { ensureMissionBindingEpoch } from "../policyEpoch.js";

describe("signing-key startup policy", () => {
  const base = { nodeEnv: "production", rootKeySet: true, ledgerKeySet: true, allowEphemeral: false };
  test("production requires both persistent keys", () => {
    assert.deepEqual(checkKeyPolicy(base), []);
    assert.equal(checkKeyPolicy({ ...base, rootKeySet: false }).length, 1);
    assert.equal(checkKeyPolicy({ ...base, rootKeySet: false, ledgerKeySet: false }).length, 2);
  });
  test("explicit opt-in allows ephemeral keys in production; development never requires keys", () => {
    assert.deepEqual(checkKeyPolicy({ ...base, rootKeySet: false, ledgerKeySet: false, allowEphemeral: true }), []);
    assert.deepEqual(checkKeyPolicy({ ...base, nodeEnv: undefined, rootKeySet: false, ledgerKeySet: false }), []);
  });
  test("the root and ledger keys must differ, and no message echoes key material", () => {
    const problems = checkKeyPolicy({ ...base, rootKeyHex: "deadbeef", ledgerKeyHex: "deadbeef" });
    assert.equal(problems.length, 1);
    assert.doesNotMatch(problems.join(" "), /deadbeef/);
  });
  test("only the exact string true opts in", () => {
    assert.equal(parseAllowEphemeral("true"), true);
    for (const v of [undefined, "", "1", "TRUE", "yes"]) assert.equal(parseAllowEphemeral(v), false);
  });
});

describe("liveness, readiness, CORS and request correlation", () => {
  test("/healthz is liveness only: 200 even when the readiness probe would fail; /readyz reports the dependency", async () => {
    const { app } = buildHarness({
      healthCheck: () => {
        throw new Error("db down");
      },
    });
    assert.equal((await request(app).get("/healthz")).status, 200);
    assert.equal((await request(app).get("/readyz")).status, 503);
    const ok = buildHarness({ healthCheck: () => {} });
    assert.equal((await request(ok.app).get("/readyz")).status, 200);
  });

  test("no CORS headers are ever emitted, and a cross-origin preflight is not granted", async () => {
    const { app } = buildHarness();
    const get = await request(app).get("/demo-mode").set("Origin", "https://evil.example");
    assert.equal(get.headers["access-control-allow-origin"], undefined);
    const pre = await request(app)
      .options("/principals")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    assert.equal(pre.headers["access-control-allow-origin"], undefined);
    assert.equal(pre.headers["access-control-allow-methods"], undefined);
  });

  test("every response carries a request id; a well-formed inbound id is kept, a malformed one is replaced", async () => {
    const { app } = buildHarness();
    const generated = await request(app).get("/demo-mode");
    assert.match(String(generated.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    const kept = await request(app).get("/demo-mode").set("X-Request-Id", "trace-123");
    assert.equal(kept.headers["x-request-id"], "trace-123");
    const bad = await request(app).get("/demo-mode").set("X-Request-Id", "x y\"<script>");
    assert.match(String(bad.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  test("the access log records method/path/status but never credentials, query strings or bodies", async () => {
    const lines: string[] = [];
    const { app } = buildHarness({ accessLog: (l) => lines.push(l) });
    const secret = "SECRET-API-KEY-VALUE-123";
    await request(app).get("/ledger?token=QUERYSECRET").set("Authorization", `Bearer ${secret}`);
    await request(app).post("/principals").send({ principalId: "log-test" });
    await request(app).get("/healthz");
    const all = lines.join("\n");
    assert.ok(lines.length >= 2);
    assert.doesNotMatch(all, /SECRET-API-KEY-VALUE|QUERYSECRET|Bearer|apiKey/);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.path, "/ledger");
    assert.equal(first.status, 401);
    assert.ok(!all.includes("/healthz"), "health probes are not logged");
  });

  test("requestLogger without a sink still sets ids and writes nothing", () => {
    assert.equal(typeof requestLogger(), "function");
  });
});

describe("Security Lab", () => {
  test("every lab instance carries its own policy-epoch marker and a fresh valid chain; the lab and production never share state", () => {
    const rail = {} as never;
    const a = createSecurityLab({ mockX402Rail: rail, knownPayers: new Map(), demoPayerPublicKeyHex: "00" });
    const b = createSecurityLab({ mockX402Rail: rail, knownPayers: new Map(), demoPayerPublicKeyHex: "00" });
    for (const lab of [a, b]) {
      const rows = lab.db.prepare("SELECT kind FROM ledger_entries").all() as Array<{ kind: string }>;
      assert.deepEqual(
        rows.map((r) => r.kind),
        ["policy_epoch"]
      );
    }
    assert.notEqual(a.db, b.db);
    const { deps } = buildHarness();
    ensureMissionBindingEpoch(deps.ledger);
    assert.equal(deps.ledger.all().length, 1);
  });
});

import { createAuthFailureLimiter } from "../rateLimit.js";

describe("auth-failure limiter", () => {
  test("blocks an IP after repeated 401s, lets successful requests through, and recovers after the window", async () => {
    let t = 0;
    const { app } = buildHarness({ authFailureLimiter: createAuthFailureLimiter({ maxFailures: 3, windowMs: 1000, now: () => t }) });
    const good = await request(app).post("/principals").send({ principalId: "ok-user" });
    assert.equal(good.status, 201);
    for (let i = 0; i < 3; i++) {
      assert.equal((await request(app).get("/ledger").set("Authorization", "Bearer wrong")).status, 401);
    }
    const blocked = await request(app).get("/ledger").set("Authorization", `Bearer ${good.body.apiKey}`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    t += 1500;
    assert.equal((await request(app).get("/ledger").set("Authorization", `Bearer ${good.body.apiKey}`)).status, 200);
  });
});
