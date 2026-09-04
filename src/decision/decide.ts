import { verifyTransaction } from "../capability/authorize.js";
import { scoreDeviation, DEFAULT_BASELINE_WINDOW } from "../risk/baseline.js";
import { ClassifiedJudgeError } from "../risk/types.js";
import type { IntentJudge, IntentJudgeInput, JudgeFailureCategory } from "../risk/types.js";
import {
  AuthenticationError as AnthropicAuthenticationError,
  RateLimitError as AnthropicRateLimitError,
  InternalServerError as AnthropicInternalServerError,
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIError as AnthropicAPIError,
} from "@anthropic-ai/sdk";
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

/** Exported so src/api/demoMode.ts's provider-aware default can reference the same
 * value for the non-Gemini case, rather than duplicating the number and risking drift. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 8000;

function isSafeIntentVerdict(value: unknown): value is "consistent" | "inconsistent" | "ambiguous" {
  return value === "consistent" || value === "inconsistent" || value === "ambiguous";
}

/**
 * Fixed, static, category-only text — deliberately never interpolates anything from
 * the actual error (no status codes, no provider message text, no URLs). This is the
 * ONLY thing that ever reaches an API caller or the dashboard for an unavailable
 * judgment; the real diagnostic detail is logged server-side only (see
 * classifyJudgeFailure's caller in safeJudge) and never returned.
 */
const SAFE_UNAVAILABLE_MESSAGES: Record<JudgeFailureCategory, string> = {
  timeout: "Risk review timed out.",
  authentication: "AI risk service authentication/configuration failure.",
  quota: "AI provider quota temporarily exhausted.",
  provider_unavailable: "AI provider temporarily unavailable.",
  malformed_response: "AI risk service returned an unexpected response.",
  unknown: "Risk judgment unavailable due to an unexpected error.",
};

/**
 * Turns any thrown/rejected value from a judge (or safeJudge's own timeout) into a
 * safe category + safe rationale, plus the full raw detail for server-side logging
 * only. Precise classification (ClassifiedJudgeError, thrown by src/risk/geminiJudge.ts)
 * is checked first; the Anthropic SDK's own typed error classes are checked next —
 * src/risk/anthropicJudge.ts itself is untouched and throws these completely
 * unmodified, so recognizing them here, structurally, gives Anthropic the same
 * category precision without changing that file at all. Anything else — a plain
 * Error from either judge, or a truly unexpected throw — safely degrades to "unknown"
 * rather than guessing.
 */
function classifyJudgeFailure(error: unknown): { category: JudgeFailureCategory; safeRationale: string; diagnosticDetail: string } {
  const diagnosticDetail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  let category: JudgeFailureCategory;
  if (error instanceof ClassifiedJudgeError) {
    category = error.category;
  } else if (error instanceof AnthropicRateLimitError) {
    category = "quota";
  } else if (error instanceof AnthropicAuthenticationError) {
    category = "authentication";
  } else if (
    error instanceof AnthropicInternalServerError ||
    error instanceof AnthropicAPIConnectionError ||
    error instanceof AnthropicAPIConnectionTimeoutError
  ) {
    category = "provider_unavailable";
  } else if (error instanceof AnthropicAPIError) {
    category = "unknown"; // some other Anthropic API-level status not specifically classified above
  } else {
    category = "unknown";
  }

  return { category, safeRationale: SAFE_UNAVAILABLE_MESSAGES[category], diagnosticDetail };
}

/**
 * Runs the intent judge with a hard timeout and validates its output shape. Any
 * failure mode — throw, rejection, timeout, or a response that doesn't match the
 * expected {verdict, rationale} shape with a recognized verdict — collapses to the
 * same "unavailable" sentinel. This is the fail-safe boundary described in
 * docs/THREAT_MODEL.md §11: a broken or slow judge must never be silently treated as
 * an implicit "consistent", and must never itself become a hard deny (which would
 * make an unrelated outage block all legitimate spend) — it degrades to escalation.
 *
 * Every "unavailable" path returns only a fixed, category-based safe rationale (see
 * SAFE_UNAVAILABLE_MESSAGES) — never a raw provider response body, HTTP status text,
 * or exception message. The full detail is still logged (console.error) for operator
 * diagnostics; it is deliberately never part of the returned value, so it can never
 * reach an API response, the ledger, or the dashboard.
 */
export async function safeJudge(
  judge: IntentJudge,
  input: IntentJudgeInput,
  timeoutMs: number = DEFAULT_JUDGE_TIMEOUT_MS
): Promise<SafeIntentJudgment> {
  // Read once, up front — provenance is a property of which judge this process is
  // configured to use, known before any call is attempted, not something derived from
  // the call's outcome. Attached to EVERY returned judgment below, success or
  // "unavailable" alike, so the UI can always truthfully say which provider was in
  // play even when that provider just failed. See risk/types.ts's IntentJudge.provider.
  const provider = judge.provider;
  const model = judge.model;

  try {
    const result = await Promise.race([
      judge.judge(input),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ClassifiedJudgeError("timeout", `intent judge timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    if (result == null || typeof result !== "object") {
      const { category, safeRationale, diagnosticDetail } = classifyJudgeFailure(
        new ClassifiedJudgeError("malformed_response", "Intent judge returned a non-object result")
      );
      console.error(`Intent judge failed (category: ${category}):`, diagnosticDetail);
      return { verdict: "unavailable", rationale: safeRationale, category, provider, model };
    }
    if (!isSafeIntentVerdict((result as { verdict?: unknown }).verdict)) {
      const { category, safeRationale, diagnosticDetail } = classifyJudgeFailure(
        new ClassifiedJudgeError(
          "malformed_response",
          `Intent judge returned an unrecognized verdict: ${JSON.stringify((result as { verdict?: unknown }).verdict)}`
        )
      );
      console.error(`Intent judge failed (category: ${category}):`, diagnosticDetail);
      return { verdict: "unavailable", rationale: safeRationale, category, provider, model };
    }
    const rationale = (result as { rationale?: unknown }).rationale;
    if (typeof rationale !== "string" || rationale.length === 0) {
      const { category, safeRationale, diagnosticDetail } = classifyJudgeFailure(
        new ClassifiedJudgeError("malformed_response", "Intent judge returned no rationale")
      );
      console.error(`Intent judge failed (category: ${category}):`, diagnosticDetail);
      return { verdict: "unavailable", rationale: safeRationale, category, provider, model };
    }
    return { verdict: result.verdict, rationale, provider, model };
  } catch (error) {
    const { category, safeRationale, diagnosticDetail } = classifyJudgeFailure(error);
    console.error(`Intent judge failed (category: ${category}):`, diagnosticDetail);
    return {
      verdict: "unavailable",
      rationale: safeRationale,
      category,
      provider,
      model,
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

  // deps.cachedIntentJudgment is only ever set by the caller (routes/transactions.ts)
  // after it has independently confirmed — via computeSimulationFingerprint, on ITS
  // OWN copy of every security-relevant input — that a prior Simulate's judgment is
  // still valid and exactly matching. This function does no fingerprint validation of
  // its own; it only decides whether to skip the real judge call given an
  // already-trusted, pre-validated value. Nothing above this line (policy) or below it
  // (baseline, already computed above) is aware this exists.
  const intentJudgment = deps.cachedIntentJudgment
    ? { ...deps.cachedIntentJudgment, reused: true }
    : await safeJudge(
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
