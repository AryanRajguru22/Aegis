import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { generateRootKeyPair, issueRootToken } from "../../capability/index.js";
import { createInMemoryRevocationStore } from "../../capability/revocation.js";
import type { Caveats, TransactionRequest } from "../../capability/types.js";
import { openDatabase } from "../../state/db.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../../state/index.js";
import type { IntentJudge, IntentJudgeInput, IntentJudgment } from "../../risk/types.js";
import { decideTransaction } from "../decide.js";
import type { DecideDependencies } from "../types.js";
import { computeSimulationFingerprint, createInMemorySimulationCache, type SimulationFingerprintInput } from "../simulationCache.js";

/**
 * Covers the Simulate -> Execute intent-judgment reuse feature end to end at the
 * decision layer: fingerprint stability/invalidation (the rules that decide whether a
 * cache lookup in routes/transactions.ts can ever hit), the cache's own TTL/single-use
 * semantics, and decideTransaction's actual behavior when handed a pre-validated
 * cachedIntentJudgment — in particular, that reuse only ever short-circuits the
 * network-dependent intent judge, never the deterministic policy check or the
 * behavioral baseline, both of which are proven here to still run exactly as if no
 * cache existed at all.
 */

class ScriptedIntentJudge implements IntentJudge {
  calls: IntentJudgeInput[] = [];
  constructor(private readonly respond: (input: IntentJudgeInput) => Promise<unknown> | unknown) {}
  async judge(input: IntentJudgeInput): Promise<IntentJudgment> {
    this.calls.push(input);
    return (await this.respond(input)) as IntentJudgment;
  }
}

const ONE_YEAR_FROM_NOW = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

function procurementCaveats(overrides: Partial<Caveats> = {}): Caveats {
  return {
    maxAmountMinorUnits: 200_000,
    currency: "USD",
    categories: ["flights", "hotels", "software"],
    rails: ["stripe_test"],
    expiresAt: ONE_YEAR_FROM_NOW,
    ...overrides,
  };
}

function tx(overrides: Partial<TransactionRequest & { purpose: string }> = {}): TransactionRequest & { purpose: string } {
  return {
    amountMinorUnits: 38_000,
    currency: "USD",
    category: "flights",
    rail: "stripe_test",
    purpose: "Round-trip flight for the Q3 vendor conference",
    ...overrides,
  };
}

function baseFingerprintInput(overrides: Partial<SimulationFingerprintInput> = {}): SimulationFingerprintInput {
  return {
    tokenBase64: "token-a",
    delegatedGoal: "Book the cheapest flights and hotels for our Q3 conferences.",
    transaction: tx(),
    counterparty: "acme-travel",
    missionId: undefined,
    ...overrides,
  };
}

function harness() {
  const { privateKey, publicKey } = generateRootKeyPair();
  const rootToken = issueRootToken(
    {
      principalId: "principal-1",
      agentId: "agent-root",
      delegatedGoal: "Book the cheapest flights and hotels for our Q3 conferences. Do not spend on anything else.",
      caveats: procurementCaveats(),
    },
    privateKey
  );
  const db = openDatabase(":memory:");
  const ledgerKeys = generateLedgerKeyPair();
  const ledger = createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey));
  const revocationStore = createInMemoryRevocationStore();
  return { publicKey, rootToken, ledger, revocationStore };
}

function deps(harnessObj: ReturnType<typeof harness>, judge: IntentJudge, overrides: Partial<DecideDependencies> = {}): DecideDependencies {
  return {
    revocationStore: harnessObj.revocationStore,
    ledger: harnessObj.ledger,
    intentJudge: judge,
    judgeTimeoutMs: 200,
    ...overrides,
  };
}

describe("computeSimulationFingerprint — invalidation rules", () => {
  test("the exact same input produces the exact same fingerprint (reuse is possible)", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput());
    assert.equal(a, b);
  });

  test("changing the amount invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput({ transaction: tx({ amountMinorUnits: 39_000 }) }));
    assert.notEqual(a, b);
  });

  test("changing the category invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput({ transaction: tx({ category: "software" }) }));
    assert.notEqual(a, b);
  });

  test("changing the counterparty invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput({ counterparty: "some-other-vendor" }));
    assert.notEqual(a, b);
  });

  test("changing the purpose invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput({ transaction: tx({ purpose: "A materially different purpose" }) }));
    assert.notEqual(a, b);
  });

  test("changing the presented capability token (agent/authority context) invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput({ tokenBase64: "token-b-different-authority" }));
    assert.notEqual(a, b, "any authority change (re-attenuation, a different token) must invalidate reuse");
  });

  test("changing the effective delegated goal (e.g. a different mission's goal) invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const b = computeSimulationFingerprint(baseFingerprintInput({ delegatedGoal: "A completely different delegated goal" }));
    assert.notEqual(a, b);
  });

  test("changing the mission id invalidates the fingerprint even when every other field matches", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput({ missionId: "mission-1" }));
    const b = computeSimulationFingerprint(baseFingerprintInput({ missionId: "mission-2" }));
    assert.notEqual(a, b);
  });

  test("changing rail or currency invalidates the fingerprint", () => {
    const a = computeSimulationFingerprint(baseFingerprintInput());
    const railChanged = computeSimulationFingerprint(baseFingerprintInput({ transaction: tx({ rail: "mock_x402" }) }));
    const currencyChanged = computeSimulationFingerprint(baseFingerprintInput({ transaction: tx({ currency: "EUR" }) }));
    assert.notEqual(a, railChanged);
    assert.notEqual(a, currencyChanged);
  });
});

describe("createInMemorySimulationCache — TTL and single-use semantics", () => {
  test("a fresh entry is returned by the first get()", () => {
    const cache = createInMemorySimulationCache();
    const fingerprint = computeSimulationFingerprint(baseFingerprintInput());
    cache.set(fingerprint, { intentJudgment: { verdict: "consistent", rationale: "ok" }, computedAt: Date.now() });

    const hit = cache.get(fingerprint);
    assert.ok(hit);
    assert.equal(hit.intentJudgment.verdict, "consistent");
  });

  test("a cache entry is single-use — a second get() for the same fingerprint misses", () => {
    const cache = createInMemorySimulationCache();
    const fingerprint = computeSimulationFingerprint(baseFingerprintInput());
    cache.set(fingerprint, { intentJudgment: { verdict: "consistent", rationale: "ok" }, computedAt: Date.now() });

    assert.ok(cache.get(fingerprint));
    assert.equal(cache.get(fingerprint), undefined, "reuse must be consumed exactly once, never repeated across many Executes");
  });

  test("an entry older than the configured TTL is treated as a miss", () => {
    const cache = createInMemorySimulationCache({ ttlMs: 50 });
    const fingerprint = computeSimulationFingerprint(baseFingerprintInput());
    cache.set(fingerprint, { intentJudgment: { verdict: "consistent", rationale: "ok" }, computedAt: Date.now() - 1000 });

    assert.equal(cache.get(fingerprint), undefined);
  });

  test("a lookup for a fingerprint that was never set misses", () => {
    const cache = createInMemorySimulationCache();
    assert.equal(cache.get(computeSimulationFingerprint(baseFingerprintInput())), undefined);
  });
});

describe("decideTransaction with a pre-validated cachedIntentJudgment", () => {
  test("exact unchanged simulation -> execution reuse: the real intent judge is never called again", async () => {
    const h = harness();
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "should never be called during reuse" }));

    const result = await decideTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", transaction: tx() },
      deps(h, judge, { cachedIntentJudgment: { verdict: "consistent", rationale: "from the prior simulate" } })
    );

    assert.equal(judge.calls.length, 0, "a valid cache hit must skip the real network-dependent judge call entirely");
    assert.equal(result.verdict, "allow");
    assert.equal(result.risk?.intentJudgment.verdict, "consistent");
    assert.equal(result.risk?.intentJudgment.reused, true, "a reused judgment must be marked as such");
  });

  test("deterministic DENY still wins even with a previously favorable cached judgment", async () => {
    const h = harness();
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "should never be called" }));

    const result = await decideTransaction(
      {
        tokenBase64: h.rootToken,
        rootPublicKey: h.publicKey,
        agentId: "agent-root",
        principalId: "principal-1",
        delegatedGoal: "x",
        transaction: tx({ amountMinorUnits: 900_000 }), // exceeds the token's policy cap
      },
      deps(h, judge, { cachedIntentJudgment: { verdict: "consistent", rationale: "favorable, but must not matter" } })
    );

    assert.equal(result.verdict, "deny", "policy denial must never be overridden by a cached — or any — AI judgment");
    assert.equal(result.risk, undefined, "the risk stage (and therefore the cache) must never even be consulted once policy has denied");
    assert.equal(judge.calls.length, 0);
  });

  test("a fresh behavioral anomaly still escalates even when the cached intent judgment is favorable", async () => {
    const h = harness();
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "should never be called" }));
    const fastDeps = deps(h, judge, {
      cachedIntentJudgment: { verdict: "consistent", rationale: "favorable, but baseline must still run fresh" },
      baselineWindow: { maxAgeMs: 60_000, rateThreshold: 1, minSamplesForAmountBaseline: 1000, amountDeviationMultiplier: 3 },
    });

    // First call establishes baseline history using the real (non-cached) judge path
    // so the rate window has a prior entry to trip against.
    await decideTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", transaction: tx() },
      deps(h, new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" })))
    );

    const second = await decideTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", transaction: tx() },
      fastDeps
    );

    assert.equal(second.verdict, "escalate", "the behavioral baseline is always recomputed fresh regardless of a cache hit");
    assert.match(second.reason, /Behavioral anomaly/);
    assert.equal(judge.calls.length, 0, "still must not have called the real judge, even though the outcome escalated");
  });

  test("a cached 'unavailable' judgment (e.g. a quota failure during Simulate) still escalates on Execute, and still skips a second real call", async () => {
    const h = harness();
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "should never be called" }));

    const result = await decideTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", transaction: tx() },
      deps(h, judge, { cachedIntentJudgment: { verdict: "unavailable", rationale: "AI provider quota temporarily exhausted.", category: "quota" } })
    );

    assert.equal(result.verdict, "escalate");
    assert.equal(judge.calls.length, 0, "reusing a known-unavailable judgment must not trigger a second doomed call to the same failing provider");
  });

  test("with no cachedIntentJudgment supplied, the real judge is called exactly as before this feature existed", async () => {
    const h = harness();
    const judge = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "computed fresh" }));

    const result = await decideTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", transaction: tx() },
      deps(h, judge)
    );

    assert.equal(judge.calls.length, 1);
    assert.equal(result.risk?.intentJudgment.reused, undefined, "a freshly-computed judgment must never be marked reused");
  });
});
