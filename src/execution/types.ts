import type { RailRegistry, RailExecutionResult } from "../rails/types.js";
import type { DecideDependencies, DecideTransactionInput, DecisionResult } from "../decision/types.js";

export interface ExecuteTransactionInput extends DecideTransactionInput {
  /** The merchant, vendor, or counterparty agent this payment is going to. Not part of capability policy (which allowlists categories/rails, not specific counterparties) — this is execution-layer-only information a rail adapter needs. */
  counterparty: string;
  /**
   * The stable key this specific attempt presents to the rail adapter. The caller
   * (src/api/routes/transactions.ts) passes its own atomically-claimed Idempotency-Key
   * scope here, so a rail with its own idempotency protection (e.g. Stripe's
   * `idempotencyKey` request option) sees the same key across what the caller
   * considers "the same logical attempt" — this is what makes rail-level idempotency
   * meaningful, rather than every call looking like a distinct new attempt. Falls back
   * to a freshly-generated key when omitted (e.g. direct callers/tests with no
   * route-level idempotency concept — see execution-core.test.ts).
   */
  idempotencyKey?: string;
}

/** Outcome of the caller-supplied last-moment check run immediately before a rail is invoked. */
export type PreExecutionGuardResult = { ok: true } | { ok: false; reason: string };

export interface ExecuteDependencies extends DecideDependencies {
  rails: RailRegistry;
  /**
   * Synchronous last-moment guard for state that can change while a transaction is
   * awaiting the (slow, network-bound) intent judge — e.g. its mission being cancelled
   * or expired, or its agent being bound to a mission. Called only after an "allow"
   * verdict and immediately before the rail adapter, with no await in between. Returning
   * `{ ok: false }` blocks the rail call. Capability revocation and expiry are NOT this
   * guard's job: executeTransaction re-verifies the capability token itself.
   */
  preExecutionGuard?: () => PreExecutionGuardResult;
}

export interface ExecuteTransactionResult {
  decision: DecisionResult;
  /** Present only when decision.verdict === "allow" and execution was attempted — see docs/SYSTEM_ARCHITECTURE.md §2: money only ever moves after an explicit allow. */
  execution?: RailExecutionResult;
}
