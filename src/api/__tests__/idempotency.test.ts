import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../state/db.js";
import { createInMemoryIdempotencyCache, createSqliteIdempotencyCache } from "../idempotency.js";
import type { IdempotencyCache } from "../idempotency.js";

function bothImplementations(): Array<[string, () => IdempotencyCache]> {
  return [
    ["in-memory", () => createInMemoryIdempotencyCache()],
    ["sqlite", () => createSqliteIdempotencyCache(openDatabase(":memory:"))],
  ];
}

for (const [label, make] of bothImplementations()) {
  describe(`IdempotencyCache (${label}) — atomic claim/complete/release`, () => {
    test("the first tryClaim for a fresh key succeeds with 'claimed'", () => {
      const cache = make();
      assert.deepEqual(cache.tryClaim("k1", "hash-a"), { kind: "claimed" });
    });

    test("a second tryClaim for the same key+hash while still pending returns 'pending', not a second claim", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      assert.deepEqual(cache.tryClaim("k1", "hash-a"), { kind: "pending" });
    });

    test("a tryClaim for the same key with a DIFFERENT hash returns 'hash_mismatch', even while pending", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      assert.deepEqual(cache.tryClaim("k1", "hash-b"), { kind: "hash_mismatch" });
    });

    test("after complete(), tryClaim returns the cached record instead of re-claiming", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      cache.complete("k1", { requestHash: "hash-a", status: 200, body: { ok: true } });

      const outcome = cache.tryClaim("k1", "hash-a");
      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") {
        assert.deepEqual(outcome.record, { requestHash: "hash-a", status: 200, body: { ok: true } });
      }
    });

    test("hash_mismatch is still reported after completion, not just while pending", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      cache.complete("k1", { requestHash: "hash-a", status: 200, body: {} });
      assert.deepEqual(cache.tryClaim("k1", "hash-b"), { kind: "hash_mismatch" });
    });

    test("complete() throws if there is no matching pending claim (defensive — callers must claim before completing)", () => {
      const cache = make();
      assert.throws(() => cache.complete("never-claimed", { requestHash: "h", status: 200, body: {} }));
    });

    test("release() deletes a pending claim, letting a later attempt claim the key again", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      cache.release("k1");
      assert.deepEqual(cache.tryClaim("k1", "hash-a"), { kind: "claimed" }, "the key must be claimable again after release");
    });

    test("release() is a no-op on an already-completed claim — it must never un-cache a finished result", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      cache.complete("k1", { requestHash: "hash-a", status: 200, body: { done: true } });
      cache.release("k1"); // must not delete the completed record
      const outcome = cache.tryClaim("k1", "hash-a");
      assert.equal(outcome.kind, "completed");
    });

    test("release() on a never-claimed key is a harmless no-op", () => {
      const cache = make();
      assert.doesNotThrow(() => cache.release("never-claimed"));
    });

    test("keys are independent — claiming/completing one does not affect another", () => {
      const cache = make();
      cache.tryClaim("k1", "hash-a");
      cache.complete("k1", { requestHash: "hash-a", status: 200, body: { for: "k1" } });
      assert.deepEqual(cache.tryClaim("k2", "hash-b"), { kind: "claimed" }, "k2 must still be freely claimable");
    });

    test("hashRequest is deterministic and stable across repeated calls", () => {
      const cache = make();
      const body = { transaction: { amountMinorUnits: 1000 }, counterparty: "acme" };
      assert.equal(cache.hashRequest(body), cache.hashRequest(body));
    });
  });
}

describe("in-memory and sqlite implementations agree on the same sequence of operations", () => {
  test("identical claim/complete/release sequences produce identical outcomes on both backends", () => {
    const sqlite = createSqliteIdempotencyCache(openDatabase(":memory:"));
    const memory = createInMemoryIdempotencyCache();

    for (const cache of [sqlite, memory]) {
      assert.deepEqual(cache.tryClaim("k1", "h1"), { kind: "claimed" });
      assert.deepEqual(cache.tryClaim("k1", "h1"), { kind: "pending" });
      cache.complete("k1", { requestHash: "h1", status: 200, body: { x: 1 } });
      assert.deepEqual(cache.tryClaim("k1", "h1"), { kind: "completed", record: { requestHash: "h1", status: 200, body: { x: 1 } } });
      assert.deepEqual(cache.tryClaim("k1", "h2"), { kind: "hash_mismatch" });

      assert.deepEqual(cache.tryClaim("k2", "hA"), { kind: "claimed" });
      cache.release("k2");
      assert.deepEqual(cache.tryClaim("k2", "hA"), { kind: "claimed" });
    }
  });
});
