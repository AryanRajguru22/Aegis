import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../db.js";
import { createSqliteRevocationStore } from "../revocations.js";
import { createInMemoryRevocationStore } from "../../capability/revocation.js";

describe("SqliteRevocationStore — semantic parity with the in-memory store it replaces", () => {
  test("revoke() then isRevoked() is true; a never-revoked id is false", () => {
    const store = createSqliteRevocationStore(openDatabase(":memory:"));
    assert.equal(store.isRevoked("rev-a"), false);
    store.revoke("rev-a", "test reason");
    assert.equal(store.isRevoked("rev-a"), true);
    assert.equal(store.isRevoked("rev-b"), false);
  });

  test("revoke() returns a record matching what was persisted", () => {
    const store = createSqliteRevocationStore(openDatabase(":memory:"));
    const record = store.revoke("rev-a", "emergency shutdown");
    assert.equal(record.revocationId, "rev-a");
    assert.equal(record.reason, "emergency shutdown");
    assert.ok(!Number.isNaN(new Date(record.revokedAt).getTime()));
  });

  test("findRevoked returns the first revoked id in the CALLER'S array order, not insertion order", () => {
    const store = createSqliteRevocationStore(openDatabase(":memory:"));
    // Revoke "second" before "first" — findRevoked must still respect the order of
    // the ids array it's given (ancestor-to-descendant), not revocation order,
    // exactly matching the in-memory store's loop semantics.
    store.revoke("id-second", "x");
    store.revoke("id-first", "y");

    const result = store.findRevoked(["id-first", "id-second", "id-third"]);
    assert.equal(result?.revocationId, "id-first");
  });

  test("findRevoked returns undefined when none of the given ids are revoked", () => {
    const store = createSqliteRevocationStore(openDatabase(":memory:"));
    store.revoke("unrelated", "x");
    assert.equal(store.findRevoked(["id-a", "id-b"]), undefined);
  });

  test("revoking an already-revoked id overwrites (last write wins), never throws", () => {
    const store = createSqliteRevocationStore(openDatabase(":memory:"));
    store.revoke("rev-a", "first reason");
    assert.doesNotThrow(() => store.revoke("rev-a", "second reason"));
    const record = store.findRevoked(["rev-a"]);
    assert.equal(record?.reason, "second reason");
    assert.equal(store.list().length, 1, "overwriting must not create a second row");
  });

  test("list() returns every revoked record", () => {
    const store = createSqliteRevocationStore(openDatabase(":memory:"));
    store.revoke("rev-a", "a");
    store.revoke("rev-b", "b");
    store.revoke("rev-c", "c");
    assert.deepEqual(
      store.list().map((r) => r.revocationId).sort(),
      ["rev-a", "rev-b", "rev-c"]
    );
  });

  test("behaves identically to the in-memory store for the same sequence of operations", () => {
    const sqlite = createSqliteRevocationStore(openDatabase(":memory:"));
    const memory = createInMemoryRevocationStore();

    for (const store of [sqlite, memory]) {
      store.revoke("rev-x", "first");
      store.revoke("rev-y", "only");
      store.revoke("rev-x", "overwritten");
    }

    for (const store of [sqlite, memory]) {
      assert.equal(store.isRevoked("rev-x"), true);
      assert.equal(store.isRevoked("rev-z"), false);
      assert.equal(store.findRevoked(["rev-z", "rev-y"])?.revocationId, "rev-y");
      assert.equal(store.findRevoked(["rev-x"])?.reason, "overwritten");
      assert.equal(store.list().length, 2);
    }
  });
});
