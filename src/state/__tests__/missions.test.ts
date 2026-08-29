import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../db.js";
import { createAgentStore } from "../agents.js";
import { createMissionStore } from "../missions.js";
import type { MissionRecordInput } from "../missions.js";

/** Registers a root agent for "principal-1" and returns {db, agents, missions}, ready for a mission to be attached. */
function setupWithAgent(agentId = "agent-root", principalId = "principal-1") {
  const db = openDatabase(":memory:");
  const agents = createAgentStore(db);
  const missions = createMissionStore(db);
  agents.register({
    agentId,
    principalId,
    parentAgentId: null,
    delegatedGoal: "Purchase API credits from an approved provider",
    caveats: { maxAmountMinorUnits: 500_000 },
    tokenBase64: "root-token",
    revocationId: `rev-${agentId}`,
  });
  return { db, agents, missions };
}

function defaultMissionInput(overrides: Partial<MissionRecordInput> = {}): MissionRecordInput {
  return {
    missionId: "mission-1",
    agentId: "agent-root",
    principalId: "principal-1",
    goal: "Purchase the required API credits from an approved provider, staying under ₹2,000.",
    budgetMinorUnits: 200_000,
    currency: "INR",
    allowedCategories: ["api_credits"],
    approvedCounterparties: ["cloudcredits-vendor"],
    expiresAt: "2027-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("mission store — registration and round-trip", () => {
  test("registers a mission for an existing agent and every field round-trips exactly through get()", () => {
    const { missions } = setupWithAgent();

    const registered = missions.register(defaultMissionInput());
    assert.equal(registered.status, "active", "a freshly registered mission must start active");
    assert.equal(registered.reservedMinorUnits, 0, "a freshly registered mission must start with nothing reserved");
    assert.ok(registered.createdAt.length > 0);

    const fetched = missions.get("mission-1");
    assert.ok(fetched, "the mission must be retrievable by id");
    assert.deepEqual(fetched, registered, "get() must return exactly what register() returned, byte for byte");

    // Explicit field-by-field check, including the two nullable JSON-array fields,
    // so a bug that silently drops or mangles one field during JSON (de)serialization
    // cannot hide behind a passing deepEqual against a value derived the same buggy way.
    assert.equal(fetched!.missionId, "mission-1");
    assert.equal(fetched!.agentId, "agent-root");
    assert.equal(fetched!.principalId, "principal-1");
    assert.equal(fetched!.goal, "Purchase the required API credits from an approved provider, staying under ₹2,000.");
    assert.equal(fetched!.budgetMinorUnits, 200_000);
    assert.equal(fetched!.currency, "INR");
    assert.deepEqual(fetched!.allowedCategories, ["api_credits"]);
    assert.deepEqual(fetched!.approvedCounterparties, ["cloudcredits-vendor"]);
    assert.equal(fetched!.expiresAt, "2027-01-01T00:00:00Z");
  });

  test("null allowedCategories and approvedCounterparties (no narrowing beyond the token) round-trip as null, not an empty array", () => {
    const { missions } = setupWithAgent();

    missions.register(defaultMissionInput({ allowedCategories: null, approvedCounterparties: null }));

    const fetched = missions.get("mission-1");
    assert.equal(fetched!.allowedCategories, null);
    assert.equal(fetched!.approvedCounterparties, null);
  });

  test("get() on a never-registered missionId returns undefined, not a throw", () => {
    const { missions } = setupWithAgent();
    assert.equal(missions.get("no-such-mission"), undefined);
  });
});

describe("mission store — adversarial: referential integrity", () => {
  test("rejects registering a mission for a nonexistent agent", () => {
    const db = openDatabase(":memory:");
    const missions = createMissionStore(db);

    assert.throws(() => missions.register(defaultMissionInput({ agentId: "agent-does-not-exist" })));
    assert.equal(missions.get("mission-1"), undefined, "a rejected registration must not leave a partial row behind");
  });

  test("rejects registering the same missionId twice, even for the same agent", () => {
    const { missions } = setupWithAgent();
    missions.register(defaultMissionInput());

    assert.throws(() => missions.register(defaultMissionInput({ goal: "a different goal entirely" })));

    // The original registration must survive a rejected duplicate attempt untouched.
    assert.equal(missions.get("mission-1")?.goal, defaultMissionInput().goal);
  });

  test("rejects registering a mission whose principalId does not match its agent's real principalId", () => {
    const { missions } = setupWithAgent("agent-root", "principal-1");

    assert.throws(() =>
      missions.register(defaultMissionInput({ agentId: "agent-root", principalId: "principal-attacker" }))
    );
    assert.equal(missions.get("mission-1"), undefined);
  });
});

describe("mission store — adversarial: cross-agent and cross-principal isolation", () => {
  test("listByAgent returns only the missions belonging to that specific agent, never a sibling agent's", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);
    const missions = createMissionStore(db);

    for (const agentId of ["agent-a", "agent-b"]) {
      agents.register({
        agentId,
        principalId: "principal-1",
        parentAgentId: null,
        delegatedGoal: "x",
        caveats: {},
        tokenBase64: "t",
        revocationId: `rev-${agentId}`,
      });
    }

    missions.register(defaultMissionInput({ missionId: "mission-a1", agentId: "agent-a" }));
    missions.register(defaultMissionInput({ missionId: "mission-a2", agentId: "agent-a" }));
    missions.register(defaultMissionInput({ missionId: "mission-b1", agentId: "agent-b" }));

    assert.deepEqual(
      missions.listByAgent("agent-a").map((m) => m.missionId).sort(),
      ["mission-a1", "mission-a2"],
      "agent-b's mission must never leak into agent-a's list"
    );
    assert.deepEqual(
      missions.listByAgent("agent-b").map((m) => m.missionId),
      ["mission-b1"]
    );
    assert.deepEqual(missions.listByAgent("agent-nonexistent"), [], "an unknown agent must yield an empty list, not a throw");
  });

  test("listByPrincipal returns only the missions belonging to that principal's own agents, across every one of them, never another principal's", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);
    const missions = createMissionStore(db);

    agents.register({
      agentId: "p1-agent-a",
      principalId: "principal-1",
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: "rev-p1-a",
    });
    agents.register({
      agentId: "p1-agent-b",
      principalId: "principal-1",
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: "rev-p1-b",
    });
    agents.register({
      agentId: "p2-agent-a",
      principalId: "principal-2",
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: "rev-p2-a",
    });

    missions.register(defaultMissionInput({ missionId: "m-p1-a", agentId: "p1-agent-a", principalId: "principal-1" }));
    missions.register(defaultMissionInput({ missionId: "m-p1-b", agentId: "p1-agent-b", principalId: "principal-1" }));
    missions.register(defaultMissionInput({ missionId: "m-p2-a", agentId: "p2-agent-a", principalId: "principal-2" }));

    assert.deepEqual(
      missions.listByPrincipal("principal-1").map((m) => m.missionId).sort(),
      ["m-p1-a", "m-p1-b"],
      "principal-2's mission must never leak into principal-1's cross-agent list"
    );
    assert.deepEqual(
      missions.listByPrincipal("principal-2").map((m) => m.missionId),
      ["m-p2-a"]
    );
    assert.deepEqual(missions.listByPrincipal("principal-nonexistent"), []);
  });
});

describe("mission store — adversarial: close / status transition", () => {
  test("close() transitions status and the change is visible on the next get(), leaving every other field untouched", () => {
    const { missions } = setupWithAgent();
    const original = missions.register(defaultMissionInput());
    assert.equal(original.status, "active");

    const closed = missions.close("mission-1", "completed");
    assert.equal(closed.status, "completed");

    const fetched = missions.get("mission-1");
    assert.equal(fetched!.status, "completed");
    // Every non-status field must be byte-for-byte unchanged by a status transition.
    assert.deepEqual({ ...fetched!, status: original.status }, original);
  });

  test("close() supports every terminal status independently (completed, cancelled, expired)", () => {
    const { missions } = setupWithAgent();
    for (const status of ["completed", "cancelled", "expired"] as const) {
      const missionId = `mission-${status}`;
      missions.register(defaultMissionInput({ missionId }));
      const closed = missions.close(missionId, status);
      assert.equal(closed.status, status);
      assert.equal(missions.get(missionId)!.status, status);
    }
  });

  test("close() on a never-registered missionId throws rather than silently succeeding", () => {
    const { missions } = setupWithAgent();
    assert.throws(() => missions.close("no-such-mission", "cancelled"));
  });
});
