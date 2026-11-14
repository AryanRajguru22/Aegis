import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { openDatabase } from "../../state/db.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../../state/index.js";
import { ensureMissionBindingEpoch, MISSION_BINDING_POLICY, POLICY_EPOCH_KIND, SYSTEM_ACTOR } from "../policyEpoch.js";
import { buildHarness } from "./harness.js";

function freshLedger() {
  const db = openDatabase(":memory:");
  const keys = generateLedgerKeyPair();
  const open = () => createLedgerStore(db, keys, ledgerPublicKeyToHex(keys.publicKey));
  return { db, open };
}

describe("mission-binding policy epoch marker", () => {
  test("is appended once, as a valid signed entry", () => {
    const { open } = freshLedger();
    const ledger = open();
    assert.equal(ensureMissionBindingEpoch(ledger), true);
    const entries = ledger.all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, POLICY_EPOCH_KIND);
    assert.equal(entries[0]!.data.policy, MISSION_BINDING_POLICY);
    assert.equal(ledger.verifyChain().valid, true);
  });

  test("is idempotent across calls and across a restart on the same database", () => {
    const { open } = freshLedger();
    assert.equal(ensureMissionBindingEpoch(open()), true);
    assert.equal(ensureMissionBindingEpoch(open()), false);
    assert.equal(ensureMissionBindingEpoch(open()), false);
    assert.equal(open().all().length, 1);
  });

  test("lands after pre-existing entries (legacy ledgers) without breaking the chain", () => {
    const { open } = freshLedger();
    const ledger = open();
    ledger.append({ kind: "agent_registered", agentId: "a1", principalId: "p1", data: {} });
    assert.equal(ensureMissionBindingEpoch(ledger), true);
    const entries = ledger.all();
    assert.equal(entries[1]!.kind, POLICY_EPOCH_KIND);
    assert.equal(ledger.verifyChain().valid, true);
  });

  test("a principal can neither claim the system actor id nor see the marker in its own ledger", async () => {
    const { app, deps } = buildHarness();
    ensureMissionBindingEpoch(deps.ledger);

    const claim = await request(app).post("/principals").send({ principalId: SYSTEM_ACTOR });
    assert.equal(claim.status, 400);

    const reg = await request(app).post("/principals").send({ principalId: "acme-corp" });
    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${reg.body.apiKey}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries, []);
    assert.equal(res.body.chainValid, true);
  });
});
