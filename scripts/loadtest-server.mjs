// Child process for scripts/loadtest.mjs: the real Aegis HTTP app (createApp) over a
// FILE-backed SQLite database, with the same stores, ledger, idempotency cache, reservation
// store and mock x402 rail + local mock merchant that src/api/main.ts wires up.
//
// What differs from `npm start` (and is disclosed in docs/LOAD_TESTING.md):
//   - the intent judge is a scripted stand-in with a configurable latency (a real provider's
//     latency is network-bound and not reproducible); a purpose containing "ESCALATE" yields
//     an `ambiguous` verdict, anything else `consistent`;
//   - the behavioral baseline's rate threshold is raised so a single agent can sustain load
//     without the (correct) 5-per-minute escalation firing on every request;
//   - no sign-up / auth-failure rate limiters (they would throttle the load generator);
//   - every rail call is recorded with the ledger position at the moment it STARTED, which
//     is how the load test proves no payment began after a revocation / cancellation.
// Everything else — capability verification, mission gate, atomic reservation, decision,
// execution, escalation, ledger — is the unmodified application code from dist/.
import { generateRootKeyPair } from "../dist/capability/index.js";
import { openDatabase } from "../dist/state/db.js";
import { createAgentStore } from "../dist/state/agents.js";
import { createMissionStore } from "../dist/state/missions.js";
import { createPrincipalStore } from "../dist/state/principals.js";
import { createLedgerStore, createSqliteRevocationStore, generateLedgerKeyPair, ledgerPublicKeyToHex } from "../dist/state/index.js";
import { createRailRegistry } from "../dist/rails/types.js";
import { startMockX402Server, MockX402RailAdapter, generatePayerKeyPair, publicKeyToHex } from "../dist/rails/mockX402/index.js";
import { createApp } from "../dist/api/server.js";
import { wrapWithNotifications } from "../dist/api/notifyingLedger.js";
import { createSqliteIdempotencyCache } from "../dist/api/idempotency.js";
import { createSqliteMissionReservationStore } from "../dist/mission/reservation.js";
import { createEscalationStore } from "../dist/state/escalations.js";
import { createInMemorySimulationCache } from "../dist/decision/simulationCache.js";

const dbPath = process.env.LT_DB;
const judgeMs = Number(process.env.LT_JUDGE_MS ?? 20);
if (!dbPath) throw new Error("LT_DB is required");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = generateRootKeyPair();
const db = openDatabase(dbPath);
db.exec("PRAGMA journal_mode = WAL;"); // same file-backed store, WAL so readers are not blocked by the writer's fsync
const ledgerKeys = generateLedgerKeyPair();
const ledgerPublicKeyHex = ledgerPublicKeyToHex(ledgerKeys.publicKey);
const ledger = wrapWithNotifications(createLedgerStore(db, ledgerKeys, ledgerPublicKeyHex));

const payer = generatePayerKeyPair();
const knownPayers = new Map();
ledger.events.on("entry", (e) => {
  if (e.kind === "agent_registered") knownPayers.set(e.agentId, publicKeyToHex(payer.publicKey));
});
const merchant = await startMockX402Server({
  knownPayers,
  priceResolver: (resource) => (resource === "acme-airlines:flights" ? { amountMinorUnits: 38_000, currency: "USD" } : undefined),
});
const realRail = new MockX402RailAdapter({ baseUrl: merchant.url, privateKey: payer.privateKey });

const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM ledger_entries");
const railLog = [];
const recordingRail = {
  railId: realRail.railId,
  async execute(request) {
    railLog.push({ agentId: request.agentId, startSeq: Number(maxSeq.get().m), key: request.idempotencyKey });
    return realRail.execute(request);
  },
};

const idempotency = createSqliteIdempotencyCache(db);
const missions = createMissionStore(db);
const reservations = createSqliteMissionReservationStore(db);
const deps = {
  rootPrivateKey: root.privateKey,
  rootPublicKey: root.publicKey,
  principals: createPrincipalStore(db),
  agents: createAgentStore(db),
  ledger,
  revocationStore: createSqliteRevocationStore(db),
  intentJudge: {
    provider: "loadtest",
    async judge(input) {
      if (judgeMs > 0) await sleep(judgeMs);
      return String(input.transaction.purpose).includes("ESCALATE")
        ? { verdict: "ambiguous", rationale: "load-test scripted ambiguity" }
        : { verdict: "consistent", rationale: "load-test scripted consistency" };
    },
  },
  judgeTimeoutMs: 30_000,
  baselineWindow: { maxAgeMs: 60_000, rateThreshold: 1_000_000, minSamplesForAmountBaseline: 1_000_000, amountDeviationMultiplier: 1_000 },
  rails: createRailRegistry([recordingRail]),
  idempotency,
  missions,
  reservations,
  escalations: createEscalationStore(db),
  simulationCache: createInMemorySimulationCache(),
  idempotencyWaitTimeoutMs: 30_000,
  healthCheck: () => db.prepare("SELECT 1").get(),
};
const app = createApp(deps);
const server = app.listen(0, "127.0.0.1", () => {
  process.send({ type: "ready", port: server.address().port, ledgerPublicKeyHex, dbPath });
});

process.on("message", (msg) => {
  if (msg.type === "stats") {
    const u = process.cpuUsage();
    process.send({ type: "stats", id: msg.id, rssMb: process.memoryUsage().rss / 1048576, heapMb: process.memoryUsage().heapUsed / 1048576, cpuUserMs: u.user / 1000, cpuSystemMs: u.system / 1000 });
  } else if (msg.type === "railLog") {
    process.send({ type: "railLog", id: msg.id, calls: railLog });
  } else if (msg.type === "revokeSeq") {
    // The ledger position of an entry (kind + agent), used to order a revocation/cancellation against rail starts.
    const row = db.prepare("SELECT MAX(seq) AS s FROM ledger_entries WHERE kind = ? AND agent_id = ?").get(msg.kind, msg.agentId);
    process.send({ type: "revokeSeq", id: msg.id, seq: row.s === null ? null : Number(row.s) });
  } else if (msg.type === "shutdown") {
    // Fold the WAL into the main file so the offline exporter/verifier can read it cleanly.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
    } catch (error) {
      console.error("shutdown checkpoint failed:", error);
    }
    process.send({ type: "shutdown", id: msg.id });
    setTimeout(() => process.exit(0), 100);
  }
});
