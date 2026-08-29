import { generateRootKeyPair } from "../../capability/index.js";
import { createInMemoryRevocationStore } from "../../capability/revocation.js";
import { openDatabase } from "../../state/db.js";
import { createAgentStore } from "../../state/agents.js";
import { createMissionStore } from "../../state/missions.js";
import { createPrincipalStore } from "../../state/principals.js";
import { createLedgerStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../../state/index.js";
import { createRailRegistry, type RailAdapter, type RailExecutionRequest, type RailExecutionResult } from "../../rails/types.js";
import type { IntentJudge, IntentJudgeInput, IntentJudgment } from "../../risk/types.js";
import { createApp } from "../server.js";
import { wrapWithNotifications } from "../notifyingLedger.js";
import { createInMemoryIdempotencyCache } from "../idempotency.js";
import { createSqliteMissionReservationStore } from "../../mission/reservation.js";
import type { AppDependencies } from "../deps.js";

export class ScriptedIntentJudge implements IntentJudge {
  calls: IntentJudgeInput[] = [];
  constructor(private readonly respond: (input: IntentJudgeInput) => IntentJudgment) {}
  async judge(input: IntentJudgeInput): Promise<IntentJudgment> {
    this.calls.push(input);
    return this.respond(input);
  }
}

export class RecordingRailAdapter implements RailAdapter {
  readonly railId: string;
  calls: RailExecutionRequest[] = [];
  constructor(
    railId: string,
    private readonly respond: (req: RailExecutionRequest) => RailExecutionResult | Promise<RailExecutionResult> = (req) => ({
      success: true,
      rail: railId,
      reference: `ref-${req.idempotencyKey}`,
      settledAt: new Date().toISOString(),
    })
  ) {
    this.railId = railId;
  }
  async execute(request: RailExecutionRequest): Promise<RailExecutionResult> {
    this.calls.push(request);
    return this.respond(request);
  }
}

export const alwaysConsistentJudge = () => new ScriptedIntentJudge(() => ({ verdict: "consistent", rationale: "fine" }));

export function buildHarness(overrides: Partial<AppDependencies> = {}) {
  const { privateKey: rootPrivateKey, publicKey: rootPublicKey } = generateRootKeyPair();
  const db = openDatabase(":memory:");
  const principals = createPrincipalStore(db);
  const agents = createAgentStore(db);
  const ledgerKeys = generateLedgerKeyPair();
  const rawLedger = createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey));
  const ledger = wrapWithNotifications(rawLedger);
  const revocationStore = createInMemoryRevocationStore();
  const stripeRail = new RecordingRailAdapter("stripe_test");
  const rails = createRailRegistry([stripeRail]);
  const idempotency = createInMemoryIdempotencyCache();
  const missions = createMissionStore(db);
  const reservations = createSqliteMissionReservationStore(db);

  const deps: AppDependencies = {
    rootPrivateKey,
    rootPublicKey,
    principals,
    agents,
    ledger,
    revocationStore,
    intentJudge: alwaysConsistentJudge(),
    rails,
    idempotency,
    missions,
    reservations,
    judgeTimeoutMs: 500,
    ...overrides,
  };

  const app = createApp(deps);
  return { app, deps, stripeRail, db };
}

export function defaultCaveats(overrides: Record<string, unknown> = {}) {
  return {
    maxAmountMinorUnits: 200_000,
    currency: "USD",
    categories: ["flights", "hotels", "software"],
    rails: ["stripe_test", "mock_x402"],
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

export function defaultTransaction(overrides: Record<string, unknown> = {}) {
  return {
    amountMinorUnits: 38_000,
    currency: "USD",
    category: "flights",
    rail: "stripe_test",
    purpose: "Round-trip flight for the Q3 vendor conference",
    ...overrides,
  };
}
