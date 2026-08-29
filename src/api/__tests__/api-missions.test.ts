import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";

import { buildHarness, defaultCaveats, defaultTransaction } from "./harness.js";

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

function missionBody(overrides: Record<string, unknown> = {}) {
  return {
    missionId: "mission-1",
    agentId: "agent-root",
    goal: "Purchase the required flights from an approved provider, staying under $2,000.",
    budgetMinorUnits: 200_000,
    currency: "USD",
    allowedCategories: ["flights"],
    approvedCounterparties: ["acme-airlines"],
    expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("POST /missions — creation, ownership, and token-narrowing validation", () => {
  test("a principal creates a mission for its own agent and gets back enriched fields (spent=0, remaining=budget)", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    await registerAgent(app, apiKey, "agent-root");

    const res = await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());

    assert.equal(res.status, 201);
    assert.equal(res.body.missionId, "mission-1");
    assert.equal(res.body.status, "active");
    assert.equal(res.body.budgetMinorUnits, 200_000);
    assert.equal(res.body.spentMinorUnits, 0);
    assert.equal(res.body.reservedMinorUnits, 0);
    assert.equal(res.body.remainingMinorUnits, 200_000);
  });

  test("rejects creating a mission for an agent the principal does not own (403 — reuses the exact same requireOwnedAgent check every other agent-scoped route already uses)", async () => {
    const { app } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    const apiKeyB = await registerPrincipal(app, "principal-b");
    await registerAgent(app, apiKeyB, "agent-b");

    const res = await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyA}`).send(missionBody({ agentId: "agent-b" }));
    assert.equal(res.status, 403);
  });

  test("rejects creating a mission for an agent that does not exist at all (404)", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const res = await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody({ agentId: "no-such-agent" }));
    assert.equal(res.status, 404);
  });

  test("ADVERSARIAL: rejects a mission wider than the agent's own capability token (a category the token never granted)", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    await registerAgent(app, apiKey, "agent-root", defaultCaveats({ categories: ["flights"] }));

    const res = await request(app)
      .post("/missions")
      .set("Authorization", `Bearer ${apiKey}`)
      .send(missionBody({ allowedCategories: ["flights", "gift_cards"] }));

    assert.equal(res.status, 400);
    assert.match(res.body.error, /not in the agent token's allowed categories/);
  });

  test("rejects a mission whose expiresAt is later than the agent's token expiry", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const farFuture = new Date(Date.now() + 1000 * 24 * 60 * 60 * 1000).toISOString(); // token defaults to 365 days
    await registerAgent(app, apiKey, "agent-root");

    const res = await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody({ expiresAt: farFuture }));
    assert.equal(res.status, 400);
  });

  test("rejects registering a duplicate missionId", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());

    const res = await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());
    assert.equal(res.status, 409);
  });

  test("requires principal authentication (no Authorization header -> 401)", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/missions").send(missionBody());
    assert.equal(res.status, 401);
  });
});

describe("GET /missions, GET /agents/:agentId/missions — listing and cross-principal isolation", () => {
  test("GET /missions returns only the authenticated principal's own missions, across all of their agents", async () => {
    const { app } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    await registerAgent(app, apiKeyA, "agent-a1");
    await registerAgent(app, apiKeyA, "agent-a2");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyA}`).send(missionBody({ missionId: "m-a1", agentId: "agent-a1" }));
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyA}`).send(missionBody({ missionId: "m-a2", agentId: "agent-a2" }));

    const apiKeyB = await registerPrincipal(app, "principal-b");
    await registerAgent(app, apiKeyB, "agent-b");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyB}`).send(missionBody({ missionId: "m-b", agentId: "agent-b" }));

    const res = await request(app).get("/missions").set("Authorization", `Bearer ${apiKeyA}`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.missions.map((m: { missionId: string }) => m.missionId).sort(),
      ["m-a1", "m-a2"],
      "principal-b's mission must never leak into principal-a's list"
    );
  });

  test("GET /agents/:agentId/missions requires owning that specific agent", async () => {
    const { app } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    const apiKeyB = await registerPrincipal(app, "principal-b");
    await registerAgent(app, apiKeyB, "agent-b");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyB}`).send(missionBody({ missionId: "m-b", agentId: "agent-b" }));

    const res = await request(app).get("/agents/agent-b/missions").set("Authorization", `Bearer ${apiKeyA}`);
    assert.equal(res.status, 403, "agent-b exists but belongs to principal-b — the existing agent-ownership 403 convention applies here");
  });
});

describe("GET /missions/:id — strict 404-both-ways, never leaking existence by guessing IDs", () => {
  test("a mission belonging to a DIFFERENT principal returns 404 — never 403 — with the same response shape as a genuinely nonexistent id, so its existence is never confirmed to a guesser", async () => {
    const { app } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    await registerAgent(app, apiKeyA, "agent-a");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyA}`).send(missionBody({ missionId: "secret-mission", agentId: "agent-a" }));

    const apiKeyB = await registerPrincipal(app, "principal-b");
    const resAsB = await request(app).get("/missions/secret-mission").set("Authorization", `Bearer ${apiKeyB}`);
    const resNonexistent = await request(app).get("/missions/totally-made-up-id").set("Authorization", `Bearer ${apiKeyB}`);

    assert.equal(resAsB.status, 404);
    assert.equal(resNonexistent.status, 404);
    // The error text necessarily echoes back whatever id the caller themselves typed
    // into the URL (no new information beyond that), so comparing literal message text
    // across two DIFFERENT ids would be comparing the wrong thing. What must actually
    // be identical — the real "can a guesser distinguish these" property — is the
    // response's status and shape: same keys, same field types, no extra field (e.g. a
    // hint that the id exists) leaking through on the not-mine case.
    assert.deepEqual(Object.keys(resAsB.body).sort(), Object.keys(resNonexistent.body).sort());
    assert.deepEqual(Object.keys(resAsB.body), ["error"]);
    assert.equal(typeof resAsB.body.error, typeof resNonexistent.body.error);
  });

  test("the owning principal can fetch their own mission and sees live spent/remaining figures", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody({ budgetMinorUnits: 100_000 }));

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "key-1")
      .send({ transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" });

    const res = await request(app).get("/missions/mission-1").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.spentMinorUnits, 38_000);
    assert.equal(res.body.reservedMinorUnits, 0);
    assert.equal(res.body.remainingMinorUnits, 62_000);
  });
});

describe("POST /missions/:id/cancel", () => {
  test("cancels an active mission; a subsequent transaction attempt under it is denied", async () => {
    const { app, stripeRail } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());

    const cancelRes = await request(app).post("/missions/mission-1/cancel").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.status, "cancelled");

    const txRes = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "key-1")
      .send({ transaction: defaultTransaction({ category: "flights" }), counterparty: "acme-airlines", missionId: "mission-1" });
    assert.equal(txRes.body.decision.verdict, "deny");
    assert.equal(stripeRail.calls.length, 0);
  });

  test("cancelling an already-cancelled mission returns 409, not a silent success", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());
    await request(app).post("/missions/mission-1/cancel").set("Authorization", `Bearer ${apiKey}`);

    const res = await request(app).post("/missions/mission-1/cancel").set("Authorization", `Bearer ${apiKey}`);
    assert.equal(res.status, 409);
  });

  test("cancelling a mission belonging to a different principal returns 404, never 403", async () => {
    const { app } = buildHarness();
    const apiKeyA = await registerPrincipal(app, "principal-a");
    await registerAgent(app, apiKeyA, "agent-a");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKeyA}`).send(missionBody({ agentId: "agent-a" }));

    const apiKeyB = await registerPrincipal(app, "principal-b");
    const res = await request(app).post("/missions/mission-1/cancel").set("Authorization", `Bearer ${apiKeyB}`);
    assert.equal(res.status, 404);
  });
});

describe("POST /simulate — optional missionId, dry-run only", () => {
  test("backwards compatible: a /simulate request with no missionId behaves exactly as before", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root");

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction({ category: "flights" }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
  });

  test("a mission-gated denial via /simulate never reserves anything and never calls the rail", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction({ category: "flights" }), counterparty: "shady-marketplace", missionId: "mission-1" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "deny");
    assert.equal(res.body.decision.source, "mission");
    assert.equal(stripeRail.calls.length, 0);

    const mission = deps.missions.get("mission-1")!;
    assert.equal(mission.reservedMinorUnits, 0, "a dry-run simulate must never create a reservation");
  });

  test("a passing mission gate via /simulate still never executes (no rail call), consistent with /simulate's existing dry-run guarantee", async () => {
    const { app, deps, stripeRail } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction({ category: "flights", amountMinorUnits: 38_000 }), counterparty: "acme-airlines", missionId: "mission-1" });

    assert.equal(res.status, 200);
    assert.equal(res.body.decision.verdict, "allow");
    assert.equal(stripeRail.calls.length, 0);
    assert.equal(deps.missions.get("mission-1")!.reservedMinorUnits, 0);
  });

  test("missionId present without counterparty is rejected with 400", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    const token = await registerAgent(app, apiKey, "agent-root");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody());

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${token}`)
      .send({ transaction: defaultTransaction({ category: "flights" }), missionId: "mission-1" });
    assert.equal(res.status, 400);
  });

  test("a mission not owned by the simulating agent is rejected with 403", async () => {
    const { app } = buildHarness();
    const apiKey = await registerPrincipal(app, "acme-corp");
    await registerAgent(app, apiKey, "agent-owner");
    const otherToken = await registerAgent(app, apiKey, "agent-other");
    await request(app).post("/missions").set("Authorization", `Bearer ${apiKey}`).send(missionBody({ agentId: "agent-owner" }));

    const res = await request(app)
      .post("/simulate")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ transaction: defaultTransaction({ category: "flights" }), counterparty: "acme-airlines", missionId: "mission-1" });
    assert.equal(res.status, 403);
  });
});
