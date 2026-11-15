import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { buildHarness, defaultCaveats, defaultTransaction } from "./harness.js";

async function seed() {
  const h = buildHarness();
  const apiKey = (await request(h.app).post("/principals").send({ principalId: "acme" })).body.apiKey as string;
  const other = (await request(h.app).post("/principals").send({ principalId: "other" })).body.apiKey as string;
  const agent = await request(h.app)
    .post("/agents")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ agentId: "agent-1", delegatedGoal: "Book conference travel", caveats: defaultCaveats() });
  await request(h.app).post("/agents").set("Authorization", `Bearer ${other}`).send({ agentId: "agent-other", delegatedGoal: "x", caveats: defaultCaveats() });
  for (let i = 0; i < 4; i++) {
    await request(h.app)
      .post("/transactions")
      .set("Authorization", `Bearer ${agent.body.token}`)
      .set("Idempotency-Key", `k${i}`)
      .send({ transaction: defaultTransaction({ amountMinorUnits: 1000 + i }), counterparty: "acme-airlines" });
  }
  return { ...h, apiKey, other };
}

const get = (h: { app: import("express").Express; apiKey: string }, qs: string) =>
  request(h.app).get(`/ledger${qs}`).set("Authorization", `Bearer ${h.apiKey}`);

describe("GET /ledger — pagination and filtering", () => {
  test("with no query parameters the response is the complete history and carries no page object (backward compatible)", async () => {
    const h = await seed();
    const res = await get(h, "");
    assert.equal(res.status, 200);
    assert.equal(res.body.page, undefined);
    assert.ok(res.body.entries.length > 10);
    assert.equal(res.body.chainValid, true);
  });

  test("limit returns the NEWEST entries in ascending order, with a cursor that walks back to the complete history without gaps or overlap", async () => {
    const h = await seed();
    const full = (await get(h, "")).body.entries as Array<{ seq: number }>;

    const seen: number[] = [];
    let qs = "?limit=5";
    for (let guard = 0; guard < 100; guard++) {
      const res = await get(h, qs);
      assert.equal(res.status, 200);
      const seqs = (res.body.entries as Array<{ seq: number }>).map((e) => e.seq);
      assert.ok(seqs.length <= 5);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "ascending within a page");
      seen.unshift(...seqs);
      if (!res.body.page.hasMore) {
        assert.equal(res.body.page.nextBeforeSeq, null);
        break;
      }
      qs = `?limit=5&beforeSeq=${res.body.page.nextBeforeSeq}`;
    }
    assert.deepEqual(seen, full.map((e) => e.seq), "pages reassemble exactly into the full history");
  });

  test("the first page is the newest slice", async () => {
    const h = await seed();
    const full = (await get(h, "")).body.entries as Array<{ seq: number }>;
    const res = await get(h, "?limit=3");
    assert.deepEqual(
      (res.body.entries as Array<{ seq: number }>).map((e) => e.seq),
      full.slice(-3).map((e) => e.seq)
    );
    assert.equal(res.body.page.total, full.length);
    assert.equal(res.body.page.hasMore, true);
  });

  test("kind filters by exact entry kind", async () => {
    const h = await seed();
    const res = await get(h, "?kind=decision");
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.length > 0);
    assert.ok((res.body.entries as Array<{ kind: string }>).every((e) => e.kind === "decision"));
  });

  test("chainValid describes the WHOLE chain, not the page: tampering an entry outside the requested page is still reported", async () => {
    const h = await seed();
    h.db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 1`).run(JSON.stringify({ tampered: true }));
    const res = await get(h, "?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.every((e: { seq: number }) => e.seq !== 1), true, "the tampered entry is not on this page");
    assert.equal(res.body.chainValid, false);
    assert.equal(res.body.brokenAtSeq, 1);
  });

  test("paging never widens scope: another principal's entries stay invisible, and a foreign agentId is still refused", async () => {
    const h = await seed();
    const res = await get(h, "?limit=1000");
    assert.ok((res.body.entries as Array<{ principalId: string }>).every((e) => e.principalId === "acme"));
    assert.equal((await get(h, "?agentId=agent-other&limit=5")).status, 403);
  });

  test("malformed or out-of-range paging parameters are rejected with 400, never coerced", async () => {
    const h = await seed();
    for (const qs of ["?limit=0", "?limit=-1", "?limit=abc", "?limit=1.5", "?limit=1001", "?limit=1&limit=2", "?beforeSeq=0", "?beforeSeq=x", "?kind=", "?limit=1e3"]) {
      assert.equal((await get(h, qs)).status, 400, qs);
    }
  });
});
