import { verifyTransaction } from "../capability/authorize.js";
import { scoreDeviation, DEFAULT_BASELINE_WINDOW } from "../risk/baseline.js";
import type { IntentJudge, IntentJudgeInput } from "../risk/types.js";
import type {
  DecideDependencies,
  DecideTransactionInput,
  DecisionResult,
  FinalVerdict,
  SafeIntentJudgment,
} from "./types.js";

export const LEDGER_KIND_POLICY_VERDICT = "policy_verdict";
export const LEDGER_KIND_RISK_VERDICT = "risk_verdict";
export const LEDGER_KIND_DECISION = "decision";

const DEFAULT_JUDGE_TIMEOUT_MS = 8000;

function isSafeIntentVerdict(value: unknown): value is "consistent" | "inconsistent" | "ambiguous" {
  return value === "consistent" || value === "inconsistent" || value === "ambiguous";
}

/**
 * Runs the intent judge with a hard timeout and validates its output shape. Any
 * failure mode — throw, rejection, timeout, or a response that doesn't match the
 * expected {verdict, rationale} shape with a recognized verdict — collapses to the
 * same "unavailable" sentinel. This is the fail-safe boundary described in
 * docs/THREAT_MODEL.md §11: a broken or slow judge must never be silently treated as
 * an implicit "consistent", and must never itself become a hard deny (which would
 * make an unrelated outage block all legitimate spend) — it degrades to escalation.
 */
export async function safeJudge(
  judge: IntentJudge,
  input: IntentJudgeInput,
  timeoutMs: number = DEFAULT_JUDGE_TIMEOUT_MS
): Promise<SafeIntentJudgment> {
  try {
    const result = await Promise.race([
      judge.judge(input),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`intent judge timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    if (result == null || typeof result !== "object") {
      return { verdict: "unavailable", rationale: "Intent judge returned a non-object result" };
    }
    if (!isSafeIntentVerdict((result as { verdict?: unknown }).verdict)) {
      return {
        verdict: "unavailable",
        rationale: `Intent judge returned an unrecognized verdict: ${JSON.stringify((result as { verdict?: unknown }).verdict)}`,
      };
    }
    const rationale = (result as { rationale?: unknown }).rationale;
    if (typeof rationale !== "string" || rationale.length === 0) {
      return { verdict: "unavailable", rationale: "Intent judge returned no rationale" };
    }
    return { verdict: result.verdict, rationale };
  } catch (error) {
    return {
      verdict: "unavailable",
      rationale: `Intent judge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Combines the two risk signals into a single verdict. Pure and synchronous on
 * purpose — every branch here is independently unit-testable without a database, a
 * token, or a network call. See src/decision/__tests__ for the adversarial cases this
 * function's ordering exists to satisfy (in particular: an "unavailable" or
 * "inconsistent" judgment always wins over a "consistent" one from a differently-cased
 * or extra baseline flag — there is no code path that lets a passing intent judgment
 * suppress a behavioral-anomaly flag, or vice versa; both must be clean for "allow").
 */
export function combineRiskSignals(
  baselineFlags: import("../risk/types.js").BaselineFlag[],
  judgment: SafeIntentJudgment
): { verdict: FinalVerdict; reason: string } {
  if (judgment.verdict === "unavailable") {
    return {
      verdict: "escalate",
      reason: `Risk judgment unavailable — escalating for human review. ${judgment.rationale}`,
    };
  }
  if (judgment.verdict === "inconsistent") {
    return {
      verdict: "escalate",
      reason: `Transaction is inconsistent with the agent's delegated goal. ${judgment.rationale}`,
    };
  }
  if (judgment.verdict === "ambiguous") {
    return {
      verdict: "escalate",
      reason: `Transaction's consistency with the agent's delegated goal is ambiguous. ${judgment.rationale}`,
    };
  }
  if (baselineFlags.length > 0) {
    return {
      verdict: "escalate",
      reason: `Behavioral anomaly detected: ${baselineFlags.map((f) => f.detail).join("; ")}`,
    };
  }
  return { verdict: "allow", reason: "Policy satisfied; consistent with delegated goal; no behavioral anomalies" };
}

/**
 * The composite policy + risk decision — the `/simulate` core described in
 * docs/SYSTEM_ARCHITECTURE.md §2 and §8. Ordering is deliberate and load-bearing:
 *
 * 1. The deterministic capability-token policy check (src/capability) runs first.
 *    It is the cheapest check and has no external dependency, so a denial short-
 *    circuits immediately — the risk engine, including the network-dependent intent
 *    judge, never runs on a transaction that was already going to be denied. This is
 *    both an efficiency property and a security one: risk assessment can only ever
 *    make a policy-approved transaction stricter (escalate), never override a policy
 *    denial into an allow.
 * 2. Only once policy allows does the risk engine run: a local, synchronous baseline
 *    check plus the (async, network-dependent, timeout-guarded) intent-consistency
 *    judge.
 * 3. Every step is written to the ledger as it happens, not just the final outcome —
 *    a human or auditor reviewing this later sees the full trail, not a summary.
 */
export async function decideTransaction(
  input: DecideTransactionInput,
  deps: DecideDependencies
): Promise<DecisionResult> {
  const policy = verifyTransaction(input.tokenBase64, input.rootPublicKey, input.transaction, deps.revocationStore);

  deps.ledger.append({
    kind: LEDGER_KIND_POLICY_VERDICT,
    agentId: input.agentId,
    principalId: input.principalId,
    data: { allowed: policy.allowed, reason: policy.reason ?? null, transaction: input.transaction },
  });

  if (!policy.allowed) {
    const result: DecisionResult = {
      verdict: "deny",
      reason: policy.reason ?? "Policy denied this transaction",
      policy,
    };
    deps.ledger.append({
      kind: LEDGER_KIND_DECISION,
      agentId: input.agentId,
      principalId: input.principalId,
      data: { verdict: result.verdict, reason: result.reason, source: "policy", transaction: input.transaction },
    });
    return result;
  }

  const history = deps.ledger
    .listByAgent(input.agentId)
    .filter((e) => e.kind === LEDGER_KIND_DECISION)
    .map((e) => {
      const tx = (e.data as { transaction?: { amountMinorUnits?: unknown } }).transaction;
      const amount = typeof tx?.amountMinorUnits === "number" ? tx.amountMinorUnits : 0;
      return { amountMinorUnits: amount, createdAt: e.createdAt };
    })
    .filter((h) => h.amountMinorUnits > 0);

  const baselineFlags = scoreDeviation(
    history,
    { amountMinorUnits: input.transaction.amountMinorUnits },
    deps.baselineWindow ?? DEFAULT_BASELINE_WINDOW
  );

  const intentJudgment = await safeJudge(
    deps.intentJudge,
    { delegatedGoal: input.delegatedGoal, transaction: input.transaction },
    deps.judgeTimeoutMs
  );

  deps.ledger.append({
    kind: LEDGER_KIND_RISK_VERDICT,
    agentId: input.agentId,
    principalId: input.principalId,
    data: { baselineFlags, intentJudgment },
  });

  const { verdict, reason } = combineRiskSignals(baselineFlags, intentJudgment);

  deps.ledger.append({
    kind: LEDGER_KIND_DECISION,
    agentId: input.agentId,
    principalId: input.principalId,
    data: { verdict, reason, source: "risk", baselineFlags, intentJudgment, transaction: input.transaction },
  });

  return { verdict, reason, policy, risk: { intentJudgment, baselineFlags } };
}
