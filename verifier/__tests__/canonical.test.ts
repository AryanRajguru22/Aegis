import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalContent, sha256Hex, publicKeyFromHex, verifySignature, stableStringify } from "../canonical.js";
import { GOLDEN_CASES, GOLDEN_PUBLIC_KEY_HEX } from "./fixtures.js";

/**
 * Proves verifier/canonical.ts's independent reimplementation of the canonicalization
 * algorithm agrees, byte-for-byte, with real values produced once by Aegis's actual
 * production code (src/state/crypto.ts) — see fixtures.ts's doc comment. This is the
 * prerequisite for trusting anything else the verifier reports: if this file's logic
 * ever silently diverged from production, every genuinely valid ledger would be
 * misreported as tampered.
 */
describe("verifier/canonical.ts agrees with real production-generated golden fixtures", () => {
  for (const golden of GOLDEN_CASES) {
    test(`content hash matches production for case "${golden.name}"`, () => {
      const content = canonicalContent({
        kind: golden.kind,
        agentId: golden.agentId,
        principalId: golden.principalId,
        data: golden.data,
        createdAt: golden.createdAt,
        prevHash: golden.prevHash,
      });
      assert.equal(sha256Hex(content), golden.contentHash);
    });

    test(`signature verifies against the golden public key for case "${golden.name}"`, () => {
      const publicKey = publicKeyFromHex(GOLDEN_PUBLIC_KEY_HEX);
      assert.equal(verifySignature(publicKey, golden.contentHash, golden.signature), true);
    });
  }

  test("recursively sorted object keys: two logically-identical objects with different insertion order produce the IDENTICAL hash", () => {
    const simple = GOLDEN_CASES.find((c) => c.name === "simple_primitives")!;
    const unsorted = GOLDEN_CASES.find((c) => c.name === "unsorted_keys_must_canonicalize_same")!;
    assert.equal(simple.contentHash, unsorted.contentHash, "key order must not affect the canonical hash");
    assert.deepEqual(Object.keys(simple.data as object).sort(), Object.keys(unsorted.data as object).sort());
    assert.notDeepEqual(Object.keys(simple.data as object), Object.keys(unsorted.data as object), "sanity check: the two fixtures really do use different key insertion order");
  });

  test("a single-bit change to any field changes the hash (sensitivity, not just presence, of every field)", () => {
    const base = GOLDEN_CASES[0]!;
    const mutations: Array<[string, Partial<Parameters<typeof canonicalContent>[0]>]> = [
      ["kind", { kind: `${base.kind}x` }],
      ["agentId", { agentId: `${base.agentId}x` }],
      ["principalId", { principalId: `${base.principalId}x` }],
      ["createdAt", { createdAt: `${base.createdAt}x` }],
      ["prevHash", { prevHash: `${base.prevHash}x` }],
    ];
    for (const [label, override] of mutations) {
      const mutated = canonicalContent({
        kind: base.kind,
        agentId: base.agentId,
        principalId: base.principalId,
        data: base.data,
        createdAt: base.createdAt,
        prevHash: base.prevHash,
        ...override,
      });
      assert.notEqual(sha256Hex(mutated), base.contentHash, `mutating "${label}" must change the hash`);
    }
  });

  test("a wrong public key fails signature verification even on an untouched, correctly-hashed entry", () => {
    const golden = GOLDEN_CASES[0]!;
    // A different, real, unrelated Ed25519 SPKI-DER-hex public key (independently
    // generated, structurally valid — just not the signer of this entry).
    const wrongKeyHex =
      "302a300506032b6570032100be85ce1a4777fbb2ceef47cacf572c22dd49172af18783bdc4652dbb6b384b6d";
    const wrongKey = publicKeyFromHex(wrongKeyHex);
    assert.equal(verifySignature(wrongKey, golden.contentHash, golden.signature), false);
  });

  test("verifySignature fails closed (returns false, never throws) on a malformed signature hex", () => {
    const publicKey = publicKeyFromHex(GOLDEN_PUBLIC_KEY_HEX);
    assert.equal(verifySignature(publicKey, "somehash", "not-valid-hex!!"), false);
    assert.equal(verifySignature(publicKey, "somehash", ""), false);
  });
});

describe("stableStringify — undefined handling matches JSON.stringify exactly (Step 22 regression)", () => {
  // Mirrors src/state/__tests__/state-core.test.ts's identical regression suite for
  // production's stableStringify — this file's copy is a SEPARATE, independent
  // reimplementation (never imports src/state/crypto.ts), so it needs its own,
  // equally explicit coverage. Before this fix, a legitimate mission_pipeline_outcome
  // entry (execution/risk genuinely absent for non-"allow"/policy-denied outcomes —
  // see src/mission/ledger.ts's MissionPipelineOutcomeData) would be misreported by
  // this verifier as tampered on every reload, even though nothing was altered.

  test("1. an object with an explicit `key: undefined` property serializes identically to JSON.stringify (the key is omitted)", () => {
    const obj = { a: 1, execution: undefined, b: 2 };
    assert.deepEqual(JSON.parse(stableStringify(obj)), JSON.parse(JSON.stringify(obj)));
    assert.equal(stableStringify(obj), '{"a":1,"b":2}');
  });

  test("2. a nested undefined property (inside a nested object, and inside a nested array) matches JSON.stringify at every level", () => {
    const obj = { outer: { inner: undefined, kept: 1 }, list: [1, undefined, 3], top: undefined };
    // stableStringify sorts keys; JSON.stringify preserves insertion order — compare
    // parsed values (key SET + value equivalence), not raw strings.
    assert.deepEqual(JSON.parse(stableStringify(obj)), JSON.parse(JSON.stringify(obj)));
  });

  test("an array containing an undefined element substitutes null, matching JSON.stringify (not an empty hole)", () => {
    const arr = [1, undefined, 3];
    assert.equal(stableStringify(arr), JSON.stringify(arr));
    assert.equal(stableStringify(arr), "[1,null,3]");
  });
});
