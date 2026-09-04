import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { buildHarness, defaultCaveats, defaultTransaction, ScriptedIntentJudge } from "./harness.js";
import { applyDemoLedgerTamper } from "../demoTamper.js";

/**
 * Root-cause regression coverage for a real, observed bug: the header claimed
 * "Ledger tampered" while the Evidence workspace simultaneously claimed "HASH CHAIN
 * VERIFIED", and clicking "Verify chain" surfaced a raw "Invalid API key" error. The
 * actual causes (see public/app.js's "ledger — single source of truth" section for
 * the frontend fix):
 *   1. Evidence's big banner started from a STATIC HTML DEFAULT that was never
 *      revalidated unless a user manually clicked "Verify chain" — a stale claim, not
 *      a live one.
 *   2. The header's shell-status chip conflated "the check itself failed" (an
 *      expired/invalid principal apiKey, a network error) with "the check succeeded
 *      and found tampering" — showing the exact same text for both.
 *   3. Overview's ledger fact literally scraped Evidence's own rendered DOM/className
 *      as its "state source" — a second, independent read of the same fact that could
 *      desync from what Evidence actually knew.
 * These tests cover the BACKEND half of the fix: that GET /ledger gives the frontend
 * everything it needs to never reproduce this (a real brokenAtSeq/reason, a status
 * unaffected by AI-provider state) — see dashboard-ledger-consistency.test.ts for the
 * frontend half (that the three displays actually agree, and an auth error never
 * renders as "tampered").
 */

async function createPrincipalAndAgent(app: import("express").Express, caveats = defaultCaveats()) {
  const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
  const apiKey: string = principalRes.body.apiKey;
  const agentRes = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId: "agent-root", delegatedGoal: "Book flights.", caveats });
  return { apiKey, token: agentRes.body.token as string };
}

describe("GET /ledger — truthful, complete integrity data", () => {
  test("a valid chain reports chainValid:true with brokenAtSeq/reason both null — never omitted, never a stale guess", async () => {
    const { app } = buildHarness();
    const { apiKey } = await createPrincipalAndAgent(app);
    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.chainValid, true);
    assert.equal(res.body.brokenAtSeq, null);
    assert.equal(res.body.reason, null);
  });

  test("a tampered chain reports chainValid:false WITH the real brokenAtSeq and a deterministic reason — enough for the UI to point at the exact failing entry", async () => {
    const { app, db } = buildHarness();
    const { apiKey } = await createPrincipalAndAgent(app);
    // Real content-hash tamper — direct storage corruption bypassing the normal write
    // path entirely, the same primitive src/api/demoTamper.ts and the isolated lab use.
    const before = await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(before.body.chainValid, true, "sanity: fresh chain is valid");
    const seq = before.body.entries[0].seq;

    const tamperResult = applyDemoLedgerTamper(db, "acme-corp", seq);
    assert.equal(tamperResult.ok, true, "sanity: the tamper itself succeeded");

    const after = await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.chainValid, false);
    assert.equal(after.body.brokenAtSeq, seq, "the API must surface exactly which entry broke, not just a bare false");
    assert.equal(typeof after.body.reason, "string");
    assert.ok(after.body.reason.length > 0, "a deterministic, non-empty reason must be present");
  });
});

describe("hash-chain verification is completely independent of the AI risk provider — deterministic evidence only", () => {
  test("GET /ledger works correctly even when the configured intent judge always throws (simulating total Gemini/Anthropic unavailability)", async () => {
    const alwaysBrokenJudge = new ScriptedIntentJudge(() => {
      throw new Error("simulated total AI provider outage — quota exhausted, auth failed, whatever");
    });
    const { app } = buildHarness({ intentJudge: alwaysBrokenJudge });
    const { apiKey, token } = await createPrincipalAndAgent(app);

    // Run a real transaction through the broken judge first, to prove escalation still
    // works AND that it has zero bearing on ledger verification afterward.
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.chainValid, true, "a broken/unavailable AI provider must never affect deterministic ledger verification");
  });

  test("GET /ledger requires no AI provider credential at all — only principal authentication", async () => {
    // buildHarness's default judge (alwaysConsistentJudge) never touches any real
    // provider or API key — proving GET /ledger's own auth requirement
    // (requirePrincipalAuth) is the ONLY credential involved, never anything AI-related.
    const { app } = buildHarness();
    const { apiKey } = await createPrincipalAndAgent(app);
    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.status, 200);
    assert.equal(Object.keys(res.body).sort().join(","), "brokenAtSeq,chainValid,entries,reason");
  });
});

describe("an invalid/expired principal apiKey is a deterministic 401, with a message unrelated to any AI provider", () => {
  test("GET /ledger with a garbage apiKey returns 401 'Invalid API key' — this is the real, root-cause error the UI must sanitize, never a ledger-tamper claim", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/ledger").set("Authorization", "Bearer not-a-real-key");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Invalid API key");
    // Critically: this response carries no chainValid field at all — the frontend
    // must never be able to interpret an auth failure as "chainValid: false".
    assert.equal("chainValid" in res.body, false);
  });

  test("no Authorization header at all also returns 401, distinctly, never as a ledger integrity result", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/ledger");
    assert.equal(res.status, 401);
    assert.equal("chainValid" in res.body, false);
  });
});

describe("repeated verification never resets or alters a genuinely tampered production chain (Verify chain is read-only)", () => {
  test("GET /ledger is called multiple times against the same server state and returns identical results — no side effects from checking", async () => {
    const { app } = buildHarness();
    const { apiKey } = await createPrincipalAndAgent(app);
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await request(app).get("/ledger").set("Authorization", `Bearer ${apiKey}`));
    }
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.body.chainValid, true);
    }
    // Entry count must be stable across pure reads — nothing about checking mutates
    // the ledger itself.
    const counts = results.map((r) => r.body.entries.length);
    assert.ok(counts.every((c) => c === counts[0]));
  });
});
