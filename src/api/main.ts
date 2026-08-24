import {
  generateRootKeyPair,
  loadRootKeyPairFromHex,
  privateKeyToHex,
} from "../capability/index.js";
import { openDatabase } from "../state/db.js";
import { createAgentStore } from "../state/agents.js";
import { createPrincipalStore } from "../state/principals.js";
import {
  createLedgerStore,
  createSqliteRevocationStore,
  generateLedgerKeyPair,
  ledgerKeyPairFromPrivateHex,
  ledgerPrivateKeyToHex,
  ledgerPublicKeyToHex,
} from "../state/index.js";
import { AnthropicIntentJudge } from "../risk/anthropicJudge.js";
import { createRailRegistry, type RailAdapter } from "../rails/types.js";
import { StripeTestRailAdapter } from "../rails/stripeTestRail.js";
import { startMockX402Server, MockX402RailAdapter, generatePayerKeyPair, publicKeyToHex } from "../rails/mockX402/index.js";
import { createApp } from "./server.js";
import { wrapWithNotifications } from "./notifyingLedger.js";
import { createSqliteIdempotencyCache } from "./idempotency.js";
import type { AppDependencies } from "./deps.js";

/**
 * The real deployment entrypoint — everything below assembles concrete
 * implementations of the same interfaces the test suites inject fakes/scripts into
 * (see src/api/__tests__/harness.ts, src/decision/__tests__, src/rails/__tests__).
 * No policy, risk, decision, execution, or ledger logic lives here — this file only
 * wires dependencies together and starts listening.
 */
async function main(): Promise<void> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    // Fail closed, not degrade: see docs/THREAT_MODEL.md §11 — a missing risk judge
    // must never silently become "skip the risk check," so this process refuses to
    // start at all rather than serve traffic without one.
    console.error("ANTHROPIC_API_KEY is required to start the Aegis server (the intent-consistency risk check needs a real judge).");
    process.exit(1);
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
  const rawLedger = createLedgerStore(db, ledgerKeys, ledgerPublicKeyToHex(ledgerKeys.publicKey));
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

  const rails: RailAdapter[] = [mockX402Rail];
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    rails.push(new StripeTestRailAdapter({ apiKey: stripeKey }));
  } else {
    console.warn("No STRIPE_SECRET_KEY set — the stripe_test rail is unavailable this run; only mock_x402 is registered.");
  }

  const deps: AppDependencies = {
    rootPrivateKey: rootKeys.privateKey,
    rootPublicKey: rootKeys.publicKey,
    principals,
    agents,
    ledger,
    revocationStore: createSqliteRevocationStore(db),
    intentJudge: new AnthropicIntentJudge({ apiKey: anthropicApiKey }),
    rails: createRailRegistry(rails),
    idempotency: createSqliteIdempotencyCache(db),
  };

  const app = createApp(deps);
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => {
    console.log(`Aegis listening on http://localhost:${port}`);
    console.log(`Dashboard: http://localhost:${port}/`);
  });
}

main().catch((error) => {
  console.error("Aegis failed to start:", error);
  process.exit(1);
});
