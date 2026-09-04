import express, { type Express } from "express";
import { generateRootKeyPair } from "../capability/index.js";
import { createRailRegistry, type RailAdapter } from "../rails/types.js";
import { openDatabase } from "../state/db.js";
import { createAgentStore } from "../state/agents.js";
import { createMissionStore } from "../state/missions.js";
import { createPrincipalStore } from "../state/principals.js";
import { createLedgerStore, createSqliteRevocationStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../state/index.js";
import { wrapWithNotifications } from "./notifyingLedger.js";
import { createSqliteIdempotencyCache } from "./idempotency.js";
import { createSqliteMissionReservationStore } from "../mission/reservation.js";
import { createInMemorySimulationCache } from "../decision/simulationCache.js";
import { createDemoIntentJudge } from "./demoMode.js";
import { createDemoTamperRouter } from "./demoTamper.js";
import { errorHandler } from "./errors.js";
import { createApp } from "./server.js";
import type { PrincipalStore } from "../state/principals.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * The Security Demonstration Lab: a completely separate, isolated copy of the exact
 * same, entirely unmodified production pipeline (createApp, decideTransaction,
 * executeTransaction, mission reservation, the hash-chained ledger) — never the
 * production `db`/`principals`/`agents`/`missions`/`ledger` constructed in main.ts, and
 * never sharing a row with them. This is what lets the concurrent-budget-attack,
 * revocation, and ledger-tamper demonstrations run genuinely — against the real code,
 * not a mock — from ANY server mode (AEGIS_DEMO_MODE true or false), without ever
 * writing a synthetic transaction into real production evidence.
 *
 * What IS shared with production, deliberately: the mock_x402 rail adapter and its
 * already-running mock merchant (see main.ts) — reused as-is, because a mock merchant
 * that never moves real money is exactly as safe to share as it is to duplicate, and
 * duplicating it would mean running a second fake HTTP server for no safety benefit.
 * The `knownPayers` map is shared too so a lab-created agent's mock payer key is
 * registered with that same merchant and lab transactions can genuinely settle.
 *
 * What is NEVER shared: identity (fresh root/ledger keypairs every time this is
 * built), storage (a fresh, private `:memory:` SQLite database every time), and the
 * intent judge — the lab always uses the deterministic demo stand-in
 * (createDemoIntentJudge), regardless of what the real server is configured to use,
 * so a lab session never depends on, or spends quota against, a real AI provider, and
 * so its Decision Inspector never claims to be Gemini or Anthropic when it isn't.
 */

export interface SecurityLab {
  app: Express;
  db: DatabaseSync;
  principals: PrincipalStore;
}

export interface SecurityLabRailOptions {
  mockX402Rail: RailAdapter;
  /** Mutated by this function as lab agents register — see the ledger listener below. Shared with main.ts's real ledger listener so both worlds' agents settle against the same mock merchant identity map. */
  knownPayers: Map<string, string>;
  /** The single demo payer identity's public key, hex-encoded — every agent (real or lab) shares it, matching the existing demo-scope simplification already documented in main.ts and rails/mockX402/client.ts. */
  demoPayerPublicKeyHex: string;
}

/**
 * Builds one fresh, fully isolated lab instance. Called once at server startup, and
 * again — replacing the previous instance entirely — every time an operator explicitly
 * resets the lab (see main.ts's POST /lab/reset). There is no partial/selective reset:
 * every lab principal, agent, mission, and ledger entry from the previous instance is
 * gone, replaced by a genuinely empty, freshly-verified isolated environment. This is
 * the ONLY reset mechanism this module offers — there is no way to "fix" a single
 * tampered entry in place, matching docs/SECURITY_MODEL.md's stance that real evidence
 * is never selectively rewritten.
 */
export function createSecurityLab(railOpts: SecurityLabRailOptions): SecurityLab {
  const db = openDatabase(":memory:");
  const principals = createPrincipalStore(db);
  const agents = createAgentStore(db);
  const missions = createMissionStore(db);
  const reservations = createSqliteMissionReservationStore(db);
  const idempotency = createSqliteIdempotencyCache(db);
  const revocationStore = createSqliteRevocationStore(db);

  const rootKeys = generateRootKeyPair();
  const ledgerKeys = generateLedgerKeyPair();
  const rawLedger = createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey));
  const ledger = wrapWithNotifications(rawLedger);

  // Mirrors main.ts's own real-ledger listener exactly: a lab agent's mock payer
  // identity must be registered with the shared mock merchant before it can settle a
  // mock_x402 transaction, exactly like a real agent's.
  ledger.events.on("entry", (entry) => {
    if (entry.kind === "agent_registered") {
      railOpts.knownPayers.set(entry.agentId, railOpts.demoPayerPublicKeyHex);
    }
  });

  const app = createApp({
    rootPrivateKey: rootKeys.privateKey,
    rootPublicKey: rootKeys.publicKey,
    principals,
    agents,
    ledger,
    revocationStore,
    intentJudge: createDemoIntentJudge(),
    rails: createRailRegistry([railOpts.mockX402Rail]),
    idempotency,
    missions,
    reservations,
    simulationCache: createInMemorySimulationCache(),
    demoMode: true, // truthful: the lab always runs the deterministic stand-in judge, never a real provider
  });

  // The lab's own tamper-demonstration route — always present (unlike the old,
  // removed real-ledger tamper route, which only ever existed behind
  // AEGIS_DEMO_MODE=true). It touches ONLY this lab's own isolated `db`, via the same
  // applyDemoLedgerTamper reused unmodified from src/api/demoTamper.ts. Mounted the
  // same way main.ts previously mounted it for the real ledger: a thin wrapper in
  // front of the real routes, since `app`'s own catch-all/error handler are already
  // the last middleware registered inside it.
  const wrapper = express();
  wrapper.use(createDemoTamperRouter(db, principals));
  wrapper.use(errorHandler);
  wrapper.use(app);

  return { app: wrapper, db, principals };
}
