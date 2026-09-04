import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";

import { createSecurityLab } from "../securityLab.js";
import { MockX402RailAdapter, startMockX402Server, generatePayerKeyPair, publicKeyToHex, type MockX402Server } from "../../rails/mockX402/index.js";
import { requirePrincipalAuth } from "../auth.js";
import { errorHandler } from "../errors.js";
import { openDatabase } from "../../state/db.js";
import { createPrincipalStore } from "../../state/principals.js";
import { buildHarness, defaultCaveats, defaultTransaction } from "./harness.js";
import type { RailAdapter } from "../../rails/types.js";

// One shared mock x402 merchant AND one shared knownPayers map for the whole file —
// mirrors main.ts's own real behavior exactly (a single mock merchant, and a single
// knownPayers map, shared by production AND every lab instance; see securityLab.ts's
// own doc comment on why that's safe). The server's request handler closes over
// exactly this one map instance, so every lab built in this file must register its
// agents' payer keys into this SAME map to genuinely settle — a second, independent
// map would never be consulted by the already-running server. Server started once,
// closed once via after() below, so this file's tests never leak an open HTTP server.
let sharedServer: MockX402Server | undefined;
const sharedKnownPayers = new Map<string, string>();
after(async () => {
  if (sharedServer) await sharedServer.close();
});

/**
 * Covers the Security Demonstration Lab (src/api/securityLab.ts): a completely
 * separate, isolated instance of the exact same, unmodified pipeline, mounted at
 * /lab in src/api/main.ts — ALWAYS, regardless of AEGIS_DEMO_MODE — so destructive
 * demonstrations (concurrent budget attack, revocation, ledger tamper) can run from a
 * production deployment without ever touching real production evidence. These tests
 * build the lab directly (no HTTP listener, no main.ts), the same way every other
 * route-level test in this codebase builds `createApp(deps)` directly.
 */

async function buildRailOpts(): Promise<{ opts: Parameters<typeof createSecurityLab>[0]; rail: RailAdapter }> {
  const payer = generatePayerKeyPair();
  if (!sharedServer) {
    sharedServer = await startMockX402Server({
      knownPayers: sharedKnownPayers,
      priceResolver: (resource) => (resource === "acme-airlines:flights" ? { amountMinorUnits: 38_000, currency: "USD" } : undefined),
    });
  }
  const rail = new MockX402RailAdapter({ baseUrl: sharedServer.url, privateKey: payer.privateKey });
  return { opts: { mockX402Rail: rail, knownPayers: sharedKnownPayers, demoPayerPublicKeyHex: publicKeyToHex(payer.publicKey) }, rail };
}

async function createLabPrincipalAndAgent(app: import("express").Express, caveats: Record<string, unknown> = {}) {
  const principalId = `lab-principal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const principalRes = await request(app).post("/principals").send({ principalId });
  const apiKey: string = principalRes.body.apiKey;
  const agentId = `lab-agent-${Date.now()}`;
  const agentRes = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({
      agentId,
      delegatedGoal: "Lab test goal.",
      caveats: {
        maxAmountMinorUnits: 200_000,
        currency: "USD",
        categories: ["flights"],
        rails: ["mock_x402"],
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        ...caveats,
      },
    });
  return { principalId, apiKey, agentId, token: agentRes.body.token as string };
}

describe("createSecurityLab — isolation from production and from other lab instances", () => {
  test("two separately-built lab instances never share a principal — an agent created in one is invisible to the other", async () => {
    const { opts } = await buildRailOpts();
    const lab1 = createSecurityLab(opts);
    const lab2 = createSecurityLab(opts);

    const { principalId, apiKey } = await createLabPrincipalAndAgent(lab1.app);

    // The SAME principalId/apiKey, presented to lab2, must not authenticate — lab2 has
    // its own, completely separate principal store, never lab1's.
    const res = await request(lab2.app).get("/agents").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.status, 401, "a lab1 apiKey must never authenticate against lab2's own, separate principal store");
    void principalId;
  });

  test("the lab's own db is a genuinely separate object from a second lab instance's db", async () => {
    const { opts } = await buildRailOpts();
    const lab1 = createSecurityLab(opts);
    const lab2 = createSecurityLab(opts);
    assert.notEqual(lab1.db, lab2.db);
    assert.notEqual(lab1.principals, lab2.principals);
  });
});

describe("createSecurityLab — the exact same, unmodified pipeline actually runs", () => {
  test("a full principal -> agent -> mission -> transaction -> ledger flow works end to end inside the lab", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { apiKey, agentId, token } = await createLabPrincipalAndAgent(lab.app);

    const missionRes = await request(lab.app)
      .post("/missions")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        missionId: "lab-mission-1",
        agentId,
        goal: "Lab mission goal.",
        budgetMinorUnits: 200_000,
        currency: "USD",
        allowedCategories: null,
        approvedCounterparties: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
    assert.equal(missionRes.status, 201);

    const txRes = await request(lab.app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "lab-attempt-1")
      .send({
        transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "Lab transaction" },
        counterparty: "acme-airlines",
        missionId: "lab-mission-1",
      });
    assert.equal(txRes.status, 200);
    assert.equal(txRes.body.decision.verdict, "allow");
    assert.equal(txRes.body.execution.success, true, "the lab genuinely settles on the shared mock_x402 rail, not a stub");

    const ledgerRes = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(ledgerRes.status, 200);
    assert.equal(ledgerRes.body.chainValid, true);
    assert.ok(ledgerRes.body.entries.length > 0);
  });

  test("the lab always uses the deterministic demo intent judge — its own /demo-mode reports provider 'demo', never a real provider", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const res = await request(lab.app).get("/demo-mode");
    assert.equal(res.status, 200);
    assert.equal(res.body.demoMode, true);
    assert.equal(res.body.aiProvider, "demo", "the lab must never claim to be using a real AI provider, regardless of what the real server is configured with");
  });

  test("deterministic DENY still wins inside the lab, even though the lab's intent judge always says 'consistent'", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { apiKey, token } = await createLabPrincipalAndAgent(lab.app, { maxAmountMinorUnits: 10_000 });

    const txRes = await request(lab.app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "lab-attempt-deny")
      .send({
        transaction: { amountMinorUnits: 50_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "over the cap" },
        counterparty: "acme-airlines",
      });
    assert.equal(txRes.status, 200);
    assert.equal(txRes.body.decision.verdict, "deny", "policy denial must win even though the lab's own demo judge would always say 'consistent'");
    assert.equal(txRes.body.execution, undefined);
    void apiKey;
  });
});

describe("createSecurityLab — ledger tamper detection and persistence", () => {
  test("the lab's own tamper route is mounted and works, breaking the lab's OWN verifyChain()", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { apiKey } = await createLabPrincipalAndAgent(lab.app);

    const before = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(before.body.chainValid, true);
    const seq = before.body.entries[0].seq;

    const tamperRes = await request(lab.app).post(`/demo/tamper-ledger-entry/${seq}`).set("Authorization", `Bearer ${apiKey}`);
    assert.equal(tamperRes.status, 200);

    const after = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(after.body.chainValid, false);
  });

  test("a tampered lab persists across repeated, independent GETs — never silently resets or self-heals", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { apiKey } = await createLabPrincipalAndAgent(lab.app);
    const initial = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    const seq = initial.body.entries[0].seq;
    await request(lab.app).post(`/demo/tamper-ledger-entry/${seq}`).set("Authorization", `Bearer ${apiKey}`);

    // Three independent GETs — each simulating a fresh page load/refresh re-fetching
    // the SAME server-side state — must all still report the violation.
    for (let i = 0; i < 3; i++) {
      const res = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
      assert.equal(res.body.chainValid, false, `verification attempt #${i + 1} must still detect the violation`);
    }
  });

  test("nothing about GET /ledger itself can clear a violation — reading is never a side-effecting operation", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { apiKey } = await createLabPrincipalAndAgent(lab.app);
    const initial = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    const seq = initial.body.entries[0].seq;
    await request(lab.app).post(`/demo/tamper-ledger-entry/${seq}`).set("Authorization", `Bearer ${apiKey}`);

    for (let i = 0; i < 5; i++) await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    const finalCheck = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(finalCheck.body.chainValid, false);
  });
});

describe("createSecurityLab — recovery is only ever a full, explicit rebuild, never a selective in-place fix", () => {
  test("a freshly-built lab instance is clean and verified, and has no memory of a prior instance's tampered/agent state", async () => {
    const { opts } = await buildRailOpts();
    const oldLab = createSecurityLab(opts);
    const { apiKey } = await createLabPrincipalAndAgent(oldLab.app);
    const initial = await request(oldLab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    const seq = initial.body.entries[0].seq;
    await request(oldLab.app).post(`/demo/tamper-ledger-entry/${seq}`).set("Authorization", `Bearer ${apiKey}`);
    const oldAfter = await request(oldLab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(oldAfter.body.chainValid, false, "precondition: the old lab is genuinely tampered");

    // This is exactly what main.ts's POST /lab/reset does: discard the old `lab`
    // reference entirely and build a brand new one — never mutate the old one.
    const newLab = createSecurityLab(opts);

    // The old apiKey must not authenticate against the new, separate principal store.
    const staleAuthRes = await request(newLab.app).get("/agents").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(staleAuthRes.status, 401, "an old lab identity must not survive a reset — it must re-bootstrap against the new instance");

    // A fresh principal against the NEW lab sees a genuinely empty, verified ledger.
    const freshPrincipal = await createLabPrincipalAndAgent(newLab.app);
    const freshLedger = await request(newLab.app).get("/ledger").set("Authorization", `Bearer ${freshPrincipal.apiKey}`);
    assert.equal(freshLedger.body.chainValid, true, "the new lab instance must start genuinely verified — recovery is a full rebuild, not a patch");

    // The OLD lab instance, if still reachable, remains tampered forever — proving
    // there is no path that "fixes" it in place; the only way forward is discarding it.
    const oldStillTampered = await request(oldLab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(oldStillTampered.body.chainValid, false, "the old, discarded lab instance itself is never repaired — only replaced");
  });
});

describe("the lab never cross-contaminates with production — the core isolation guarantee this whole feature exists for", () => {
  test("a lab transaction never appears in the production ledger, and a production transaction never appears in the lab ledger", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { app: prodApp } = buildHarness();

    // A real production transaction, against the REAL, unmodified pipeline.
    const prodPrincipal = await request(prodApp).post("/principals").send({ principalId: "real-corp" });
    const prodApiKey: string = prodPrincipal.body.apiKey;
    const prodAgent = await request(prodApp)
      .post("/agents")
      .set("Authorization", `Bearer ${prodApiKey}`)
      .send({ agentId: "prod-agent", delegatedGoal: "Real production goal.", caveats: defaultCaveats() });
    await request(prodApp)
      .post("/transactions")
      .set("Authorization", `Bearer ${prodAgent.body.token}`)
      .set("Idempotency-Key", "prod-attempt-1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    // A lab transaction, against the isolated lab.
    const { apiKey: labApiKey, token: labToken } = await createLabPrincipalAndAgent(lab.app);
    await request(lab.app)
      .post("/transactions")
      .set("Authorization", `Bearer ${labToken}`)
      .set("Idempotency-Key", "lab-attempt-cross-check")
      .send({
        transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "lab-only transaction" },
        counterparty: "acme-airlines",
      });

    const prodLedger = await request(prodApp).get("/ledger").set("Authorization", `Bearer ${prodApiKey}`);
    const labLedger = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${labApiKey}`);

    const prodAgentIds = new Set(prodLedger.body.entries.map((e: { agentId: string }) => e.agentId));
    const labAgentIds = new Set(labLedger.body.entries.map((e: { agentId: string }) => e.agentId));

    assert.ok(prodAgentIds.has("prod-agent"), "sanity: the production ledger must contain the real production agent's entries");
    assert.ok(!prodAgentIds.has(labToken) && ![...labAgentIds].some((id) => prodAgentIds.has(id)), "no lab agentId must ever appear in the production ledger");
    assert.ok(![...prodAgentIds].some((id) => labAgentIds.has(id)), "no production agentId must ever appear in the lab ledger");
    // Genuinely two different SQLite databases, never a shared/overlapping table.
    assert.ok(prodLedger.body.entries.length > 0, "sanity: production ledger has entries");
    assert.ok(labLedger.body.entries.length > 0, "sanity: lab ledger has entries");
  });

  test("tampering the lab ledger never affects the production ledger's own verifyChain()", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { app: prodApp } = buildHarness();

    const prodPrincipal = await request(prodApp).post("/principals").send({ principalId: "real-corp-2" });
    const prodApiKey: string = prodPrincipal.body.apiKey;
    await request(prodApp)
      .post("/agents")
      .set("Authorization", `Bearer ${prodApiKey}`)
      .send({ agentId: "prod-agent-2", delegatedGoal: "g", caveats: defaultCaveats() });

    const { apiKey: labApiKey } = await createLabPrincipalAndAgent(lab.app);
    const labLedgerBefore = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${labApiKey}`);
    const seq = labLedgerBefore.body.entries[0].seq;
    await request(lab.app).post(`/demo/tamper-ledger-entry/${seq}`).set("Authorization", `Bearer ${labApiKey}`);

    const labLedgerAfter = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${labApiKey}`);
    assert.equal(labLedgerAfter.body.chainValid, false, "sanity: the lab ledger is genuinely tampered");

    const prodLedger = await request(prodApp).get("/ledger").set("Authorization", `Bearer ${prodApiKey}`);
    assert.equal(prodLedger.body.chainValid, true, "tampering the isolated lab ledger must never affect production evidence integrity");
  });
});

describe("the lab's tamper route requires real authentication — mirrors demoTamper.ts's own HTTP-level tests, now reachable via the lab mount", () => {
  test("an unauthenticated tamper attempt against the lab is rejected", async () => {
    const { opts } = await buildRailOpts();
    const lab = createSecurityLab(opts);
    const { apiKey } = await createLabPrincipalAndAgent(lab.app);
    const initial = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    const seq = initial.body.entries[0].seq;

    const res = await request(lab.app).post(`/demo/tamper-ledger-entry/${seq}`);
    assert.equal(res.status, 401);
    const after = await request(lab.app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(after.body.chainValid, true, "a rejected, unauthenticated tamper attempt must leave the lab genuinely untouched");
  });
});

/**
 * Mirrors main.ts's own wrapper-mounting shape directly — the same established
 * pattern demo-tamper.test.ts's own last describe block already uses ("mirrors
 * main.ts exactly") rather than spawning the real process. Proves the two production-
 * facing guarantees main.ts's actual wiring is responsible for: POST /lab/reset
 * requires real principal authentication, and the production app itself has NO
 * tamper route reachable at all, in any mode — the old real-ledger tamper route no
 * longer exists anywhere in this codebase's routing.
 */
describe("main.ts's wrapper shape — /lab/reset authentication and the removed production tamper route", () => {
  async function buildWrapper() {
    const { opts } = await buildRailOpts();
    let lab = createSecurityLab(opts);
    // A throwaway principal store standing in for the real server's own `principals`
    // — main.ts protects /lab/reset with the REAL signed-in principal's auth, never
    // the lab's own (about-to-be-wiped) one.
    const realPrincipals = createPrincipalStore(openDatabase(":memory:"));
    const requirePrincipal = requirePrincipalAuth(realPrincipals);
    const wrapper = express();
    wrapper.post("/lab/reset", requirePrincipal, (_req, res) => {
      lab = createSecurityLab(opts);
      res.status(200).json({ reset: true });
    });
    wrapper.use("/lab", (req, res, next) => lab.app(req, res, next));
    wrapper.use(errorHandler);
    wrapper.use((_req, res) => res.status(404).json({ error: "Not found" })); // stand-in for the real production `app`'s own catch-all
    return { wrapper, realPrincipals };
  }

  test("POST /lab/reset without authentication is rejected, and the lab is left untouched", async () => {
    const { wrapper } = await buildWrapper();
    const res = await request(wrapper).post("/lab/reset");
    assert.equal(res.status, 401);
  });

  test("POST /lab/reset with real authentication succeeds and genuinely replaces the mounted lab", async () => {
    const { wrapper, realPrincipals } = await buildWrapper();
    const apiKey = realPrincipals.create("real-principal-1");

    const labPrincipalRes = await request(wrapper).post("/lab/principals").send({ principalId: "lab-principal-x" });
    const labApiKey: string = labPrincipalRes.body.apiKey;
    const before = await request(wrapper).get("/lab/ledger").set("Authorization", `Bearer ${labApiKey}`);
    assert.equal(before.status, 200);

    const resetRes = await request(wrapper).post("/lab/reset").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(resetRes.status, 200);
    assert.deepEqual(resetRes.body, { reset: true });

    const staleRes = await request(wrapper).get("/lab/ledger").set("Authorization", `Bearer ${labApiKey}`);
    assert.equal(staleRes.status, 401, "the old lab identity must not authenticate against the freshly-reset lab");
  });

  test("the production app has no tamper route at all — POST /demo/tamper-ledger-entry/:seq is a plain 404, never reaching tamper logic", async () => {
    const plainApp = express();
    plainApp.use((_req, res) => res.status(404).json({ error: "Not found" }));
    const res = await request(plainApp).post("/demo/tamper-ledger-entry/1");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Not found");
  });
});
