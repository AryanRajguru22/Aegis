import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { issueRootToken } from "../../capability/index.js";
import { buildHarness, defaultCaveats } from "./harness.js";

async function createPrincipal(app: import("express").Express, principalId: string) {
  const res = await request(app).post("/principals").send({ principalId });
  assert.equal(res.status, 201);
  return res.body.apiKey as string;
}

async function createRootAgent(
  app: import("express").Express,
  apiKey: string,
  agentId: string,
  caveats: Record<string, unknown> = defaultCaveats()
) {
  const res = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId, delegatedGoal: "Book conference travel", caveats });
  return res;
}

describe("POST /principals", () => {
  test("creates a principal and returns an API key", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/principals").send({ principalId: "acme-corp" });
    assert.equal(res.status, 201);
    assert.equal(res.body.principalId, "acme-corp");
    assert.equal(typeof res.body.apiKey, "string");
  });

  test("rejects a duplicate principalId", async () => {
    const { app } = buildHarness();
    await request(app).post("/principals").send({ principalId: "acme-corp" });
    const res = await request(app).post("/principals").send({ principalId: "acme-corp" });
    assert.equal(res.status, 409);
  });

  test("rejects an invalid principalId", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/principals").send({ principalId: 'acme"); drop table--' });
    assert.equal(res.status, 400);
  });

  test("rejects a missing principalId field", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/principals").send({});
    assert.equal(res.status, 400);
  });

  test("rejects malformed JSON in the request body", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/principals").set("Content-Type", "application/json").send("{not valid json");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /JSON/i);
  });
});

describe("principal-authenticated endpoints — authorization", () => {
  test("POST /agents with no Authorization header is rejected", async () => {
    const { app } = buildHarness();
    const res = await request(app).post("/agents").send({ agentId: "a", delegatedGoal: "g", caveats: defaultCaveats() });
    assert.equal(res.status, 401);
  });

  test("POST /agents with a garbage API key is rejected", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post("/agents")
      .set("Authorization", "Bearer not-a-real-key")
      .send({ agentId: "a", delegatedGoal: "g", caveats: defaultCaveats() });
    assert.equal(res.status, 401);
  });

  test("POST /agents with a malformed Authorization header (no Bearer prefix) is rejected", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post("/agents")
      .set("Authorization", "some-key-without-bearer-prefix")
      .send({ agentId: "a", delegatedGoal: "g", caveats: defaultCaveats() });
    assert.equal(res.status, 401);
  });

  test("a valid principal API key authorizes agent creation", async () => {
    const { app } = buildHarness();
    const apiKey = await createPrincipal(app, "acme-corp");
    const res = await createRootAgent(app, apiKey, "agent-root");
    assert.equal(res.status, 201);
    assert.equal(res.body.agentId, "agent-root");
    assert.equal(res.body.principalId, "acme-corp");
    assert.equal(typeof res.body.token, "string");
  });
});

describe("POST /agents — validation", () => {
  test("rejects caveats missing required fields", async () => {
    const { app } = buildHarness();
    const apiKey = await createPrincipal(app, "acme-corp");
    const res = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", delegatedGoal: "g", caveats: { currency: "USD" } });
    assert.equal(res.status, 400);
  });

  test("rejects a non-positive maxAmountMinorUnits", async () => {
    const { app } = buildHarness();
    const apiKey = await createPrincipal(app, "acme-corp");
    const res = await createRootAgent(app, apiKey, "agent-root", defaultCaveats({ maxAmountMinorUnits: -5 }));
    assert.equal(res.status, 400);
  });

  test("rejects an agentId that would break out of the token's Datalog", async () => {
    const { app } = buildHarness();
    const apiKey = await createPrincipal(app, "acme-corp");
    const res = await createRootAgent(app, apiKey, 'agent"); allow if true; //');
    assert.equal(res.status, 400);
  });

  test("rejects a duplicate agentId", async () => {
    const { app } = buildHarness();
    const apiKey = await createPrincipal(app, "acme-corp");
    await createRootAgent(app, apiKey, "agent-root");
    const res = await createRootAgent(app, apiKey, "agent-root");
    assert.equal(res.status, 409);
  });

  test("a caller cannot claim a different principalId than their authenticated one — there is no field for it", async () => {
    // parseCreateAgentBody doesn't even accept a principalId field; this documents
    // that a spoofed value in the body is simply ignored, and the created agent's
    // principalId is always the authenticated caller's.
    const { app } = buildHarness();
    const apiKey = await createPrincipal(app, "acme-corp");
    const res = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ agentId: "agent-root", principalId: "someone-else", delegatedGoal: "g", caveats: defaultCaveats() });
    assert.equal(res.status, 201);
    assert.equal(res.body.principalId, "acme-corp");
  });
});

describe("agent ownership isolation", () => {
  test("principal B cannot read principal A's agent", async () => {
    const { app } = buildHarness();
    const keyA = await createPrincipal(app, "principal-a");
    const keyB = await createPrincipal(app, "principal-b");
    await createRootAgent(app, keyA, "agent-a");

    const res = await request(app).get("/agents/agent-a").set("Authorization", `Bearer ${keyB}`);
    assert.equal(res.status, 403);
  });

  test("GET /agents only lists the caller's own agents", async () => {
    const { app } = buildHarness();
    const keyA = await createPrincipal(app, "principal-a");
    const keyB = await createPrincipal(app, "principal-b");
    await createRootAgent(app, keyA, "agent-a");
    await createRootAgent(app, keyB, "agent-b");

    const resA = await request(app).get("/agents").set("Authorization", `Bearer ${keyA}`);
    assert.deepEqual(resA.body.agents.map((a: { agentId: string }) => a.agentId), ["agent-a"]);
  });

  test("GET /agents/:id for a nonexistent agent is 404", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    const res = await request(app).get("/agents/does-not-exist").set("Authorization", `Bearer ${key}`);
    assert.equal(res.status, 404);
  });

  test("the agent creation response never needs a second read to expose the token, and subsequent list/get calls do not re-expose it", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    const created = await createRootAgent(app, key, "agent-a");
    assert.equal(typeof created.body.token, "string");

    const fetched = await request(app).get("/agents/agent-a").set("Authorization", `Bearer ${key}`);
    assert.equal(fetched.body.token, undefined);
  });
});

describe("POST /agents/:parentId/attenuate", () => {
  test("attenuates a sub-agent from an owned parent", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    const rootCaveats = defaultCaveats();
    await createRootAgent(app, key, "agent-root", rootCaveats);

    const res = await request(app)
      .post("/agents/agent-root/attenuate")
      .set("Authorization", `Bearer ${key}`)
      .send({ agentId: "agent-flights", delegatedGoal: "Book flights only", caveats: { ...rootCaveats, categories: ["flights"] } });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.parentAgentId, "agent-root");
    assert.equal(res.body.rootAgentId, "agent-root");
  });

  test("rejects attenuating a parent owned by a different principal", async () => {
    const { app } = buildHarness();
    const keyA = await createPrincipal(app, "principal-a");
    const keyB = await createPrincipal(app, "principal-b");
    await createRootAgent(app, keyA, "agent-root");

    const res = await request(app)
      .post("/agents/agent-root/attenuate")
      .set("Authorization", `Bearer ${keyB}`)
      .send({ agentId: "agent-sub", delegatedGoal: "g", caveats: defaultCaveats() });
    assert.equal(res.status, 403);
  });

  test("rejects attenuating a nonexistent parent", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    const res = await request(app)
      .post("/agents/does-not-exist/attenuate")
      .set("Authorization", `Bearer ${key}`)
      .send({ agentId: "agent-sub", delegatedGoal: "g", caveats: defaultCaveats() });
    assert.equal(res.status, 404);
  });

  test("rejects a sub-agent caveat set wider than its parent's — the API surfaces the capability module's own attenuation guard as a 400", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    await createRootAgent(app, key, "agent-root", defaultCaveats({ maxAmountMinorUnits: 50_000 }));

    const res = await request(app)
      .post("/agents/agent-root/attenuate")
      .set("Authorization", `Bearer ${key}`)
      .send({ agentId: "agent-sub", delegatedGoal: "g", caveats: defaultCaveats({ maxAmountMinorUnits: 999_999 }) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /exceeds parent/);
  });
});

describe("GET /agents/:id/graph", () => {
  test("returns the full delegation tree for an owned root agent", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    const rootCaveats = defaultCaveats();
    await createRootAgent(app, key, "agent-root", rootCaveats);
    await request(app)
      .post("/agents/agent-root/attenuate")
      .set("Authorization", `Bearer ${key}`)
      .send({ agentId: "agent-flights", delegatedGoal: "g", caveats: { ...rootCaveats, categories: ["flights"] } });

    const res = await request(app).get("/agents/agent-root/graph").set("Authorization", `Bearer ${key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.rootAgentId, "agent-root");
    assert.deepEqual(
      res.body.agents.map((a: { agentId: string }) => a.agentId).sort(),
      ["agent-flights", "agent-root"]
    );
  });
});

describe("agent-token authentication (/simulate, /transactions rely on this)", () => {
  test("a cryptographically valid token signed by an entirely different root key is rejected", async () => {
    const { app, deps } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    await createRootAgent(app, key, "agent-root");

    const { privateKey: otherRoot } = (await import("../../capability/index.js")).generateRootKeyPair();
    void deps;
    const foreignToken = issueRootToken(
      { principalId: "principal-a", agentId: "agent-root", delegatedGoal: "g", caveats: defaultCaveats() },
      otherRoot
    );

    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${foreignToken}`).send({ transaction: {} });
    assert.equal(res.status, 401);
  });

  test("a valid token that was never registered through this server's AgentStore is rejected", async () => {
    // Exercises a token that IS correctly signed by this server's actual root key
    // (so signature verification alone would pass) but was never issued through
    // POST /agents, so no AgentRecord/revocation-id mapping exists for it.
    const { app, deps } = buildHarness();
    const unregisteredToken = issueRootToken(
      { principalId: "principal-a", agentId: "agent-ghost", delegatedGoal: "g", caveats: defaultCaveats() },
      deps.rootPrivateKey
    );

    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${unregisteredToken}`).send({ transaction: {} });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /not correspond to any registered agent/);
  });

  test("a tampered token is rejected", async () => {
    const { app } = buildHarness();
    const key = await createPrincipal(app, "principal-a");
    const created = await createRootAgent(app, key, "agent-root");
    const token: string = created.body.token;
    const chars = token.split("");
    chars[Math.floor(chars.length / 2)] = chars[Math.floor(chars.length / 2)] === "A" ? "B" : "A";

    const res = await request(app).post("/simulate").set("Authorization", `Bearer ${chars.join("")}`).send({ transaction: {} });
    assert.equal(res.status, 401);
  });
});
