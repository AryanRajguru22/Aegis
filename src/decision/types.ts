import type { PublicKey } from "@biscuit-auth/biscuit-wasm";
import type { RevocationStore } from "../capability/revocation.js";
import type { TransactionRequest, VerifyResult } from "../capability/types.js";
import type { LedgerStore } from "../state/ledger.js";
import type { BaselineFlag } from "../risk/types.js";
import type { IntentJudge, IntentVerdict } from "../risk/types.js";
import type { BaselineWindow } from "../risk/baseline.js";

export type FinalVerdict = "allow" | "deny" | "escalate";

/** The judge's verdict, widened with "unavailable" for when the judge throws, times out, or returns something unparseable. This is an internal decision-layer concept, not part of the IntentJudge contract itself — see decide.ts. */
export type SafeIntentVerdict = IntentVerdict | "unavailable";

export interface SafeIntentJudgment {
  verdict: SafeIntentVerdict;
  rationale: string;
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
}
