import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";

import { createRailRegistry } from "../../rails/types.js";
import { createApp } from "../server.js";
import { LEDGER_KIND_MISSION_PIPELINE_OUTCOME, LEDGER_KIND_MISSION_TRANSACTION_LINK, LEDGER_KIND_MISSION_POLICY_VERDICT } from "../../mission/index.js";
import type { MissionRecordInput } from "../../state/missions.js";
import { buildHarness, defaultCaveats, defaultTransaction, RecordingRailAdapter, ScriptedIntentJudge } from "./harness.js";

/**
 * Step 8: adversarial tests for the mission-history-visibility fix — proving that
 * EVERY mission-scoped transaction attempt (not only successful settlements) becomes
 * visible via a new, self-contained LEDGER_KIND_MISSION_PIPELINE_OUTCOME ledger entry,
 * written by routes/transactions.ts, without changing computeMissionSpent, the
 * reservation primitive, or checkMissionGate at all — see src/mission/ledger.ts's doc
 * comment on LEDGER_KIND_MISSION_PIPELINE_OUTCOME for the full design reasoning.
 */

function missionInput(overrides: Partial<MissionRecordInput> = {}): MissionRecordInput {
  return {
    missionId: "mission-1",
    agentId: "agent-root",
    principalId: "acme-corp",
    goal: "Purchase the required flights from an approved provider, staying under $2,000.",
    budgetMinorUnits: 200_000,
    currency: "USD",
    allowedCategories: ["flights"],
    approvedCounterparties: ["acme-airlines"],
    expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

async function registerPrincipal(app: Express, principalId: string): Promise<string> {
  const res = await request(app).post("/principals").send({ principalId });
  return res.body.apiKey as string;
}

async function registerAgent(app: Express, apiKey: string, agentId: string, caveats = defaultCaveats()): Promise<string> {
  const res = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId, delegatedGoal: "Book conference travel", caveats });
  return res.body.token as string;
}

async function createPrincipalAndAgent(
  app: Express,
  { principalId = "acme-corp", agentId = "agent-root", caveats = defaultCaveats() } = {}
): Promise<{ apiKey: string; token: string }> {
  const apiKey = await registerPrincipal(app, principalId);
  const token = await registerAgent(app, apiKey, agentId, caveats);
  return { apiKey, token };
}

function postTransaction(app: Express, token: string, idempotencyKey: string, body: Record<string, unknown>) {
  return request(app).post("/transactions").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idempotencyKey).send(body);
}

/** Fetches the mission-tagged pipeline-outcome ledger entries for a given agent+mission, sorted oldest-first. */
function pipelineOutcomeEntries(entries: Array<{ kind: string; data: Record<string, unknown> }>, missionId: string) {
  return entries.filter((e) => e.kind === LEDGER_KIND_MISSION_PIPELINE_OUTCOME && e.data.missionId === missionId);
}

describe("mission history — a capability/policy-denied mission-scoped attempt appears in mission history", () => {
  test("a transaction that PASSES the mission gate but is denied by the token's own capability ceiling gets a mission_pipeline_outcome entry, distinct from mission_policy_verdict", async () => {
    const { app, deps } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, { caveats: defaultCaveats({ maxAmountMinorUnits: 40_000 }) });
    deps.missions.register(missionInput({ budgetMinorUnits: 100_000 }));

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 50_000 }), // exceeds the 40,000 token ceiling, fits the 100,000 mission budget
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(res.body.decision.source, undefined, "this is a CAPABILITY/POLICY denial, not a mission-gate denial");

    const entries = deps.ledger.listByAgent("agent-root");
    const outcomes = pipelineOutcomeEntries(entries, "mission-1");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.data.verdict, "deny");
    assert.equal(outcomes[0]!.data.amountMinorUnits, 50_000);
    assert.equal(outcomes[0]!.data.category, "flights");
    assert.equal(outcomes[0]!.data.counterparty, "acme-airlines");
    assert.equal((outcomes[0]!.data.policy as { allowed: boolean }).allowed, false);

    // Confirms the two kinds stay distinct — no mission_policy_verdict was written for this (it's a real-pipeline denial, not a mission-gate one).
    const gateEntries = entries.filter((e) => e.kind === LEDGER_KIND_MISSION_POLICY_VERDICT && e.data.missionId === "mission-1");
    assert.equal(gateEntries.length, 0);
  });
});

describe("mission history — an escalated mission-scoped attempt appears in mission history", () => {
  test("a transaction the intent judge flags as inconsistent gets a mission_pipeline_outcome entry with verdict escalate", async () => {
    const inconsistentJudge = new ScriptedIntentJudge(() => ({ verdict: "inconsistent", rationale: "does not serve the delegated goal" }));
    const { app, deps } = buildHarness({ intentJudge: inconsistentJudge });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(res.body.decision.verdict, "escalate");

    const outcomes = pipelineOutcomeEntries(deps.ledger.listByAgent("agent-root"), "mission-1");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.data.verdict, "escalate");
    assert.ok((outcomes[0]!.data.risk as { intentJudgment: { verdict: string } }).intentJudgment.verdict === "inconsistent");
  });
});

describe("mission history — successful settlement still appears exactly once", () => {
  test("an allowed, executed transaction produces exactly one mission_transaction_link AND exactly one mission_pipeline_outcome — never duplicated, never conflated", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());

    await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(stripeRail.calls.length, 1);

    const entries = deps.ledger.listByAgent("agent-root");
    const links = entries.filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK && e.data.missionId === "mission-1");
    const outcomes = pipelineOutcomeEntries(entries, "mission-1");

    assert.equal(links.length, 1, "exactly one settlement link");
    assert.equal(outcomes.length, 1, "exactly one pipeline-outcome entry");
    assert.equal(outcomes[0]!.data.verdict, "allow");
    assert.equal((outcomes[0]!.data.execution as { success: boolean }).success, true);
  });
});

describe("mission history — execution failure appears correctly", () => {
  test("an allowed transaction whose rail execution fails gets a mission_pipeline_outcome with execution.success=false, and NO mission_transaction_link", async () => {
    const failingRail = new RecordingRailAdapter("stripe_test", (req) => ({
      success: false,
      rail: "stripe_test",
      reference: "",
      settledAt: new Date().toISOString(),
      error: "simulated rail failure",
      raw: { idempotencyKey: req.idempotencyKey },
    }));
    const { app, deps } = buildHarness({ rails: createRailRegistry([failingRail]) });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());

    const res = await postTransaction(app, token, "key-1", {
      transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }),
      counterparty: "acme-airlines",
      missionId: "mission-1",
    });
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(res.body.execution.success, false);

    const entries = deps.ledger.listByAgent("agent-root");
    const links = entries.filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK && e.data.missionId === "mission-1");
    const outcomes = pipelineOutcomeEntries(entries, "mission-1");

    assert.equal(links.length, 0, "a failed execution must never produce a settlement link");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.data.verdict, "allow");
    assert.equal((outcomes[0]!.data.execution as { success: boolean }).success, false);
  });
});

describe("mission history — budget semantics are unaffected (Step 4/5 invariants preserved)", () => {
  test("a capability/policy-denied mission-scoped attempt does not count toward spent, and its reservation is released", async () => {
    const { app, deps } = buildHarness();
    const { token } = await createPrincipalAndAgent(app, { caveats: defaultCaveats({ maxAmountMinorUnits: 40_000 }) });
    deps.missions.register(missionInput({ budgetMinorUnits: 100_000 }));

    await postTransaction(app, token, "key-1", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 50_000 }), counterparty: "acme-airlines", missionId: "mission-1" });

    const entries = deps.ledger.listByAgent("agent-root");
    assert.equal(entries.filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK).length, 0, "a denied attempt must never produce a settlement link");
    assert.equal(deps.missions.get("mission-1")!.reservedMinorUnits, 0, "the reservation must have been released, not left stuck");
  });

  test("an escalated mission-scoped attempt does not count toward spent, and its reservation is released", async () => {
    const inconsistentJudge = new ScriptedIntentJudge(() => ({ verdict: "inconsistent", rationale: "flag" }));
    const { app, deps } = buildHarness({ intentJudge: inconsistentJudge });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ budgetMinorUnits: 100_000 }));

    await postTransaction(app, token, "key-1", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" });

    const entries = deps.ledger.listByAgent("agent-root");
    assert.equal(entries.filter((e) => e.kind === LEDGER_KIND_MISSION_TRANSACTION_LINK).length, 0);
    assert.equal(deps.missions.get("mission-1")!.reservedMinorUnits, 0);
  });

  test("a failed-execution mission-scoped attempt does not count toward spent, and its reservation is released, so the full budget is available to a subsequent attempt", async () => {
    const failingRail = new RecordingRailAdapter("stripe_test", () => ({ success: false, rail: "stripe_test", reference: "", settledAt: new Date().toISOString(), error: "fail" }));
    const { app, deps } = buildHarness({ rails: createRailRegistry([failingRail]) });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ budgetMinorUnits: 100_000 }));

    await postTransaction(app, token, "key-1", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" });
    assert.equal(deps.missions.get("mission-1")!.reservedMinorUnits, 0);

    // A follow-up attempt (fresh key, working rail, same underlying deps/stores) proves
    // the full original budget is still available — nothing was consumed by the failed
    // attempt. Mirrors the same app-rebuild-with-swapped-rail pattern already used in
    // api-mission-integration.test.ts.
    const workingRail = new RecordingRailAdapter("stripe_test");
    const appWithWorkingRail = createApp({ ...deps, rails: createRailRegistry([workingRail]) });

    const retry = await postTransaction(appWithWorkingRail, token, "key-2", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 100_000 }), counterparty: "acme-airlines", missionId: "mission-1" });
    assert.equal(retry.body.decision.verdict, "allow");
    assert.equal(retry.body.execution.success, true);
    assert.equal(workingRail.calls.length, 1);
  });

  test("GET /missions/:id remainingMinorUnits is correctly restored to full after a denied mission-scoped attempt", async () => {
    const { app, deps } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root", defaultCaveats({ maxAmountMinorUnits: 40_000 }));
    deps.missions.register(missionInput({ budgetMinorUnits: 100_000 }));

    await postTransaction(app, token, "key-1", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 50_000 }), counterparty: "acme-airlines", missionId: "mission-1" });

    const res = await request(app).get("/missions/mission-1").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.body.spentMinorUnits, 0, "a denied attempt must never count as spent");
    assert.equal(res.body.reservedMinorUnits, 0, "the reservation must have been released");
    assert.equal(res.body.remainingMinorUnits, 100_000, "the full budget must be available again");
  });
});

describe("mission history — isolation", () => {
  test("unrelated transactions (no mission, or a DIFFERENT mission) never appear in this mission's history entries", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput({ missionId: "mission-1", budgetMinorUnits: 100_000 }));
    deps.missions.register(missionInput({ missionId: "mission-2", budgetMinorUnits: 100_000, allowedCategories: ["software"], approvedCounterparties: ["cloudco"] }));

    // No mission at all.
    await postTransaction(app, token, "key-no-mission", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines" });
    // A DIFFERENT mission.
    await postTransaction(app, token, "key-mission-2", { transaction: defaultTransaction({ category: "software", amountMinorUnits: 38_000, rail: "stripe_test" }), counterparty: "cloudco", missionId: "mission-2" });

    assert.equal(stripeRail.calls.length, 2);

    const entries = deps.ledger.listByAgent("agent-root");
    const mission1Outcomes = pipelineOutcomeEntries(entries, "mission-1");
    assert.equal(mission1Outcomes.length, 0, "neither the no-mission nor the mission-2 transaction may appear in mission-1's history");

    const mission2Outcomes = pipelineOutcomeEntries(entries, "mission-2");
    assert.equal(mission2Outcomes.length, 1, "the mission-2 transaction must appear in mission-2's own history");
  });

  test("cross-principal isolation: a different principal's agent/mission activity never appears in this mission's history, and GET /missions/:id from the wrong principal is rejected before any history could leak", async () => {
    const { app, deps } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    const tokenA = await registerAgent(app, apiKeyA, "agent-a");
    deps.missions.register(missionInput({ missionId: "mission-a", agentId: "agent-a", principalId: "principal-a" }));

    const apiKeyB = await registerPrincipal(app, "principal-b");
    await registerAgent(app, apiKeyB, "agent-b");
    deps.missions.register(missionInput({ missionId: "mission-b", agentId: "agent-b", principalId: "principal-b" }));

    await postTransaction(app, tokenA, "key-1", { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-a" });

    // principal-b must not be able to fetch principal-a's mission at all.
    const crossRes = await request(app).get("/missions/mission-a").set("Authorization", `Bearer ${apiKeyB}`);
    assert.equal(crossRes.status, 404);

    // And mission-b's own history (queried correctly, by its own owner) must show nothing from principal-a's activity.
    const entries = deps.ledger.listByAgent("agent-b");
    assert.equal(pipelineOutcomeEntries(entries, "mission-b").length, 0);
    assert.equal(pipelineOutcomeEntries(entries, "mission-a").length, 0, "agent-b's own ledger must not contain agent-a's mission-a entries at all — different agentId scoping");
  });
});

describe("mission history — idempotent replay does not duplicate history entries", () => {
  test("5 concurrent identical requests (same Idempotency-Key) produce exactly ONE mission_pipeline_outcome entry, not five", async () => {
    const { app, deps, stripeRail } = buildHarness({ idempotencyPollIntervalMs: 5, idempotencyWaitTimeoutMs: 5000 });
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());
    const body = { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" };

    await Promise.all(Array.from({ length: 5 }, () => postTransaction(app, token, "shared-key", body)));

    assert.equal(stripeRail.calls.length, 1);
    const outcomes = pipelineOutcomeEntries(deps.ledger.listByAgent("agent-root"), "mission-1");
    assert.equal(outcomes.length, 1, "exactly one pipeline-outcome entry across all 5 concurrent identical requests");
  });

  test("a SEQUENTIAL replay (same Idempotency-Key, after the first attempt already completed) does not append a second history entry", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const { token } = await createPrincipalAndAgent(app);
    deps.missions.register(missionInput());
    const body = { transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" };

    const first = await postTransaction(app, token, "replay-key", body);
    const second = await postTransaction(app, token, "replay-key", body);

    assert.deepEqual(first.body, second.body, "a replay must return the exact cached response");
    assert.equal(stripeRail.calls.length, 1);
    const outcomes = pipelineOutcomeEntries(deps.ledger.listByAgent("agent-root"), "mission-1");
    assert.equal(outcomes.length, 1);
  });
});
