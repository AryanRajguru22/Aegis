import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../db.js";
import { createAgentStore } from "../agents.js";
import { createPrincipalStore } from "../principals.js";
import { createLedgerStore, GENESIS_HASH } from "../ledger.js";
import { generateLedgerKeyPair, ledgerPublicKeyToHex, sha256Hex, sign, stableStringify } from "../crypto.js";

function freshLedger() {
  const db = openDatabase(":memory:");
  const keys = generateLedgerKeyPair();
  const publicKeyHex = ledgerPublicKeyToHex(keys.publicKey);
  const ledger = createLedgerStore(db, keys, publicKeyHex);
  return { db, keys, ledger };
}

describe("principal store", () => {
  test("creates a principal, returns a usable API key, and authenticates it back to the right principalId", () => {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);

    const apiKey = principals.create("acme-corp");
    assert.equal(typeof apiKey, "string");
    assert.ok(apiKey.length >= 32);
    assert.equal(principals.authenticate(apiKey), "acme-corp");
  });

  test("rejects creating a principalId that already exists", () => {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);
    principals.create("acme-corp");
    assert.throws(() => principals.create("acme-corp"));
  });

  test("does not authenticate an unrecognized key", () => {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);
    principals.create("acme-corp");
    assert.equal(principals.authenticate("not-a-real-key"), undefined);
  });

  test("does not authenticate an empty or garbage key", () => {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);
    assert.equal(principals.authenticate(""), undefined);
    assert.equal(principals.authenticate("' OR 1=1 --"), undefined);
  });

  test("two principals get distinct, mutually non-authenticating keys", () => {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);
    const keyA = principals.create("principal-a");
    const keyB = principals.create("principal-b");

    assert.notEqual(keyA, keyB);
    assert.equal(principals.authenticate(keyA), "principal-a");
    assert.equal(principals.authenticate(keyB), "principal-b");
  });

  test("the raw API key is never recoverable from the store's own persisted state — only its hash is kept", () => {
    const db = openDatabase(":memory:");
    const principals = createPrincipalStore(db);
    const apiKey = principals.create("acme-corp");

    const row = db.prepare(`SELECT api_key_hash FROM principals WHERE principal_id = ?`).get("acme-corp") as { api_key_hash: string };
    assert.notEqual(row.api_key_hash, apiKey);
    assert.equal(row.api_key_hash, sha256Hex(apiKey));
  });
});

describe("agent store", () => {
  test("registers a root agent and a delegation tree beneath it", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);

    const root = agents.register({
      agentId: "agent-root",
      principalId: "principal-1",
      parentAgentId: null,
      delegatedGoal: "Book conference travel",
      caveats: { maxAmountMinorUnits: 200_000 },
      tokenBase64: "root-token",
      revocationId: "rev-root",
    });
    assert.equal(root.rootAgentId, "agent-root");

    const flights = agents.register({
      agentId: "agent-flights",
      principalId: "principal-1",
      parentAgentId: "agent-root",
      delegatedGoal: "Book flights",
      caveats: { maxAmountMinorUnits: 50_000 },
      tokenBase64: "flights-token",
      revocationId: "rev-flights",
    });
    assert.equal(flights.rootAgentId, "agent-root");

    const grandchild = agents.register({
      agentId: "agent-flights-task",
      principalId: "principal-1",
      parentAgentId: "agent-flights",
      delegatedGoal: "Book one specific flight",
      caveats: { maxAmountMinorUnits: 20_000 },
      tokenBase64: "task-token",
      revocationId: "rev-task",
    });
    assert.equal(grandchild.rootAgentId, "agent-root", "a grandchild's root must still resolve to the original root, not its immediate parent");

    assert.deepEqual(
      agents.listChildren("agent-root").map((a) => a.agentId),
      ["agent-flights"]
    );
    assert.deepEqual(
      agents.listTree("agent-root")
        .map((a) => a.agentId)
        .sort(),
      ["agent-flights", "agent-flights-task", "agent-root"]
    );
    assert.equal(agents.listByPrincipal("principal-1").length, 3);

    assert.equal(agents.getByRevocationId("rev-flights")?.agentId, "agent-flights");
    assert.equal(agents.getByRevocationId("rev-nonexistent"), undefined);
  });

  test("rejects registering the same agentId twice", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);
    agents.register({
      agentId: "agent-root",
      principalId: "principal-1",
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: "rev-1",
    });
    assert.throws(() =>
      agents.register({
        agentId: "agent-root",
        principalId: "principal-1",
        parentAgentId: null,
        delegatedGoal: "x",
        caveats: {},
        tokenBase64: "t",
        revocationId: "rev-2",
      })
    );
  });

  test("rejects registering a sub-agent whose declared parent does not exist", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);
    assert.throws(() =>
      agents.register({
        agentId: "agent-orphan",
        principalId: "principal-1",
        parentAgentId: "agent-nonexistent",
        delegatedGoal: "x",
        caveats: {},
        tokenBase64: "t",
        revocationId: "rev-orphan",
      })
    );
  });

  test("rejects a sub-agent registered under a different principal than its parent", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);
    agents.register({
      agentId: "agent-root",
      principalId: "principal-1",
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: "rev-root-2",
    });
    assert.throws(() =>
      agents.register({
        agentId: "agent-sub",
        principalId: "principal-2",
        parentAgentId: "agent-root",
        delegatedGoal: "x",
        caveats: {},
        tokenBase64: "t",
        revocationId: "rev-sub-2",
      })
    );
  });

  test("rejects registering two agents with the same revocation id", () => {
    const db = openDatabase(":memory:");
    const agents = createAgentStore(db);
    agents.register({
      agentId: "agent-x",
      principalId: "principal-1",
      parentAgentId: null,
      delegatedGoal: "x",
      caveats: {},
      tokenBase64: "t",
      revocationId: "rev-shared",
    });
    assert.throws(() =>
      agents.register({
        agentId: "agent-y",
        principalId: "principal-1",
        parentAgentId: null,
        delegatedGoal: "y",
        caveats: {},
        tokenBase64: "t2",
        revocationId: "rev-shared",
      })
    );
  });
});

describe("hash-chained ledger — happy path", () => {
  test("a fresh chain of entries verifies as valid, links correctly, and starts from genesis", () => {
    const { ledger } = freshLedger();

    const e1 = ledger.append({ kind: "agent_registered", agentId: "agent-root", principalId: "principal-1", data: { note: "root created" } });
    const e2 = ledger.append({ kind: "policy_verdict", agentId: "agent-root", principalId: "principal-1", data: { allowed: true, amount: 38000 } });
    const e3 = ledger.append({ kind: "revocation", agentId: "agent-root", principalId: "principal-1", data: { reason: "emergency" } });

    assert.equal(e1.prevHash, GENESIS_HASH);
    assert.equal(e2.prevHash, e1.contentHash);
    assert.equal(e3.prevHash, e2.contentHash);

    const verification = ledger.verifyChain();
    assert.deepEqual(verification, { valid: true });
  });

  test("an empty ledger verifies trivially", () => {
    const { ledger } = freshLedger();
    assert.deepEqual(ledger.verifyChain(), { valid: true });
  });

  test("listByAgent and listByPrincipal filter correctly", () => {
    const { ledger } = freshLedger();
    ledger.append({ kind: "a", agentId: "agent-flights", principalId: "principal-1", data: {} });
    ledger.append({ kind: "a", agentId: "agent-hotels", principalId: "principal-1", data: {} });
    ledger.append({ kind: "a", agentId: "agent-flights", principalId: "principal-1", data: {} });

    assert.equal(ledger.listByAgent("agent-flights").length, 2);
    assert.equal(ledger.listByAgent("agent-hotels").length, 1);
    assert.equal(ledger.listByPrincipal("principal-1").length, 3);
    assert.equal(ledger.all().length, 3);
  });
});

describe("stableStringify — undefined handling matches JSON.stringify exactly (Step 22 regression)", () => {
  // The bug: data_json (what's actually persisted, see append() below) is written
  // with plain JSON.stringify, which OMITS an object property whose value is
  // undefined and substitutes null for an undefined array element. Before this fix,
  // stableStringify (what's hashed) instead INCLUDED such properties as the literal
  // text "undefined" and left array holes — so a legitimately-shaped entry (e.g. a
  // mission_pipeline_outcome for a deny/escalate verdict, where `risk`/`execution`
  // are genuinely absent — see src/mission/ledger.ts's MissionPipelineOutcomeData)
  // would hash one way at write time and a different way on every future reload,
  // permanently failing re-verification despite never being tampered with.

  test("1. an object with an explicit `key: undefined` property serializes identically to JSON.stringify (the key is omitted)", () => {
    const obj = { a: 1, execution: undefined, b: 2 };
    assert.deepEqual(JSON.parse(stableStringify(obj)), JSON.parse(JSON.stringify(obj)));
    assert.equal(stableStringify(obj), '{"a":1,"b":2}');
  });

  test("2. a nested undefined property (inside a nested object, and inside a nested array) matches JSON.stringify at every level", () => {
    const obj = { outer: { inner: undefined, kept: 1 }, list: [1, undefined, 3], top: undefined };
    // stableStringify sorts keys (JSON.stringify preserves insertion order), so the
    // two strings are never expected to be byte-identical in general — what must
    // match is which keys/values survive at every nesting level. Comparing the
    // JSON.stringify output re-parsed back through JSON.parse (which normalizes
    // both to the same key SET, independent of order) is the correct invariant.
    assert.deepEqual(JSON.parse(stableStringify(obj)), JSON.parse(JSON.stringify(obj)));
    assert.equal(stableStringify(obj), '{"list":[1,null,3],"outer":{"kept":1}}');
  });

  test("an array containing an undefined element substitutes null, matching JSON.stringify (not an empty hole)", () => {
    const arr = [1, undefined, 3];
    assert.equal(stableStringify(arr), JSON.stringify(arr));
    assert.equal(stableStringify(arr), "[1,null,3]");
  });

  test("an object with NO undefined properties is byte-identical before and after this fix (non-regression for every already-correct entry)", () => {
    const obj = { z: 1, a: "x", nested: { b: [1, 2, 3] } };
    assert.equal(stableStringify(obj), '{"a":"x","nested":{"b":[1,2,3]},"z":1}');
  });
});

describe("hash-chained ledger — mission_pipeline_outcome-shaped entries with legitimately absent fields (Step 22 regression)", () => {
  // Reproduces the exact real shape src/api/routes/transactions.ts builds: a
  // mission_pipeline_outcome entry always writes `execution: result.execution` and
  // `risk: result.decision.risk`, both of which are genuinely absent — not merely
  // falsy — for certain outcomes. These tests use the real, unmodified
  // createLedgerStore/verifyChain (never a mock), proving the fix at the actual
  // append -> persist -> reload -> verify boundary, not just in stableStringify
  // isolation above.

  function denyShapedData() {
    // Policy denied before the risk engine ever ran — `risk` is absent, exactly as
    // decide.ts's early-return constructs { verdict, reason, policy } with no risk key.
    return {
      missionId: "mission-1",
      amountMinorUnits: 38_000,
      category: "flights",
      counterparty: "acme-airlines",
      verdict: "deny",
      reason: "Policy denied this transaction",
      policy: { allowed: false, reason: "unauthorized category" },
      risk: undefined,
      execution: undefined,
    };
  }

  function escalateShapedData() {
    // Policy allowed, risk ran and escalated — `execution` is absent, since
    // executeTransaction() never reaches the rail for a non-"allow" verdict.
    return {
      missionId: "mission-1",
      amountMinorUnits: 38_000,
      category: "flights",
      counterparty: "acme-airlines",
      verdict: "escalate",
      reason: "Behavioral anomaly detected",
      policy: { allowed: true },
      risk: { intentJudgment: { verdict: "consistent", rationale: "ok" }, baselineFlags: [{ code: "high_rate", detail: "5 in 60s" }] },
      execution: undefined,
    };
  }

  function allowShapedData() {
    // Control case: both fields genuinely present — must keep verifying correctly too.
    return {
      missionId: "mission-1",
      amountMinorUnits: 38_000,
      category: "flights",
      counterparty: "acme-airlines",
      verdict: "allow",
      reason: "Policy satisfied",
      policy: { allowed: true },
      risk: { intentJudgment: { verdict: "consistent", rationale: "ok" }, baselineFlags: [] },
      execution: { success: true, rail: "mock_x402", reference: "ref-1" },
    };
  }

  test("3. a deny-shaped entry (risk: undefined) round-trips through append -> verifyChain as valid", () => {
    const { ledger } = freshLedger();
    ledger.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: denyShapedData() });
    assert.deepEqual(ledger.verifyChain(), { valid: true });
  });

  test("4. an escalate-shaped entry (execution: undefined) round-trips through append -> verifyChain as valid", () => {
    const { ledger } = freshLedger();
    ledger.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: escalateShapedData() });
    assert.deepEqual(ledger.verifyChain(), { valid: true });
  });

  test("5. an allow-shaped entry (both fields present) still round-trips as valid (control — nothing broke for the already-correct case)", () => {
    const { ledger } = freshLedger();
    ledger.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: allowShapedData() });
    assert.deepEqual(ledger.verifyChain(), { valid: true });
  });

  test("6. after a simulated restart (a fresh LedgerStore instance opened on the SAME db), deny/escalate-shaped entries still verify — proving the fix holds across a genuine reload, not just the in-memory object that was just appended", () => {
    const db = openDatabase(":memory:");
    const keys = generateLedgerKeyPair();
    const publicKeyHex = ledgerPublicKeyToHex(keys.publicKey);
    const ledgerBeforeRestart = createLedgerStore(db, keys, publicKeyHex);
    ledgerBeforeRestart.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: denyShapedData() });
    ledgerBeforeRestart.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: escalateShapedData() });
    ledgerBeforeRestart.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: allowShapedData() });

    // A brand-new LedgerStore over the same underlying db — every entry is read back
    // from data_json fresh, exactly as a real process restart would.
    const ledgerAfterRestart = createLedgerStore(db, keys, publicKeyHex);
    assert.deepEqual(ledgerAfterRestart.verifyChain(), { valid: true });
    assert.equal(ledgerAfterRestart.all().length, 3);
  });

  test("8. genuine tampering of a deny-shaped entry is STILL caught — the fix closes the false positive without weakening true-positive detection", () => {
    const db = openDatabase(":memory:");
    const keys = generateLedgerKeyPair();
    const publicKeyHex = ledgerPublicKeyToHex(keys.publicKey);
    const ledger = createLedgerStore(db, keys, publicKeyHex);
    const entry = ledger.append({ kind: "mission_pipeline_outcome", agentId: "agent-1", principalId: "principal-1", data: denyShapedData() });
    assert.deepEqual(ledger.verifyChain(), { valid: true }, "precondition: valid before tampering");

    const tampered = { ...denyShapedData(), reason: "TAMPERED — this was never the real denial reason" };
    db.prepare(`UPDATE ledger_entries SET data_json = :data_json WHERE seq = :seq`).run({ data_json: JSON.stringify(tampered), seq: entry.seq });

    const verification = ledger.verifyChain();
    assert.equal(verification.valid, false);
    assert.equal(verification.brokenAtSeq, entry.seq);
  });
});

describe("hash-chained ledger — tamper detection", () => {
  test("directly modifying an entry's data without updating its hash is caught by a content-hash mismatch", () => {
    const { db, ledger } = freshLedger();
    ledger.append({ kind: "policy_verdict", agentId: "agent-root", principalId: "principal-1", data: { allowed: false, amount: 900 } });
    ledger.append({ kind: "policy_verdict", agentId: "agent-root", principalId: "principal-1", data: { allowed: true, amount: 200 } });

    // Simulate someone editing history directly at the storage layer (e.g. a rogue
    // DBA), rewriting a "denied" decision into an "allowed" one, without touching the
    // hash or signature columns at all.
    db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 1`).run(JSON.stringify({ allowed: true, amount: 900 }));

    const result = ledger.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 1);
    assert.match(result.reason ?? "", /content hash/);
  });

  test("modifying an entry AND recomputing a consistent content hash is still caught, because the signature no longer matches", () => {
    const { db, ledger, keys } = freshLedger();
    const first = ledger.append({ kind: "policy_verdict", agentId: "agent-root", principalId: "principal-1", data: { allowed: false, amount: 900 } });
    ledger.append({ kind: "policy_verdict", agentId: "agent-root", principalId: "principal-1", data: { allowed: true, amount: 200 } });

    // A more sophisticated attacker: knows the hashing scheme and recomputes a content
    // hash that is internally consistent with the tampered data, hoping to slip past a
    // naive "does the hash match the data" check. They cannot produce a valid
    // signature over that new hash without the ledger's private key, so this must
    // still be caught.
    const tamperedData = { allowed: true, amount: 900 };
    const forgedContentHash = sha256Hex(
      [first.kind, first.agentId, first.principalId, stableStringify(tamperedData), first.createdAt, first.prevHash].join("\n")
    );
    db.prepare(`UPDATE ledger_entries SET data_json = ?, content_hash = ? WHERE seq = 1`).run(
      JSON.stringify(tamperedData),
      forgedContentHash
    );

    const result = ledger.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 1);
    assert.match(result.reason ?? "", /signature/);

    // sanity: prove the forged hash really was internally consistent (i.e. this test
    // is actually exercising the signature check, not accidentally the hash check)
    assert.equal(
      sha256Hex(
        [first.kind, first.agentId, first.principalId, stableStringify(tamperedData), first.createdAt, first.prevHash].join("\n")
      ),
      forgedContentHash
    );
    void keys;
  });

  test("breaking the prevHash link between two otherwise-untouched entries is caught", () => {
    const { db, ledger } = freshLedger();
    ledger.append({ kind: "a", agentId: "agent-root", principalId: "principal-1", data: { i: 1 } });
    ledger.append({ kind: "a", agentId: "agent-root", principalId: "principal-1", data: { i: 2 } });
    ledger.append({ kind: "a", agentId: "agent-root", principalId: "principal-1", data: { i: 3 } });

    db.prepare(`UPDATE ledger_entries SET prev_hash = ? WHERE seq = 3`).run("f".repeat(64));

    const result = ledger.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 3);
    assert.match(result.reason ?? "", /chain link/);
  });

  test("a forged entry signed with a different key entirely is caught", () => {
    const { db, ledger } = freshLedger();
    const first = ledger.append({ kind: "a", agentId: "agent-root", principalId: "principal-1", data: { i: 1 } });

    const attackerKeys = generateLedgerKeyPair();
    const forgedData = { i: 999 };
    const forgedHash = sha256Hex(
      ["a", "agent-root", "principal-1", stableStringify(forgedData), first.createdAt, GENESIS_HASH].join("\n")
    );
    const forgedSignature = sign(attackerKeys.privateKey, forgedHash);
    db.prepare(`UPDATE ledger_entries SET data_json = ?, content_hash = ?, signature = ? WHERE seq = 1`).run(
      JSON.stringify(forgedData),
      forgedHash,
      forgedSignature
    );

    const result = ledger.verifyChain();
    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /signature/);
  });
});
