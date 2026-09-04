import {
  generateRootKeyPair,
  loadRootKeyPairFromHex,
  privateKeyToHex,
} from "../capability/index.js";
import { openDatabase } from "../state/db.js";
import { createAgentStore } from "../state/agents.js";
import { createMissionStore } from "../state/missions.js";
import { createPrincipalStore } from "../state/principals.js";
import {
  createLedgerStore,
  createSqliteRevocationStore,
  generateLedgerKeyPair,
  ledgerKeyPairFromPrivateHex,
  ledgerPrivateKeyToHex,
  ledgerPublicKeyToHex,
} from "../state/index.js";
import { createRailRegistry, type RailAdapter } from "../rails/types.js";
import { StripeTestRailAdapter } from "../rails/stripeTestRail.js";
import { startMockX402Server, MockX402RailAdapter, generatePayerKeyPair, publicKeyToHex } from "../rails/mockX402/index.js";
import express from "express";
import { createApp } from "./server.js";
import { errorHandler } from "./errors.js";
import { wrapWithNotifications } from "./notifyingLedger.js";
import { createSqliteIdempotencyCache } from "./idempotency.js";
import { createSqliteMissionReservationStore } from "../mission/reservation.js";
import { createInMemorySimulationCache } from "../decision/simulationCache.js";
import {
  isDemoModeEnabled,
  createServerIntentJudge,
  selectRailAdapters,
  parseExplicitJudgeTimeoutMs,
  defaultJudgeTimeoutMs,
} from "./demoMode.js";
import { GeminiIntentJudge } from "../risk/geminiJudge.js";
import { requirePrincipalAuth } from "./auth.js";
import { createSecurityLab } from "./securityLab.js";
import type { AppDependencies } from "./deps.js";
import type { IntentJudge } from "../risk/types.js";

/**
 * The real deployment entrypoint — everything below assembles concrete
 * implementations of the same interfaces the test suites inject fakes/scripts into
 * (see src/api/__tests__/harness.ts, src/decision/__tests__, src/rails/__tests__).
 * No policy, risk, decision, execution, or ledger logic lives here — this file only
 * wires dependencies together and starts listening.
 */
async function main(): Promise<void> {
  // Strictly opt-in, off by default — see src/api/demoMode.ts for the full extent of
  // what this flag changes (only which IntentJudge and which rail adapters are
  // constructed below; nothing else in the entire pipeline is aware it exists).
  const demoMode = isDemoModeEnabled();

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const riskProvider = process.env.AEGIS_RISK_PROVIDER;

  // Parsed before judge construction so a malformed value fails immediately, with its
  // own specific message — never silently ignored, never coerced. `undefined` (unset)
  // is valid here and means "use the provider-aware default computed below."
  let explicitJudgeTimeoutMs: number | undefined;
  try {
    explicitJudgeTimeoutMs = parseExplicitJudgeTimeoutMs(process.env.AEGIS_JUDGE_TIMEOUT_MS);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Fail closed, not degrade: see docs/THREAT_MODEL.md §11 — a missing/misconfigured
  // risk judge must never silently become "skip the risk check," so this process
  // refuses to start at all rather than serve traffic without one.
  // createServerIntentJudge (src/api/demoMode.ts) is the single source of truth for
  // every branch of this decision (demo mode, explicit AEGIS_RISK_PROVIDER, which
  // key(s) are present, both-present ambiguity, neither-present) — constructing the
  // real judge here, once, at startup avoids re-deriving that logic and means a
  // misconfiguration is reported with one clear message before anything else happens.
  let intentJudge: IntentJudge;
  try {
    intentJudge = createServerIntentJudge({ demoMode, anthropicApiKey, geminiApiKey, riskProvider });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // A common cause of "the key is set in .env but this still fails" is simply that
    // .env was never loaded into this process at all — npm start (see package.json)
    // passes --env-file-if-exists=.env to node specifically to load it automatically,
    // but a manually-invoked `node dist/api/main.js` without that flag will not see
    // .env's contents, only real shell-exported variables. This hint costs nothing
    // when the real cause is something else (a genuinely missing/wrong key), and
    // never repeats or logs any key value itself.
    console.error(
      'If you have a real value in ".env" but still see this, confirm this process was actually started with ' +
        '"npm start" (or another invocation that passes --env-file-if-exists=.env to node) — a bare ' +
        '"node dist/api/main.js" does not load .env on its own.'
    );
    process.exit(1);
  }

  // Provider-aware: an explicit AEGIS_JUDGE_TIMEOUT_MS always wins; otherwise Gemini
  // gets a default sized for its real observed latency (20-28s live — see
  // src/risk/__tests__/gemini-judge.live.test.ts), while demo mode and Anthropic keep
  // the original, unchanged 8-second default. Checked against the judge actually
  // constructed above (not against AEGIS_RISK_PROVIDER's raw value), so this is
  // correct whether Gemini was chosen explicitly or auto-inferred from GEMINI_API_KEY
  // alone.
  const judgeTimeoutMs = explicitJudgeTimeoutMs ?? defaultJudgeTimeoutMs(intentJudge instanceof GeminiIntentJudge);
  console.warn(
    explicitJudgeTimeoutMs !== undefined
      ? `Intent judge timeout: ${judgeTimeoutMs}ms (explicit, via AEGIS_JUDGE_TIMEOUT_MS)`
      : `Intent judge timeout: ${judgeTimeoutMs}ms (default${intentJudge instanceof GeminiIntentJudge ? " — Gemini-aware" : ""}; set AEGIS_JUDGE_TIMEOUT_MS to override)`
  );

  if (demoMode && riskProvider) {
    // A likely-unintentional combination: demo mode always wins over any explicit
    // provider choice (see createServerIntentJudge), so an operator who set
    // AEGIS_RISK_PROVIDER expecting a real judge to run would otherwise get no signal
    // at all about why the deterministic stand-in is active instead. Loud, but not a
    // failure — demo mode taking priority is correct, expected behavior.
    console.warn(
      `NOTE: AEGIS_RISK_PROVIDER="${riskProvider}" is set but has no effect — AEGIS_DEMO_MODE=true ` +
        `always takes priority over any explicit risk-provider choice.`
    );
  }

  if (demoMode) {
    const banner = "=".repeat(78);
    console.warn(banner);
    console.warn("  AEGIS — LOCAL DEMO MODE (AEGIS_DEMO_MODE=true)");
    console.warn("  Intent judge : deterministic stand-in — NOT a real AI risk evaluation");
    console.warn("  Rails        : mock_x402 ONLY — Stripe is never registered in this mode");
    console.warn("  No real money can move. This proves the SOFTWARE PIPELINE, not payment.");
    console.warn(banner);
  }

  const dbPath = process.env.AEGIS_DB_PATH ?? "./aegis.db";
  const db = openDatabase(dbPath);
  const principals = createPrincipalStore(db);
  const agents = createAgentStore(db);

  const rootPrivateKeyHex = process.env.AEGIS_ROOT_PRIVATE_KEY_HEX;
  const rootKeys = rootPrivateKeyHex ? loadRootKeyPairFromHex(rootPrivateKeyHex) : generateRootKeyPair();
  if (!rootPrivateKeyHex) {
    console.warn(
      `No AEGIS_ROOT_PRIVATE_KEY_HEX set — generated an ephemeral root key for this process only. ` +
        `Every previously-issued token will fail to verify on restart. For a persistent deployment, set ` +
        `AEGIS_ROOT_PRIVATE_KEY_HEX=${privateKeyToHex(rootKeys.privateKey)}`
    );
  }

  const ledgerPrivateKeyHex = process.env.AEGIS_LEDGER_PRIVATE_KEY_HEX;
  const ledgerKeys = ledgerPrivateKeyHex ? ledgerKeyPairFromPrivateHex(ledgerPrivateKeyHex) : generateLedgerKeyPair();
  if (!ledgerPrivateKeyHex) {
    console.warn(
      `No AEGIS_LEDGER_PRIVATE_KEY_HEX set — generated an ephemeral ledger signing key. For a persistent ` +
        `deployment, set AEGIS_LEDGER_PRIVATE_KEY_HEX=${ledgerPrivateKeyToHex(ledgerKeys.privateKey)}`
    );
  }
  const ledgerPublicKeyHex = ledgerPublicKeyToHex(ledgerKeys.publicKey);
  // Step 14: the public half is safe to print unconditionally — an Ed25519 public key
  // reveals nothing an attacker could use, and independent verification (see
  // verifier/) needs it. Never print ledgerKeys.privateKey or its hex here.
  console.warn(`Ledger PUBLIC VERIFICATION KEY (safe to share — use with the independent verifier): ${ledgerPublicKeyHex}`);
  const rawLedger = createLedgerStore(db, ledgerKeys, ledgerPublicKeyHex);
  const ledger = wrapWithNotifications(rawLedger);

  // Demo-scope simplification, consistent with the one already documented in
  // rails/mockX402/client.ts: every agent shares one demo payer identity on the mock
  // x402 rail rather than each having its own provisioned wallet key. The mock
  // merchant's payer registry is extended live, off the same ledger event stream the
  // SSE dashboard subscribes to, whenever a new agent is registered.
  const demoPayer = generatePayerKeyPair();
  const knownPayers = new Map<string, string>();
  ledger.events.on("entry", (entry) => {
    if (entry.kind === "agent_registered") {
      knownPayers.set(entry.agentId, publicKeyToHex(demoPayer.publicKey));
    }
  });
  // The mock merchant, like a real one, has a fixed price catalog per resource
  // (counterparty:category) — MockX402RailAdapter's client-side check (see
  // rails/mockX402/client.ts) requires the merchant's quote to match EXACTLY what
  // Aegis already authorized, so a demo transaction only settles on this rail when
  // its amount matches the catalog below. That's a deliberate, honest constraint,
  // not a bug: a demo transaction for an unlisted resource or a mismatched amount
  // correctly fails with a clear "quoted amount does not match" error, which is
  // itself the defense-in-depth property this rail is meant to demonstrate.
  const demoPriceCatalog = new Map<string, { amountMinorUnits: number; currency: string }>([
    ["acme-airlines:flights", { amountMinorUnits: 38_000, currency: "USD" }],
    ["acme-hotels:hotels", { amountMinorUnits: 21_000, currency: "USD" }],
    ["cloudco:software", { amountMinorUnits: 150_000, currency: "USD" }],
  ]);
  const mockX402Server = await startMockX402Server({
    knownPayers,
    priceResolver: (resource) => demoPriceCatalog.get(resource),
  });
  console.warn(
    `Mock x402 demo merchant listening at ${mockX402Server.url} — fixed price catalog: ` +
      `${Array.from(demoPriceCatalog.entries()).map(([r, p]) => `${r}=${(p.amountMinorUnits / 100).toFixed(2)} ${p.currency}`).join(", ")}`
  );
  const mockX402Rail = new MockX402RailAdapter({ baseUrl: mockX402Server.url, privateKey: demoPayer.privateKey });

  // In demo mode, STRIPE_SECRET_KEY is never even read, regardless of whether it's
  // set in the environment — "never silently substituted" and "cannot accidentally
  // use a live/test Stripe key" both mean this rail must be structurally unreachable
  // in demo mode, not just unconstructed by convention. selectRailAdapters (see
  // src/api/demoMode.ts) independently enforces the same guarantee a second time.
  let stripeAdapter: RailAdapter | undefined;
  if (!demoMode) {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      stripeAdapter = new StripeTestRailAdapter({ apiKey: stripeKey });
    } else {
      console.warn("No STRIPE_SECRET_KEY set — the stripe_test rail is unavailable this run; only mock_x402 is registered.");
    }
  } else {
    console.warn("AEGIS_DEMO_MODE is enabled — the stripe_test rail is never registered in demo mode, regardless of STRIPE_SECRET_KEY.");
  }
  const rails: RailAdapter[] = selectRailAdapters({ demoMode, mockX402Rail, stripeAdapter });

  // Ordering matters here: the idempotency cache's own constructor-time
  // reconciliation (stale "pending" -> "orphaned") must run BEFORE the mission
  // reservation store's, since the latter's crash-recovery reconciliation depends on
  // every idempotency row it might reference already being in a settled state — see
  // src/mission/reservation.ts's ordering requirement on createSqliteMissionReservationStore.
  const idempotency = createSqliteIdempotencyCache(db);
  const missions = createMissionStore(db);
  const reservations = createSqliteMissionReservationStore(db);

  const deps: AppDependencies = {
    rootPrivateKey: rootKeys.privateKey,
    rootPublicKey: rootKeys.publicKey,
    principals,
    agents,
    ledger,
    revocationStore: createSqliteRevocationStore(db),
    intentJudge,
    judgeTimeoutMs,
    rails: createRailRegistry(rails),
    idempotency,
    missions,
    reservations,
    simulationCache: createInMemorySimulationCache(),
    demoMode,
  };

  const app = createApp(deps);

  // The Security Demonstration Lab (src/api/securityLab.ts): a completely separate,
  // isolated instance of this exact same pipeline — its own db, its own principals/
  // agents/missions/ledger, always the deterministic demo intent judge — mounted at
  // /lab, ALWAYS (regardless of AEGIS_DEMO_MODE), so the concurrent-budget-attack,
  // revocation, and ledger-tamper demonstrations can run genuinely from a production
  // deployment without ever touching real production evidence. This replaces the old
  // Step-13 approach of tampering the REAL ledger directly (only ever reachable when
  // AEGIS_DEMO_MODE=true) — that route no longer exists at all, in any mode; the real
  // production ledger has no tamper route reachable over HTTP anymore.
  //
  // `lab` is reassigned wholesale — never patched in place — by POST /lab/reset,
  // which is the ONLY way any part of the lab's state ever changes outside of normal
  // API use. Mounted the same "thin wrapper in front of the real app" way the old
  // demo-only route used to be mounted (see the removed comment this replaces):
  // createApp()'s own catch-all/error handler are already the last middleware inside
  // `app`, so anything meant to be reached first has to live on an outer app.
  let lab = createSecurityLab({ mockX402Rail, knownPayers, demoPayerPublicKeyHex: publicKeyToHex(demoPayer.publicKey) });
  const requirePrincipal = requirePrincipalAuth(principals);

  const wrapper = express();
  wrapper.post("/lab/reset", requirePrincipal, (_req, res) => {
    lab = createSecurityLab({ mockX402Rail, knownPayers, demoPayerPublicKeyHex: publicKeyToHex(demoPayer.publicKey) });
    res.status(200).json({ reset: true });
  });
  wrapper.use("/lab", (req, res, next) => lab.app(req, res, next));
  wrapper.use(errorHandler);
  wrapper.use(app);
  const listener = wrapper;

  const port = Number(process.env.PORT ?? 8787);
  listener.listen(port, () => {
    console.log(`Aegis listening on http://localhost:${port}`);
    console.log(`Dashboard: http://localhost:${port}/`);
    console.log(`Security Demonstration Lab (isolated, always available): http://localhost:${port}/lab`);
  });
}

main().catch((error) => {
  console.error("Aegis failed to start:", error);
  process.exit(1);
});
