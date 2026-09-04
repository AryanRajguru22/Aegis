import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { AnthropicIntentJudge } from "../../risk/anthropicJudge.js";
import { GeminiIntentJudge } from "../../risk/geminiJudge.js";
import { createDemoIntentJudge, createServerIntentJudge } from "../demoMode.js";
import { safeJudge } from "../../decision/decide.js";
import type { IntentJudge, IntentJudgeInput, IntentJudgment } from "../../risk/types.js";
import { buildHarness, defaultCaveats, defaultTransaction } from "./harness.js";

/**
 * Covers truthful AI provenance end to end: each real IntentJudge implementation
 * self-reports its own provider/model (src/risk/types.ts's IntentJudge.provider/
 * .model), safeJudge() (src/decision/decide.ts) carries that through to every
 * SafeIntentJudgment it returns — success or "unavailable" alike — and GET /demo-mode
 * (src/api/server.ts) exposes it truthfully for the dashboard's header badge. The
 * core property under test throughout: the dashboard must never be able to claim a
 * provider that isn't what actually judged (or was attempted for) a given decision.
 */

describe("IntentJudge implementations self-report truthful provenance", () => {
  test("createDemoIntentJudge() reports provider 'demo'", () => {
    const judge = createDemoIntentJudge();
    assert.equal(judge.provider, "demo");
  });

  test("AnthropicIntentJudge reports provider 'anthropic' and its configured model", () => {
    const judge = new AnthropicIntentJudge({ apiKey: "sk-ant-not-a-real-key-just-shape-checking" });
    assert.equal(judge.provider, "anthropic");
    assert.equal(typeof judge.model, "string");
    assert.ok(judge.model.length > 0);
  });

  test("AnthropicIntentJudge honors an explicit model override in its reported provenance", () => {
    const judge = new AnthropicIntentJudge({ apiKey: "sk-ant-not-a-real-key-just-shape-checking", model: "claude-custom-test-model" });
    assert.equal(judge.model, "claude-custom-test-model");
  });

  test("GeminiIntentJudge reports provider 'gemini' and its configured model", () => {
    const judge = new GeminiIntentJudge({ client: { models: { async generateContent() { return { text: '{"verdict":"consistent","rationale":"ok"}' }; } } } });
    assert.equal(judge.provider, "gemini");
    assert.equal(typeof judge.model, "string");
    assert.ok(judge.model.length > 0);
  });

  test("GeminiIntentJudge honors an explicit model override in its reported provenance", () => {
    const judge = new GeminiIntentJudge({
      model: "gemini-custom-test-model",
      client: { models: { async generateContent() { return { text: '{"verdict":"consistent","rationale":"ok"}' }; } } },
    });
    assert.equal(judge.model, "gemini-custom-test-model");
  });

  test("createServerIntentJudge selects the correct real implementation, and its provenance matches", () => {
    const geminiJudge = createServerIntentJudge({ demoMode: false, geminiApiKey: "gemini-shaped-key" });
    assert.ok(geminiJudge instanceof GeminiIntentJudge);
    assert.equal(geminiJudge.provider, "gemini");

    const anthropicJudge = createServerIntentJudge({ demoMode: false, anthropicApiKey: "sk-ant-shaped-key" });
    assert.ok(anthropicJudge instanceof AnthropicIntentJudge);
    assert.equal(anthropicJudge.provider, "anthropic");

    const demoJudge = createServerIntentJudge({ demoMode: true });
    assert.equal(demoJudge.provider, "demo");
  });
});

describe("safeJudge() carries provenance through to every SafeIntentJudgment, success or failure alike", () => {
  function fakeProvenancedJudge(provider: string, model: string, respond: (input: IntentJudgeInput) => Promise<IntentJudgment> | never): IntentJudge {
    return { provider, model, judge: respond };
  }

  test("a successful judgment carries the judge's own provider/model", async () => {
    const judge = fakeProvenancedJudge("gemini", "gemini-3.6-flash", async () => ({ verdict: "consistent", rationale: "ok" }));
    const result = await safeJudge(judge, { delegatedGoal: "g", transaction: { amountMinorUnits: 1, currency: "USD", category: "c", rail: "r", purpose: "p" } });
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-3.6-flash");
    assert.equal(result.verdict, "consistent");
  });

  test("a thrown/unavailable judgment STILL carries the judge's own provider/model — provenance is known before the call, not derived from its outcome", async () => {
    const judge = fakeProvenancedJudge("anthropic", "claude-sonnet-5", async () => {
      throw new Error("simulated outage");
    });
    const result = await safeJudge(judge, { delegatedGoal: "g", transaction: { amountMinorUnits: 1, currency: "USD", category: "c", rail: "r", purpose: "p" } });
    assert.equal(result.verdict, "unavailable");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude-sonnet-5");
  });

  test("a timed-out judgment also carries provenance", async () => {
    const judge = fakeProvenancedJudge("gemini", "gemini-3.6-flash", () => new Promise<never>(() => {}));
    const result = await safeJudge(judge, { delegatedGoal: "g", transaction: { amountMinorUnits: 1, currency: "USD", category: "c", rail: "r", purpose: "p" } }, 30);
    assert.equal(result.verdict, "unavailable");
    assert.equal(result.category, "timeout");
    assert.equal(result.provider, "gemini");
  });

  test("a test double with no provider set carries no provider — never a guessed value", async () => {
    const judge: IntentJudge = { async judge() { return { verdict: "consistent", rationale: "ok" }; } };
    const result = await safeJudge(judge, { delegatedGoal: "g", transaction: { amountMinorUnits: 1, currency: "USD", category: "c", rail: "r", purpose: "p" } });
    assert.equal(result.provider, undefined);
  });
});

describe("GET /demo-mode — truthful AI provenance exposed to the dashboard", () => {
  test("demo mode reports provider 'demo', never implying a real provider is active", async () => {
    const { app } = buildHarness({ intentJudge: createDemoIntentJudge(), demoMode: true });
    const res = await request(app).get("/demo-mode");
    assert.equal(res.status, 200);
    assert.equal(res.body.demoMode, true);
    assert.equal(res.body.aiProvider, "demo");
  });

  test("a real Gemini-shaped judge reports provider 'gemini' and its model, without needing a network call", async () => {
    const judge = new GeminiIntentJudge({
      model: "gemini-3.6-flash",
      client: { models: { async generateContent() { return { text: '{"verdict":"consistent","rationale":"ok"}' }; } } },
    });
    const { app } = buildHarness({ intentJudge: judge, demoMode: false });
    const res = await request(app).get("/demo-mode");
    assert.equal(res.body.demoMode, false);
    assert.equal(res.body.aiProvider, "gemini");
    assert.equal(res.body.aiModel, "gemini-3.6-flash");
  });

  test("a real Anthropic-shaped judge reports provider 'anthropic' and its model", async () => {
    const judge = new AnthropicIntentJudge({ apiKey: "sk-ant-not-a-real-key-just-shape-checking", model: "claude-sonnet-5" });
    const { app } = buildHarness({ intentJudge: judge, demoMode: false });
    const res = await request(app).get("/demo-mode");
    assert.equal(res.body.aiProvider, "anthropic");
    assert.equal(res.body.aiModel, "claude-sonnet-5");
  });

  test("a bare test double with no provider set reports 'unknown', never falsely claiming demo/gemini/anthropic", async () => {
    const { app } = buildHarness({ intentJudge: { async judge() { return { verdict: "consistent", rationale: "ok" }; } } });
    const res = await request(app).get("/demo-mode");
    assert.equal(res.body.aiProvider, "unknown");
  });

  test("GET /demo-mode is unauthenticated, matching its existing contract", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/demo-mode");
    assert.equal(res.status, 200);
  });
});

describe("Decision Inspector data — a real transaction's response carries the same truthful provenance", () => {
  test("a /simulate response's risk.intentJudgment includes the configured provider, matching /demo-mode", async () => {
    const judge = new GeminiIntentJudge({
      model: "gemini-3.6-flash",
      client: { models: { async generateContent() { return { text: '{"verdict":"consistent","rationale":"Looks fine."}' }; } } },
    });
    const { app } = buildHarness({ intentJudge: judge });
    const principalRes = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const apiKey: string = principalRes.body.apiKey;
    const agentRes = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", delegatedGoal: "Book flights.", caveats: defaultCaveats() });
    const token: string = agentRes.body.token;

    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${token}`).send({ transaction: defaultTransaction() });
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.risk.intentJudgment.provider, "gemini");
    assert.equal(res.body.decision.risk.intentJudgment.model, "gemini-3.6-flash");
  });
});
