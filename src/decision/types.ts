import type { PublicKey } from "@biscuit-auth/biscuit-wasm";
import type { RevocationStore } from "../capability/revocation.js";
import type { TransactionRequest, VerifyResult } from "../capability/types.js";
import type { LedgerStore } from "../state/ledger.js";
import type { BaselineFlag, JudgeFailureCategory } from "../risk/types.js";
import type { IntentJudge, IntentVerdict } from "../risk/types.js";
import type { BaselineWindow } from "../risk/baseline.js";

export type FinalVerdict = "allow" | "deny" | "escalate";

/** The judge's verdict, widened with "unavailable" for when the judge throws, times out, or returns something unparseable. This is an internal decision-layer concept, not part of the IntentJudge contract itself — see decide.ts. */
export type SafeIntentVerdict = IntentVerdict | "unavailable";

export interface SafeIntentJudgment {
  verdict: SafeIntentVerdict;
  rationale: string;
  /** Present only when verdict is "unavailable" — see decide.ts's classifyJudgeFailure. A closed, safe-to-expose category; never a raw provider error shape. */
  category?: JudgeFailureCategory;
  /** True when this judgment was reused from a matching, still-fresh Simulate result rather than freshly computed — see src/decision/simulationCache.ts. Never present (or false) for a freshly-computed judgment. Purely informational: reuse never changes verdict/rationale semantics, and deterministic policy/mission checks always run fresh regardless of this flag. */
  reused?: boolean;
  /** Truthful provenance — which judge produced (or was attempted for) this judgment, read directly off the configured IntentJudge instance by safeJudge(). "demo" | "anthropic" | "gemini" for the three real implementations; absent for a bare test double that never set IntentJudge.provider. Present on BOTH success and "unavailable" results, since provenance is known before the call is even attempted. Carried forward unchanged on reuse (see decide.ts's decideTransaction), so a reused judgment still honestly names its original provider. */
  provider?: string;
  model?: string;
}

export interface RiskAssessment {
  intentJudgment: SafeIntentJudgment;
  baselineFlags: BaselineFlag[];
}

export interface DecisionResult {
  verdict: FinalVerdict;
  reason: string;
  policy: VerifyResult;
  /** Absent when policy already denied — the risk engine never runs on a policy-denied transaction (see decide.ts). */
  risk?: RiskAssessment;
}

export interface DecideTransactionInput {
  tokenBase64: string;
  rootPublicKey: PublicKey;
  agentId: string;
  principalId: string;
  delegatedGoal: string;
  transaction: TransactionRequest & { purpose: string };
}

export interface DecideDependencies {
  revocationStore: RevocationStore;
  ledger: LedgerStore;
  intentJudge: IntentJudge;
  baselineWindow?: BaselineWindow;
  /** Milliseconds before the intent judge is treated as unavailable. Defaults to 8000. */
  judgeTimeoutMs?: number;
  /**
   * When supplied by the caller (src/api/routes/transactions.ts, only after it has
   * independently verified — via computeSimulationFingerprint — that this is a valid,
   * still-fresh, exactly-matching prior Simulate result), decideTransaction uses this
   * instead of calling the real intent judge again. decideTransaction itself has no
   * fingerprinting/caching logic and does not decide whether reuse is appropriate — it
   * only decides whether to skip an already-validated, pre-supplied judgment. The
   * capability/policy check and the behavioral-baseline check are NEVER skipped or
   * affected by this — they run exactly as they would with no cache involved at all,
   * before this is even consulted (policy) or unconditionally regardless of it
   * (baseline). See src/decision/simulationCache.ts for the fingerprinting design.
   */
  cachedIntentJudgment?: SafeIntentJudgment;
}
