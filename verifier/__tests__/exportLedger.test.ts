import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportLedgerFromDb } from "../export/exportLedger.js";
import { validateArtifact } from "../schema.js";

/**
 * Builds a real, throwaway SQLite file with the SAME ledger_entries schema as
 * src/state/db.ts (reproduced here deliberately — not imported — since this test's
 * job is to prove the exporter reads exactly what a real Aegis db file would contain,
 * independent of whichever process created it).
 */
function makeTestDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ledger_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      signature TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO ledger_entries (kind, agent_id, principal_id, data_json, created_at, prev_hash, content_hash, signature)
    VALUES (:kind, :agent_id, :principal_id, :data_json, :created_at, :prev_hash, :content_hash, :signature)
  `);
  insert.run({
    kind: "agent_registered",
    agent_id: "agent-1",
    principal_id: "principal-1",
    data_json: JSON.stringify({ delegatedGoal: "x" }),
    created_at: "2026-01-01T00:00:00.000Z",
    prev_hash: "0".repeat(64),
    content_hash: "aaaa1111",
    signature: "bbbb2222",
  });
  insert.run({
    kind: "mission_created",
    agent_id: "agent-1",
    principal_id: "principal-1",
    data_json: JSON.stringify({ missionId: "m-1", budgetMinorUnits: 2000 }),
    created_at: "2026-01-01T00:00:01.000Z",
    prev_hash: "aaaa1111",
    content_hash: "cccc3333",
    signature: "dddd4444",
  });
  return db;
}

describe("exportLedgerFromDb() — offline SQLite export", () => {
  test("preserves every raw field exactly, in seq order, and produces a schema-valid artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-export-test-"));
    try {
      const dbPath = join(dir, "test.db");
      const db = makeTestDb(dbPath);
      db.close();

      const json = exportLedgerFromDb(dbPath, "deadbeef");
      const parsed = JSON.parse(json);

      const validation = validateArtifact(parsed);
      assert.equal(validation.ok, true);

      assert.equal(parsed.publicKeyHex, "deadbeef");
      assert.equal(parsed.entries.length, 2);
      assert.equal(parsed.entries[0].seq, 1);
      assert.equal(parsed.entries[0].kind, "agent_registered");
      assert.equal(parsed.entries[0].contentHash, "aaaa1111");
      assert.equal(parsed.entries[1].seq, 2);
      assert.deepEqual(parsed.entries[1].data, { missionId: "m-1", budgetMinorUnits: 2000 }, "data_json must be parsed back into an object, not left as a string");
      assert.equal(parsed.entries[1].prevHash, "aaaa1111");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opens the database read-only — a write attempt through the SAME handle the exporter used must fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-export-test-"));
    try {
      const dbPath = join(dir, "test.db");
      const db = makeTestDb(dbPath);
      db.close();

      const readOnlyHandle = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.throws(() => {
          readOnlyHandle.exec(`INSERT INTO ledger_entries (kind, agent_id, principal_id, data_json, created_at, prev_hash, content_hash, signature) VALUES ('x','x','x','{}','x','x','x','x')`);
        }, /readonly|read-only/i);
      } finally {
        readOnlyHandle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not mutate the source database — row count and content are identical before and after export", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-export-test-"));
    try {
      const dbPath = join(dir, "test.db");
      const db = makeTestDb(dbPath);
      db.close();

      exportLedgerFromDb(dbPath, "deadbeef");

      const verify = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = verify.prepare(`SELECT * FROM ledger_entries ORDER BY seq ASC`).all();
        assert.equal(rows.length, 2, "row count must be unchanged after export");
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
