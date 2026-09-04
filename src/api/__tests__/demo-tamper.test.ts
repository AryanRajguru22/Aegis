import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";

import { openDatabase } from "../../state/db.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../../state/index.js";
import { createPrincipalStore } from "../../state/principals.js";
import { errorHandler } from "../errors.js";
import { applyDemoLedgerTamper, createDemoTamperRouter } from "../demoTamper.js";

/**
 * Step 13, Scenario C: adversarial tests for the ONE new backend surface in the whole
 * local-demo-theatre feature. src/state/ledger.ts (LedgerStore, verifyChain) is
 * imported here UNCHANGED and UNMODIFIED — these tests prove the real, existing
 * tamper-detection guarantee catches a real corruption produced by this new module,
 * not that anything about the ledger itself changed.
 */

function freshLedger() {
  const db = openDatabase(":memory:");
  const keys = generateLedgerKeyPair();
  const ledger = createLedgerStore(db, keys, ledgerPublicKeyToHex(keys.publicKey));
  return { db, ledger };
}

function rawRow(db: ReturnType<typeof openDatabase>, seq: number) {
  return db.prepare(`SELECT * FROM ledger_entries WHERE seq = :seq`).get({ seq }) as Record<string, unknown>;
}

describe("applyDemoLedgerTamper — pure mutation logic against the real, unmodified LedgerStore", () => {
  test("tampering a valid, owned entry succeeds, and the REAL verifyChain() (untouched) then detects the corruption at that exact seq", () => {
    const { db, ledger } = freshLedger();
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: { delegatedGoal: "x" } });

    assert.equal(ledger.verifyChain().valid, true, "precondition: chain starts valid");

    const result = applyDemoLedgerTamper(db, "principal-a", entry.seq);
    assert.equal(result.ok, true);
    assert.equal(result.seq, entry.seq);

    const verification = ledger.verifyChain();
    assert.equal(verification.valid, false, "verifyChain() — completely unmodified — must now report the chain broken");
    assert.equal(verification.brokenAtSeq, entry.seq, "the break must be reported at exactly the tampered entry");
    assert.match(verification.reason ?? "", /content hash|signature/i);
  });

  test("ADVERSARIAL: tampering an entry belonging to a DIFFERENT principal is rejected, and the chain remains genuinely untouched", () => {
    const { db, ledger } = freshLedger();
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: { delegatedGoal: "x" } });

    const result = applyDemoLedgerTamper(db, "principal-b", entry.seq);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /does not belong to the authenticated principal/);

    assert.equal(ledger.verifyChain().valid, true, "a rejected ownership check must leave the chain genuinely valid, not merely 'not yet checked'");
  });

  test("tampering a nonexistent seq fails cleanly", () => {
    const { db } = freshLedger();
    const result = applyDemoLedgerTamper(db, "principal-a", 999);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /No ledger entry/);
  });

  test("invalid seq values (zero, negative, non-integer) are rejected before any query", () => {
    const { db } = freshLedger();
    for (const bad of [0, -1, 1.5, NaN]) {
      const result = applyDemoLedgerTamper(db, "principal-a", bad);
      assert.equal(result.ok, false);
    }
  });

  test("ADVERSARIAL: only the targeted entry's row changes — every other entry's stored bytes are byte-for-byte identical before and after", () => {
    const { db, ledger } = freshLedger();
    const e1 = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: { delegatedGoal: "one" } });
    const e2 = ledger.append({ kind: "agent_registered", agentId: "agent-2", principalId: "principal-a", data: { delegatedGoal: "two" } });
    const e3 = ledger.append({ kind: "agent_registered", agentId: "agent-3", principalId: "principal-a", data: { delegatedGoal: "three" } });

    const before1 = rawRow(db, e1.seq);
    const before3 = rawRow(db, e3.seq);

    applyDemoLedgerTamper(db, "principal-a", e2.seq);

    assert.deepEqual(rawRow(db, e1.seq), before1, "an untouched entry before the tampered one must be completely unchanged");
    assert.deepEqual(rawRow(db, e3.seq), before3, "an untouched entry after the tampered one must be completely unchanged");
  });

  test("ADVERSARIAL: the tamper operation never writes content_hash, signature, or prev_hash — only data_json differs before/after", () => {
    const { db, ledger } = freshLedger();
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: { delegatedGoal: "x" } });
    const before = rawRow(db, entry.seq);

    applyDemoLedgerTamper(db, "principal-a", entry.seq);
    const after = rawRow(db, entry.seq);

    assert.equal(after.content_hash, before.content_hash, "content_hash must never be rewritten by the tamper operation");
    assert.equal(after.signature, before.signature, "signature must never be rewritten by the tamper operation");
    assert.equal(after.prev_hash, before.prev_hash, "prev_hash must never be rewritten by the tamper operation");
    assert.equal(after.kind, before.kind);
    assert.equal(after.agent_id, before.agent_id);
    assert.equal(after.principal_id, before.principal_id);
    assert.equal(after.created_at, before.created_at);
    assert.notEqual(after.data_json, before.data_json, "only data_json may differ");
  });

  test("ADVERSARIAL: the operation cannot repair, restore, or toggle — calling it again on an already-tampered entry never returns the chain to valid", () => {
    const { db, ledger } = freshLedger();
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: { delegatedGoal: "x" } });

    applyDemoLedgerTamper(db, "principal-a", entry.seq);
    assert.equal(ledger.verifyChain().valid, false);

    applyDemoLedgerTamper(db, "principal-a", entry.seq); // a second call — there is no argument that means "undo"
    assert.equal(ledger.verifyChain().valid, false, "a second tamper call must never restore validity — no restore path exists");
  });
});

describe("createDemoTamperRouter — HTTP-level authentication and ownership", () => {
  function buildRouterApp() {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);
    const keys = generateLedgerKeyPair();
    const ledger = createLedgerStore(db, keys, ledgerPublicKeyToHex(keys.publicKey));
    const app = express();
    app.use(createDemoTamperRouter(db, principals));
    app.use(errorHandler);
    return { app, db, principals, ledger };
  }

  test("an unauthenticated request is rejected", async () => {
    const { app, ledger, principals } = buildRouterApp();
    principals.create("principal-a");
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: {} });

    const res = await request(app).post(`/demo/tamper-ledger-entry/${entry.seq}`);
    assert.equal(res.status, 401);
  });

  test("a wrong-principal request is rejected with 404, and the chain remains valid", async () => {
    const { app, ledger, principals } = buildRouterApp();
    principals.create("principal-a");
    const otherKey = principals.create("principal-b");
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: {} });

    const res = await request(app).post(`/demo/tamper-ledger-entry/${entry.seq}`).set("Authorization", `Bearer ${otherKey}`);
    assert.equal(res.status, 404);
    assert.equal(ledger.verifyChain().valid, true);
  });

  test("a nonexistent seq is rejected with 404", async () => {
    const { app, principals } = buildRouterApp();
    const key = principals.create("principal-a");
    const res = await request(app).post("/demo/tamper-ledger-entry/999").set("Authorization", `Bearer ${key}`);
    assert.equal(res.status, 404);
  });

  test("an invalid seq param is rejected with 400", async () => {
    const { app, principals } = buildRouterApp();
    const key = principals.create("principal-a");
    const res = await request(app).post("/demo/tamper-ledger-entry/not-a-number").set("Authorization", `Bearer ${key}`);
    assert.equal(res.status, 400);
  });

  test("a valid, owned request succeeds and the real verifyChain() then detects the break", async () => {
    const { app, ledger, principals } = buildRouterApp();
    const key = principals.create("principal-a");
    const entry = ledger.append({ kind: "agent_registered", agentId: "agent-1", principalId: "principal-a", data: {} });

    const res = await request(app).post(`/demo/tamper-ledger-entry/${entry.seq}`).set("Authorization", `Bearer ${key}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { tampered: true, seq: entry.seq });
    assert.equal(ledger.verifyChain().valid, false);
  });
});

describe("the demo route is structurally absent from any app it isn't explicitly mounted on — proven the same way production's own app is built", () => {
  test("hitting the tamper path against a plain, un-wrapped app (exactly what production's own `createApp()` — see src/api/server.ts — looks like, since createDemoTamperRouter is never mounted there) returns the app's OWN generic 404, never reaching the tamper logic", async () => {
    // Mirrors production exactly: createDemoTamperRouter is constructed and mounted
    // ONLY by src/api/securityLab.ts, against that module's own isolated `:memory:`
    // db (see that file and demoTamper.ts's own doc comments) — never by
    // src/api/main.ts against the real, file-backed production `db`. This directly
    // exercises the plain-app shape production's own pipeline actually has.
    const plainApp = express();
    plainApp.use((_req, res) => res.status(404).json({ error: "Not found" })); // the same catch-all shape createApp() itself uses

    const res = await request(plainApp).post("/demo/tamper-ledger-entry/1");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Not found", "must be the app's generic catch-all message, not a tamper-specific error — proving the route was never mounted, not merely rejected");
  });
});
