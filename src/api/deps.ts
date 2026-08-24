import type { PrivateKey, PublicKey } from "@biscuit-auth/biscuit-wasm";
import type { RevocationStore } from "../capability/revocation.js";
import type { AgentStore } from "../state/agents.js";
import type { PrincipalStore } from "../state/principals.js";
import type { IntentJudge } from "../risk/types.js";
import type { BaselineWindow } from "../risk/baseline.js";
import type { RailRegistry } from "../rails/types.js";
import type { NotifyingLedgerStore } from "./notifyingLedger.js";
import type { IdempotencyCache } from "./idempotency.js";

/** Everything the API layer needs, all injected — the same dependency-injection shape used by src/decision and src/execution, so the app can be constructed once with real dependencies (src/api/main.ts, not built in this step) or with scripted/fake ones for tests (see __tests__), without the routes themselves changing. */
export interface AppDependencies {
  rootPrivateKey: PrivateKey;
  rootPublicKey: PublicKey;
  principals: PrincipalStore;
  agents: AgentStore;
  ledger: NotifyingLedgerStore;
  revocationStore: RevocationStore;
  intentJudge: IntentJudge;
  rails: RailRegistry;
  idempotency: IdempotencyCache;
  baselineWindow?: BaselineWindow;
  judgeTimeoutMs?: number;
  /** How often a concurrent request waiting on an in-flight idempotency claim re-checks its status. See routes/transactions.ts. Defaults to 25ms. */
  idempotencyPollIntervalMs?: number;
  /** How long a waiting request will poll before giving up with a 409. Defaults to 15000ms — generous enough to cover a real intent-judge call plus rail execution. */
  idempotencyWaitTimeoutMs?: number;
}
