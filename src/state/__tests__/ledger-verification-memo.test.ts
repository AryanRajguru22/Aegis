import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../db.js";
import { createLedgerStore } from "../ledger.js";
import { generateLedgerKeyPair, ledgerPublicKeyToHex } from "../crypto.js";

/**
 * verifyChain() is O(entries) with an Ed25519 verify per entry and runs synchronously,
 * so repeated reads of an unchanged ledger are served from a memo. The memo is keyed on
 * a whole-database change token, so it must NEVER hide tampering: these tests prove a
 * repeat read is cheap, and that every kind of modification — in-process or from a
 * completely separate connection — still forces a fresh, failing verification.
 */

function setup(dbPath = ":memory:") {
  const db = openDatabase(dbPath);
  const keys = generateLedgerKeyPair();
  let fullPasses = 0;
  const ledger = createLedgerStore(db, keys, ledgerPublicKeyToHex(keys.publicKey), { onFullVerification: () => fullPasses++ });
  for (let i = 0; i < 5; i++) ledger.append({ kind: "decision", agentId: "a", principalId: "p", data: { i, verdict: "allow" } });
  return { db, ledger, passes: () => fullPasses };
}

describe("verifyChain memo — repeat reads of an unchanged database", () => {
  test("a second verifyChain() with no intervening write does not re-run the full pass, and returns the same result", () => {
    const { ledger, passes } = setup();
    assert.deepEqual(ledger.verifyChain(), { valid: true });
    assert.equal(passes(), 1);
    assert.deepEqual(ledger.verifyChain(), { valid: true });
    assert.deepEqual(ledger.verifyChain(), { valid: true });
    assert.equal(passes(), 1, "unchanged database served from the memo");
  });

  test("any append invalidates the memo", () => {
    const { ledger, passes } = setup();
    ledger.verifyChain();
    ledger.append({ kind: "decision", agentId: "a", principalId: "p", data: { more: true } });
    assert.deepEqual(ledger.verifyChain(), { valid: true });
    assert.equal(passes(), 2);
  });

  test("a returned result is a copy — mutating it cannot poison the memo", () => {
    const { ledger } = setup();
    const first = ledger.verifyChain();
    first.valid = false;
    assert.equal(ledger.verifyChain().valid, true);
  });
});

describe("verifyChain memo — tampering is never hidden by it", () => {
  test("an in-process UPDATE after a verified read is detected on the very next read", () => {
    const { db, ledger } = setup();
    assert.equal(ledger.verifyChain().valid, true);
    db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 2`).run(JSON.stringify({ i: 1, verdict: "deny" }));
    const result = ledger.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 2);
  });

  test("a DELETE of a middle entry after a verified read is detected", () => {
    const { db, ledger } = setup();
    assert.equal(ledger.verifyChain().valid, true);
    db.prepare(`DELETE FROM ledger_entries WHERE seq = 3`).run();
    assert.equal(ledger.verifyChain().valid, false);
  });

  test("an out-of-band modification through a SEPARATE connection (another process on the same file) is detected, with no write on this connection", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aegis-memo-"));
    const file = path.join(dir, "ledger.db");
    let main: DatabaseSync | undefined;
    try {
      const { db, ledger } = setup(file);
      main = db;
      assert.equal(ledger.verifyChain().valid, true); // memoized as valid

      const attacker = new DatabaseSync(file);
      attacker.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 4`).run(JSON.stringify({ i: 3, verdict: "deny" }));
      attacker.close();

      const result = ledger.verifyChain();
      assert.equal(result.valid, false, "the memo must not mask a modification made by another connection");
      assert.equal(result.brokenAtSeq, 4);
    } finally {
      main?.close(); // Windows refuses to delete a directory holding an open database file
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
