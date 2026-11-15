import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../db.js";
import { createLedgerStore } from "../ledger.js";
import { generateLedgerKeyPair, ledgerPublicKeyToHex, sign } from "../crypto.js";

/**
 * verifyChainAsync(): the request-path variant of full-chain verification. Measured motivation
 * (scripts/loadtest.mjs, docs/LOAD_TESTING.md): the synchronous pass blocked the whole server for
 * ~2s at ~10k entries, and every write invalidates the memo. The async variant must (1) reach
 * EXACTLY the verdict the synchronous one does, for a valid chain and for every tamper mode,
 * (2) really yield to the event loop, (3) share one pass between concurrent callers, and (4) never
 * let the memo hide a later modification.
 */

function setup(entries = 5, dbPath = ":memory:") {
  const db = openDatabase(dbPath);
  const keys = generateLedgerKeyPair();
  let passes = 0;
  const ledger = createLedgerStore(db, keys, ledgerPublicKeyToHex(keys.publicKey), { onFullVerification: () => passes++ });
  for (let i = 0; i < entries; i++) ledger.append({ kind: "decision", agentId: "a", principalId: "p", data: { i } });
  return { db, keys, ledger, passes: () => passes };
}

describe("verifyChainAsync — same verdicts as verifyChain", () => {
  test("a valid chain (including an empty one and one spanning several batches)", async () => {
    assert.deepEqual(await setup(0).ledger.verifyChainAsync(), { valid: true });
    const { ledger } = setup(450); // > 2 batches of 200
    assert.deepEqual(await ledger.verifyChainAsync(), { valid: true });
    assert.deepEqual(ledger.verifyChain(), { valid: true });
  });

  for (const [name, tamper] of [
    ["modified content (stale content hash)", (db: DatabaseSync) => db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 3`).run(JSON.stringify({ i: 999 }))],
    ["broken prevHash link", (db: DatabaseSync) => db.prepare(`UPDATE ledger_entries SET prev_hash = ? WHERE seq = 3`).run("00".repeat(32))],
    ["forged signature", (db: DatabaseSync) => db.prepare(`UPDATE ledger_entries SET signature = ? WHERE seq = 3`).run("ab".repeat(64))],
    ["a deleted middle entry", (db: DatabaseSync) => db.prepare(`DELETE FROM ledger_entries WHERE seq = 3`).run()],
  ] as const) {
    test(`tamper mode "${name}": async reports exactly what the synchronous check reports, at the same seq`, async () => {
      const { db, ledger } = setup(450);
      tamper(db);
      const sync = ledger.verifyChain();
      const viaAsync = await ledger.verifyChainAsync();
      assert.equal(sync.valid, false);
      assert.deepEqual(viaAsync, sync);
    });
  }

  test("tampering deep inside a LATER batch is found (not just in the first one)", async () => {
    const { db, ledger } = setup(450);
    db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 420`).run(JSON.stringify({ i: -1 }));
    const result = await ledger.verifyChainAsync();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 420);
  });
});

describe("verifyChainAsync — cooperative and single-flight", () => {
  test("it yields to the event loop during a pass (other callbacks run), unlike the synchronous pass", async () => {
    const { ledger } = setup(1000); // 5 batches
    const immediate = (): Promise<void> => new Promise((r) => setImmediate(r));
    let interleaved = 0;
    let running = true;
    void (async () => {
      while (running) {
        await immediate();
        interleaved++;
      }
    })();
    await ledger.verifyChainAsync();
    running = false;
    assert.ok(interleaved >= 4, `other work interleaved ${interleaved} times during an async pass over 5 batches`);

    // The synchronous pass, in contrast, lets nothing else run until it returns.
    const second = setup(1000);
    let during = 0;
    const t = setInterval(() => during++, 0);
    second.ledger.verifyChain();
    clearInterval(t);
    assert.equal(during, 0, "the synchronous pass blocks the event loop completely");
  });

  test("concurrent callers share ONE pass; a later call on the unchanged database is served from the memo", async () => {
    const { ledger, passes } = setup(450);
    const results = await Promise.all([ledger.verifyChainAsync(), ledger.verifyChainAsync(), ledger.verifyChainAsync(), ledger.verifyChainAsync(), ledger.verifyChainAsync()]);
    assert.ok(results.every((r) => r.valid));
    assert.equal(passes(), 1, "five concurrent callers → one full pass");
    await ledger.verifyChainAsync();
    ledger.verifyChain();
    assert.equal(passes(), 1, "memo hit afterwards, for both variants");
  });

  test("each caller gets its own copy of the result (mutating one cannot poison another or the memo)", async () => {
    const { ledger } = setup(10);
    const [a, b] = await Promise.all([ledger.verifyChainAsync(), ledger.verifyChainAsync()]);
    a.valid = false;
    assert.equal(b.valid, true);
    assert.equal((await ledger.verifyChainAsync()).valid, true);
  });
});

describe("verifyChainAsync — the memo never hides a later modification", () => {
  test("an UPDATE after a verified async pass is detected on the very next async call", async () => {
    const { db, ledger } = setup(450);
    assert.equal((await ledger.verifyChainAsync()).valid, true);
    db.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 5`).run(JSON.stringify({ i: 1234 }));
    const result = await ledger.verifyChainAsync();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 5);
  });

  test("a write that lands MID-pass is not lost: the pass reports its snapshot, and the next call verifies again (including the new entry)", async () => {
    const { ledger, passes } = setup(1000);
    const pending = ledger.verifyChainAsync();
    ledger.append({ kind: "decision", agentId: "a", principalId: "p", data: { late: true } }); // lands while the first batches are still being checked
    assert.deepEqual(await pending, { valid: true });
    assert.deepEqual(await ledger.verifyChainAsync(), { valid: true });
    assert.equal(passes(), 2, "the write invalidated the memo recorded for the pre-write snapshot");
  });

  test("an out-of-band tamper from a SEPARATE connection to a file database is detected by the async path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aegis-async-verify-"));
    const file = path.join(dir, "l.db");
    const { db, ledger } = setup(30, file); // file-backed inserts fsync; 30 rows is plenty for a separate-connection tamper
    try {
      assert.equal((await ledger.verifyChainAsync()).valid, true);
      const other = new DatabaseSync(file);
      other.prepare(`UPDATE ledger_entries SET data_json = ? WHERE seq = 7`).run(JSON.stringify({ i: 31337 }));
      other.close();
      const result = await ledger.verifyChainAsync();
      assert.equal(result.valid, false);
      assert.equal(result.brokenAtSeq, 7);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry whose hashes are internally consistent but whose signature is from a DIFFERENT key is caught by the async path", async () => {
    const { db, ledger } = setup(450);
    const intruder = generateLedgerKeyPair();
    const row = db.prepare(`SELECT content_hash FROM ledger_entries WHERE seq = 300`).get() as { content_hash: string };
    db.prepare(`UPDATE ledger_entries SET signature = ? WHERE seq = 300`).run(sign(intruder.privateKey, row.content_hash));
    const result = await ledger.verifyChainAsync();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 300);
    assert.match(result.reason ?? "", /signature verification failed/);
  });
});
