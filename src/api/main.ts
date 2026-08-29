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
import { isDemoModeEnabled, createServerIntentJudge, selectRailAdapters } from "./demoMode.js";
import { createDemoTamperRouter } from "./demoTamper.js";
import type { AppDependencies } from "./deps.js";

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
  if (!demoMode && !anthropicApiKey) {
    // Fail closed, not degrade: see docs/THREAT_MODEL.md §11 — a missing risk judge
    // must never silently become "skip the risk check," so this process refuses to
    // start at all rather than serve traffic without one. AEGIS_DEMO_MODE=true is the
    // only way to bypass this, and doing so is loud (see the banner below), never silent.
    console.error(
      "ANTHROPIC_API_KEY is required to start the Aegis server (the intent-consistency risk check needs a real judge), " +
        "unless AEGIS_DEMO_MODE=true is explicitly set for a local, credential-free demo run."
    );
    process.exit(1);
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
    intentJudge: createServerIntentJudge({ demoMode, anthropicApiKey }),
    rails: createRailRegistry(rails),
    idempotency,
    missions,
    reservations,
    demoMode,
  };

  const app = createApp(deps);

  // Step 13, Scenario C: the ONE demo-only route (see demoTamper.ts) cannot simply be
  // `app.use()`'d onto the app createApp() already returned — that app's own catch-all
  // 404 handler and error handler are already the LAST middleware registered inside
  // it, so anything appended afterward would never be reached (Express middleware runs
  // in registration order). Instead, when — and only when — demo mode is enabled, the
  // complete, entirely unmodified `app` is wrapped inside a tiny outer app that checks
  // the demo route FIRST and falls through to the real app, untouched, for everything
  // else. This keeps src/api/server.ts, createApp, and AppDependencies genuinely
  // unchanged — the wrapper exists solely here, and solely when demoMode is true.
  let listener = app;
  if (demoMode) {
    const wrapper = express();
    wrapper.use(createDemoTamperRouter(db, principals));
    wrapper.use(errorHandler);
    wrapper.use(app);
    listener = wrapper;
  }

  const port = Number(process.env.PORT ?? 8787);
  listener.listen(port, () => {
    console.log(`Aegis listening on http://localhost:${port}`);
    console.log(`Dashboard: http://localhost:${port}/`);
  });
}

main().catch((error) => {
  console.error("Aegis failed to start:", error);
  process.exit(1);
});
