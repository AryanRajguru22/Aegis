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
}

export interface BaselineFlag {
  code: "high_rate" | "amount_deviation";
  detail: string;
}
