import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";

import { buildHarness, defaultCaveats, defaultTransaction } from "./harness.js";

async function setupPrincipalAndAgent(app: import("express").Express, principalId: string) {
  const principalRes = await request(app).post("/principals").send({ principalId });
  const apiKey: string = principalRes.body.apiKey;
  const agentRes = await request(app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId: `agent-${principalId}`, delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
  return { apiKey, agentId: agentRes.body.agentId as string, token: agentRes.body.token as string };
}

describe("GET /ledger", () => {
  test("rejects requests with no Authorization header", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/ledger");
    assert.equal(res.status, 401);
  });

  test("returns only the caller's own principal's entries, and reports the chain as valid", async () => {
    const { app } = buildHarness();
    const a = await setupPrincipalAndAgent(app, "principal-a");
    const b = await setupPrincipalAndAgent(app, "principal-b");

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${a.token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${b.token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    const resA = await request(app).get("/ledger").set("Authorization", `Bearer ${a.apiKey}`);
    assert.equal(resA.status, 200);
    assert.equal(resA.body.chainValid, true);
    assert.ok(resA.body.entries.length > 0);
    assert.ok(
      resA.body.entries.every((e: { principalId: string }) => e.principalId === "principal-a"),
      "principal A must never see principal B's ledger entries"
    );
  });

  test("a full agent-registration-through-execution flow produces the documented entry-kind sequence", async () => {
    const { app } = buildHarness();
    const a = await setupPrincipalAndAgent(app, "principal-a");

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${a.token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${a.apiKey}`);
    const kinds = res.body.entries.map((e: { kind: string }) => e.kind);
    assert.deepEqual(kinds, ["agent_registered", "policy_verdict", "risk_verdict", "decision", "execution_result"]);
  });

  test("?agentId filters correctly and is rejected for an agent the caller does not own", async () => {
    const { app } = buildHarness();
    const a = await setupPrincipalAndAgent(app, "principal-a");
    const b = await setupPrincipalAndAgent(app, "principal-b");

    const ownRes = await request(app).get(`/ledger?agentId=${a.agentId}`).set("Authorization", `Bearer ${a.apiKey}`);
    assert.equal(ownRes.status, 200);

    const foreignRes = await request(app).get(`/ledger?agentId=${b.agentId}`).set("Authorization", `Bearer ${a.apiKey}`);
    assert.equal(foreignRes.status, 403);
  });

  test("detects a tampered ledger entry and reports chainValid: false through the API, not just at the storage layer", async () => {
    const { app, db } = buildHarness();
    const a = await setupPrincipalAndAgent(app, "principal-a");
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${a.token}`)
      .set("Idempotency-Key", "k1")
      .send({ transaction: defaultTransaction(), counterparty: "acme-airlines" });

    const before = await request(app).get("/ledger").set("Authorization", `Bearer ${a.apiKey}`);
    assert.equal(before.body.chainValid, true, "sanity check before tampering");

    // Reach past the API to simulate storage-layer tampering (e.g. a rogue DBA),
    // the same way src/state's own ledger tests do — this proves the API surfaces
    // the ledger's real tamper-evidence property end to end, not just that the
    // ledger module does in isolation.
    db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 1`).run(JSON.stringify({ tampered: true }));

    const after = await request(app).get("/ledger").set("Authorization", `Bearer ${a.apiKey}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.chainValid, false);
  });
});

describe("GET /stream (SSE) — real listening server", () => {
  test("delivers a live ledger event for the subscribing principal's own transaction, and never for another principal's", async () => {
    const { app } = buildHarness();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const a = await setupPrincipalAndAgent(app, "principal-a");
      const b = await setupPrincipalAndAgent(app, "principal-b");

      const controller = new AbortController();
      const streamResponse = await fetch(`${baseUrl}/stream`, {
        headers: { Authorization: `Bearer ${a.apiKey}` },
        signal: controller.signal,
      });
      assert.equal(streamResponse.status, 200);
      const reader = streamResponse.body!.getReader();
      const decoder = new TextDecoder();

      let buffered = "";
      const events: string[] = [];
      const collect = (async () => {
        while (events.length < 1) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const parts = buffered.split("\n\n");
          buffered = parts.pop() ?? "";
          for (const part of parts) {
            if (part.includes("event: ledger_entry")) events.push(part);
          }
        }
      })();

      // give the SSE subscription a moment to attach, then fire transactions from
      // both principals — only A's should ever reach A's stream.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fetch(`${baseUrl}/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${b.token}`, "idempotency-key": "b-1" },
        body: JSON.stringify({ transaction: defaultTransaction(), counterparty: "acme-airlines" }),
      });
      await fetch(`${baseUrl}/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${a.token}`, "idempotency-key": "a-1" },
        body: JSON.stringify({ transaction: defaultTransaction(), counterparty: "acme-airlines" }),
      });

      await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, 3000))]);
      controller.abort();

      assert.ok(events.length >= 1, "expected at least one ledger_entry event for principal A's own transaction");
      assert.ok(
        events.every((e) => e.includes('"principalId":"principal-a"')),
        "principal B's transaction must never appear on principal A's stream"
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
