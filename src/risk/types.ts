/**
 * The intent-consistency judge is the differentiated piece described in
 * docs/DIFFERENTIATION.md §3.3: a transaction can pass every numeric policy check
 * (amount, category, rail, expiry — see src/capability) and still be the wrong thing
 * for an agent to be doing, if it doesn't serve the goal it was actually delegated.
 * This interface is intentionally narrow and side-effect-free so the orchestration
 * logic in src/decision can be tested against a deterministic fake without ever
 * calling a real model — see src/risk/anthropicJudge.ts for the real implementation
 * and src/decision/__tests__ for how the fake is used adversarially.
 */
export type IntentVerdict = "consistent" | "inconsistent" | "ambiguous";

export interface IntentJudgment {
  verdict: IntentVerdict;
  rationale: string;
}

export interface IntentJudgeInput {
  delegatedGoal: string;
  transaction: {
    amountMinorUnits: number;
    currency: string;
    category: string;
    rail: string;
    /** The agent's own stated reason for this specific transaction. Treated as untrusted input by the judge — see anthropicJudge.ts. */
    purpose: string;
  };
}

export interface IntentJudge {
  judge(input: IntentJudgeInput): Promise<IntentJudgment>;
  /**
   * Truthful, self-reported provenance — optional so ad-hoc test doubles (scripted
   * fakes throughout src/**\/__tests__) never need to implement it, but always set by
   * the three real implementations (AnthropicIntentJudge, GeminiIntentJudge,
   * src/api/demoMode.ts's createDemoIntentJudge) so the UI can honestly identify which
   * judge produced — or was attempted for — a given decision. Read directly off the
   * judge INSTANCE, not off any individual judgment, since provenance is a property of
   * which judge this process is configured to use, known before any call is made — see
   * src/decision/decide.ts's safeJudge, which is the only place this is read.
   */
  readonly provider?: string;
  readonly model?: string;
}

export interface BaselineFlag {
  code: "high_rate" | "amount_deviation";
  detail: string;
}

/**
 * A closed set of SAFE-TO-EXPOSE failure categories for an intent judge — never a raw
 * provider error shape. Any judge implementation may throw a ClassifiedJudgeError
 * (below) to give src/decision/decide.ts's safeJudge() precise classification instead
 * of forcing it to guess from a message string; a judge that throws a plain Error
 * still degrades safely, just as "unknown" (see decide.ts's classifyJudgeFailure).
 */
export type JudgeFailureCategory =
  | "timeout"
  | "authentication"
  | "quota"
  | "provider_unavailable"
  | "malformed_response"
  | "unknown";

/**
 * Thrown by a judge implementation (see src/risk/geminiJudge.ts) instead of a plain
 * Error when it can classify its own failure. `message` may carry full diagnostic
 * detail (HTTP status, a provider's raw error body) — that is for server-side logging
 * ONLY (see decide.ts's safeJudge, which logs it via console.error and never returns
 * it to a caller); `category` is what downstream code uses to build the fixed, safe,
 * user-facing rationale. Never include an API key or Authorization header value in
 * `message` — none of the provider SDKs used in this codebase echo one back in their
 * own error shapes (confirmed against @google/genai's ApiError, whose entire shape is
 * `{status, message}` sourced from the provider's own response body).
 */
export class ClassifiedJudgeError extends Error {
  readonly category: JudgeFailureCategory;
  constructor(category: JudgeFailureCategory, message: string) {
    super(message);
    this.name = "ClassifiedJudgeError";
    this.category = category;
  }
}
