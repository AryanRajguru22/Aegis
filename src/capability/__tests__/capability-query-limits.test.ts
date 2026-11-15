import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AuthorizerBuilder, Biscuit, KeyPair, Rule, SignatureAlgorithm } from "@biscuit-auth/biscuit-wasm";

import { AUTHORIZE_LIMITS, ensureWasmReady, queryWithAuthorizeLimits } from "../wasm.js";

/**
 * Regression coverage for a flaky test (extractRootFacts under CPU load) whose root cause
 * was `Authorizer.query()` running with the engine's built-in ~1ms run limit instead of
 * the explicit AUTHORIZE_LIMITS. Reproduction before the fix: 5 failures in 160 runs of the
 * capability suite with 8 parallel workers, always `{ RunLimit: 'Timeout' }` after ~10ms.
 */
describe("authorizer queries use the explicit run limits, never the engine's ~1ms default", () => {
  test("queryWithAuthorizeLimits forwards AUTHORIZE_LIMITS to queryWithLimits and never calls the limit-less query()", () => {
    let seenLimits: unknown;
    let plainQueryCalled = false;
    const fake = {
      queryWithLimits(_rule: Rule, limits: unknown) {
        seenLimits = limits;
        return [];
      },
      query() {
        plainQueryCalled = true;
        return [];
      },
    };
    queryWithAuthorizeLimits(fake as never, undefined as never);
    assert.deepEqual(seenLimits, AUTHORIZE_LIMITS);
    assert.equal(plainQueryCalled, false);
    assert.ok(AUTHORIZE_LIMITS.max_time_micro >= 1_000_000, "the explicit wall-clock budget is generous (>= 1s), unlike the ~1ms default");
  });

  test("queryWithAuthorizeLimits returns the real facts from an authorizer evaluated under AUTHORIZE_LIMITS", () => {
    ensureWasmReady();
    const token = Biscuit.builder().build(new KeyPair(SignatureAlgorithm.Ed25519).getPrivateKey());
    const b = new AuthorizerBuilder();
    b.addCode(`ok(1); allow if ok(1);`);
    const authorizer = b.buildAuthenticated(token);
    authorizer.authorizeWithLimits(AUTHORIZE_LIMITS);
    const rows = queryWithAuthorizeLimits(authorizer, Rule.fromString(`out($x) <- ok($x)`));
    assert.equal(rows.length, 1);
  });
});
