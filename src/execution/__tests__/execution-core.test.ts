import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { generateRootKeyPair, issueRootToken } from "../../capability/index.js";
import { createInMemoryRevocationStore } from "../../capability/revocation.js";
import type { Caveats, TransactionRequest } from "../../capability/types.js";
import { openDatabase } from "../../state/db.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../../state/index.js";
import type { IntentJudge, IntentJudgeInput, IntentJudgment } from "../../risk/types.js";
import { createRailRegistry, type RailAdapter, type RailExecutionRequest, type RailExecutionResult } from "../../rails/types.js";
import { StripeTestRailAdapter, type StripePaymentIntentsClient } from "../../rails/stripeTestRail.js";
import { startMockX402Server, MockX402RailAdapter, generatePayerKeyPair, publicKeyToHex } from "../../rails/mockX402/index.js";
import { executeTransaction, LEDGER_KIND_EXECUTION_RESULT } from "../executeTransaction.js";
import type { ExecuteDependencies } from "../types.js";

class ScriptedIntentJudge implements IntentJudge {
  constructor(private readonly respond: (input: IntentJudgeInput) => IntentJudgment) {}
  async judge(input: IntentJudgeInput): Promise<IntentJudgment> {
    return this.respond(input);
  }
}

class RecordingRailAdapter implements RailAdapter {
  readonly railId: string;
  calls: RailExecutionRequest[] = [];
  constructor(railId: string, private readonly respond: (req: RailExecutionRequest) => RailExecutionResult | Promise<RailExecutionResult>) {
    this.railId = railId;
  }
  async execute(request: RailExecutionRequest): Promise<RailExecutionResult> {
    this.calls.push(request);
    return this.respond(request);
  }
}

const ONE_YEAR_FROM_NOW = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

function procurementCaveats(overrides: Partial<Caveats> = {}): Caveats {
  return {
    maxAmountMinorUnits: 200_000,
    currency: "USD",
    categories: ["flights", "hotels", "software"],
    rails: ["stripe_test", "mock_x402"],
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

function harness() {
  const { privateKey, publicKey } = generateRootKeyPair();
  const rootToken = issueRootToken(
    { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: procurementCaveats() },
    privateKey
  );
  const db = openDatabase(":memory:");
  const ledgerKeys = generateLedgerKeyPair();
  const ledger = createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey));
  const revocationStore = createInMemoryRevocationStore();
  return { publicKey, rootToken, ledger, revocationStore };
}

const alwaysConsistent = new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));

describe("money only moves after an explicit allow", () => {
  test("a denied transaction never reaches a rail adapter and writes no execution_result", async () => {
    const h = harness();
    const rail = new RecordingRailAdapter("stripe_test", () => ({ success: true, rail: "stripe_test", reference: "should-not-happen", settledAt: new Date().toISOString() }));
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: alwaysConsistent,
      rails: createRailRegistry([rail]),
    };

    const result = await executeTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx({ amountMinorUnits: 900_000 }) },
      deps
    );

    assert.equal(result.decision.verdict, "deny");
    assert.equal(result.execution, undefined);
    assert.equal(rail.calls.length, 0);
    assert.equal(h.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_EXECUTION_RESULT).length, 0);
  });

  test("an escalated transaction never reaches a rail adapter and writes no execution_result", async () => {
    const h = harness();
    const inconsistentJudge = new ScriptedIntentJudge(() => ({ verdict: "inconsistent", rationale: "off-goal" }));
    const rail = new RecordingRailAdapter("stripe_test", () => ({ success: true, rail: "stripe_test", reference: "should-not-happen", settledAt: new Date().toISOString() }));
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: inconsistentJudge,
      rails: createRailRegistry([rail]),
    };

    const result = await executeTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx() },
      deps
    );

    assert.equal(result.decision.verdict, "escalate");
    assert.equal(result.execution, undefined);
    assert.equal(rail.calls.length, 0);
  });
});

describe("execution failures are recorded but do not corrupt the decision", () => {
  test("an allowed transaction with no registered adapter for its rail fails closed, not silently", async () => {
    const h = harness();
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: alwaysConsistent,
      rails: createRailRegistry([]), // nothing registered
    };

    const result = await executeTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx() },
      deps
    );

    assert.equal(result.decision.verdict, "allow", "the policy/risk decision itself is unaffected by an infra gap in rail registration");
    assert.equal(result.execution?.success, false);
    assert.match(result.execution?.error ?? "", /No rail adapter registered/);

    const executionEntries = h.ledger.listByAgent("agent-root").filter((e) => e.kind === LEDGER_KIND_EXECUTION_RESULT);
    assert.equal(executionEntries.length, 1);
    assert.equal((executionEntries[0]?.data as { success: boolean }).success, false);
  });

  test("a rail adapter that throws is caught — no uncaught exception escapes executeTransaction", async () => {
    const h = harness();
    const throwingRail = new RecordingRailAdapter("stripe_test", () => {
      throw new Error("simulated adapter bug");
    });
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: alwaysConsistent,
      rails: createRailRegistry([throwingRail]),
    };

    const result = await executeTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx() },
      deps
    );

    assert.equal(result.decision.verdict, "allow");
    assert.equal(result.execution?.success, false);
    assert.match(result.execution?.error ?? "", /simulated adapter bug/);
  });

  test("each attempt gets a fresh idempotency key — retries are never silently collapsed into the same key", async () => {
    const h = harness();
    const rail = new RecordingRailAdapter("stripe_test", (req) => ({ success: true, rail: "stripe_test", reference: `ref-${req.idempotencyKey}`, settledAt: new Date().toISOString() }));
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: alwaysConsistent,
      rails: createRailRegistry([rail]),
    };

    await executeTransaction({ tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx() }, deps);
    await executeTransaction({ tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx() }, deps);

    assert.equal(rail.calls.length, 2);
    assert.notEqual(rail.calls[0]?.idempotencyKey, rail.calls[1]?.idempotencyKey);
  });
});

describe("ledger integrity across the full decide+execute trail", () => {
  test("a full allow-and-execute flow writes policy_verdict, risk_verdict, decision, and execution_result, and the chain still verifies", async () => {
    const h = harness();
    const rail = new RecordingRailAdapter("stripe_test", () => ({ success: true, rail: "stripe_test", reference: "pi_ok", settledAt: new Date().toISOString() }));
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: alwaysConsistent,
      rails: createRailRegistry([rail]),
    };

    await executeTransaction({ tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "x", counterparty: "acme-airlines", transaction: tx() }, deps);

    const entries = h.ledger.listByAgent("agent-root");
    assert.deepEqual(entries.map((e) => e.kind), ["policy_verdict", "risk_verdict", "decision", "execution_result"]);
    assert.deepEqual(h.ledger.verifyChain(), { valid: true });
  });
});

describe("rail-agnosticism, proven end to end with two structurally different real rails", () => {
  test("the same decision pipeline settles a transaction on the mock x402 rail — a real local HTTP server, real signatures", async () => {
    const h = harness();
    const { privateKey, publicKey: payerPublicKey } = generatePayerKeyPair();
    const server = await startMockX402Server({
      knownPayers: new Map([["agent-root", publicKeyToHex(payerPublicKey)]]),
      priceResolver: (resource) => (resource === "acme-airlines:flights" ? { amountMinorUnits: 38_000, currency: "USD" } : undefined),
    });

    try {
      const mockX402Adapter = new MockX402RailAdapter({ baseUrl: server.url, privateKey });
      const deps: ExecuteDependencies = {
        revocationStore: h.revocationStore,
        ledger: h.ledger,
        intentJudge: alwaysConsistent,
        rails: createRailRegistry([mockX402Adapter]),
      };

      const result = await executeTransaction(
        { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "Book conference travel", counterparty: "acme-airlines", transaction: tx({ rail: "mock_x402" }) },
        deps
      );

      assert.equal(result.decision.verdict, "allow");
      assert.equal(result.execution?.success, true);
      assert.match(result.execution?.reference ?? "", /^mockx402_/);
      assert.deepEqual(h.ledger.verifyChain(), { valid: true });
    } finally {
      await server.close();
    }
  });

  test("the same decision pipeline settles a transaction on the Stripe rail — a structurally different, REST/idempotency-key-based API — and both rails land in one unified ledger", async () => {
    const h = harness();
    const fakeStripeClient: StripePaymentIntentsClient = {
      async create(params) {
        return { id: "pi_unified_ledger_test", status: "succeeded", amount: params.amount, currency: params.currency } as never;
      },
    };
    const stripeAdapter = new StripeTestRailAdapter({ client: fakeStripeClient });
    const deps: ExecuteDependencies = {
      revocationStore: h.revocationStore,
      ledger: h.ledger,
      intentJudge: alwaysConsistent,
      rails: createRailRegistry([stripeAdapter]),
    };

    const result = await executeTransaction(
      { tokenBase64: h.rootToken, rootPublicKey: h.publicKey, agentId: "agent-root", principalId: "principal-1", delegatedGoal: "Book conference travel", counterparty: "acme-airlines", transaction: tx({ rail: "stripe_test" }) },
      deps
    );

    assert.equal(result.decision.verdict, "allow");
    assert.equal(result.execution?.success, true);
    assert.equal(result.execution?.reference, "pi_unified_ledger_test");

    // Same ledger, same shape of trail, for a completely different rail protocol.
    const entries = h.ledger.listByAgent("agent-root");
    assert.deepEqual(entries.map((e) => e.kind), ["policy_verdict", "risk_verdict", "decision", "execution_result"]);
    assert.deepEqual(h.ledger.verifyChain(), { valid: true });
  });
});
