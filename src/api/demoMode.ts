import { AnthropicIntentJudge } from "../risk/anthropicJudge.js";
import { GeminiIntentJudge } from "../risk/geminiJudge.js";
import { DEFAULT_JUDGE_TIMEOUT_MS } from "../decision/decide.js";
import type { IntentJudge } from "../risk/types.js";
import type { RailAdapter } from "../rails/types.js";

/**
 * Local demo mode — a strictly opt-in server configuration that lets a developer run
 * the complete, unmodified Aegis pipeline (capability → mission → decision/risk →
 * execution → ledger, all in src/decision, src/execution, src/mission, exactly as
 * proven by every other test in this codebase) without ANTHROPIC_API_KEY or
 * STRIPE_SECRET_KEY, for a local software-pipeline walkthrough. This module is the
 * ENTIRE surface of what demo mode changes: which IntentJudge is constructed, and
 * which rail adapters are registered. Nothing else — not capability verification, not
 * mission checks, not decideTransaction, not executeTransaction, not the ledger, not
 * idempotency, not reservations — is aware demo mode exists at all. See
 * src/api/main.ts for where these are actually wired in.
 */

const DEMO_MODE_ENV_VALUE = "true";

/**
 * Strict equality against the literal string "true" — not any other truthy-looking
 * value ("1", "TRUE", "yes") — so a malformed or accidental environment value can
 * never silently enable demo mode. Unset, empty, or anything else is OFF.
 */
export function isDemoModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AEGIS_DEMO_MODE === DEMO_MODE_ENV_VALUE;
}

/**
 * A fixed, deterministic stand-in for the real intent-consistency judge — reusing the
 * exact "always consistent" shape already used as the default success path throughout
 * this codebase's own test suite (see src/api/__tests__/harness.ts's
 * alwaysConsistentJudge, used as buildHarness()'s own default). It performs no
 * analysis of the transaction at all — it is not a risk model, invented or otherwise,
 * and must never be mistaken for real AI judgment. Its rationale text says so
 * explicitly, so it is unmistakable in the ledger, the live feed, and the dashboard
 * even if a viewer never checks server config.
 */
export function createDemoIntentJudge(): IntentJudge {
  return {
    provider: "demo",
    async judge() {
      return {
        verdict: "consistent",
        rationale:
          "LOCAL DEMO MODE: deterministic stand-in judge — always returns \"consistent\" for every transaction. " +
          "This is not a real AI risk evaluation and must never be used in production.",
      };
    },
  };
}

export type RiskProvider = "anthropic" | "gemini";

/**
 * Validates AEGIS_RISK_PROVIDER's raw string value. `undefined` (unset) is valid and
 * means "no explicit choice" — every other value must be exactly "anthropic" or
 * "gemini", so a typo fails loudly at startup rather than being silently ignored.
 */
function parseExplicitRiskProvider(value: string | undefined): RiskProvider | undefined {
  if (value === undefined) return undefined;
  if (value === "anthropic" || value === "gemini") return value;
  throw new Error(
    `Invalid AEGIS_RISK_PROVIDER value: "${value}" — must be exactly "anthropic" or "gemini" if set at all.`
  );
}

/**
 * Selects the IntentJudge to construct. In demo mode, neither API key is ever even
 * read here — the deterministic stand-in is used unconditionally, so there is no code
 * path where demo mode could accidentally depend on (or accidentally skip) a real key.
 * This is unchanged from before Gemini existed.
 *
 * Outside demo mode, this is the one place that decides between the two real,
 * independent IntentJudge implementations (src/risk/anthropicJudge.ts,
 * src/risk/geminiJudge.ts) — precedence, in order:
 *   1. AEGIS_RISK_PROVIDER="gemini" -> require GEMINI_API_KEY, use Gemini.
 *   2. AEGIS_RISK_PROVIDER="anthropic" -> require ANTHROPIC_API_KEY, use Anthropic.
 *   3. No AEGIS_RISK_PROVIDER set, and only one of the two keys is present -> use that
 *      one (this is the exact pre-Gemini behavior when only ANTHROPIC_API_KEY is set).
 *   4. No AEGIS_RISK_PROVIDER set, and BOTH keys are present -> refuse to guess; throw,
 *      requiring an explicit choice.
 *   5. Neither key present -> throw (the original, pre-Gemini fail-closed behavior;
 *      the error message deliberately still contains "ANTHROPIC_API_KEY is required"
 *      so this remains, byte-for-byte, the same hard failure it always was for anyone
 *      who has only ever set ANTHROPIC_API_KEY).
 * The caller (main.ts) is responsible for treating any throw here as a fail-closed
 * startup refusal — never a silent fallback to some other behavior.
 */
export function createServerIntentJudge(opts: {
  demoMode: boolean;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  riskProvider?: string;
}): IntentJudge {
  if (opts.demoMode) {
    return createDemoIntentJudge();
  }

  const explicit = parseExplicitRiskProvider(opts.riskProvider);

  if (explicit === "gemini") {
    if (!opts.geminiApiKey) {
      throw new Error("AEGIS_RISK_PROVIDER=gemini requires GEMINI_API_KEY to be set.");
    }
    return new GeminiIntentJudge({ apiKey: opts.geminiApiKey });
  }
  if (explicit === "anthropic") {
    if (!opts.anthropicApiKey) {
      throw new Error("AEGIS_RISK_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.");
    }
    return new AnthropicIntentJudge({ apiKey: opts.anthropicApiKey });
  }

  const hasGemini = Boolean(opts.geminiApiKey);
  const hasAnthropic = Boolean(opts.anthropicApiKey);

  if (hasGemini && hasAnthropic) {
    throw new Error(
      "Both ANTHROPIC_API_KEY and GEMINI_API_KEY are set — set AEGIS_RISK_PROVIDER=anthropic or " +
        "AEGIS_RISK_PROVIDER=gemini to choose which risk judge this process should use."
    );
  }
  if (hasGemini) {
    return new GeminiIntentJudge({ apiKey: opts.geminiApiKey });
  }
  if (hasAnthropic) {
    return new AnthropicIntentJudge({ apiKey: opts.anthropicApiKey });
  }

  throw new Error(
    "ANTHROPIC_API_KEY is required (or GEMINI_API_KEY, with AEGIS_RISK_PROVIDER=gemini) when AEGIS_DEMO_MODE is not enabled."
  );
}

/**
 * A comfortable margin above the real, observed Gemini latency (20–28s across three
 * live calls — see src/risk/__tests__/gemini-judge.live.test.ts) — not the tightest
 * value that would technically work, but one that stays practical if a particular
 * call runs slower than what's been observed so far. src/decision/decide.ts's own
 * DEFAULT_JUDGE_TIMEOUT_MS (8000ms) remains exactly what it was before Gemini existed
 * — this is a provider-aware default computed here, one layer up, not a change to
 * that generic fallback.
 */
export const GEMINI_DEFAULT_JUDGE_TIMEOUT_MS = 45_000;

/**
 * Validates AEGIS_JUDGE_TIMEOUT_MS's raw string value strictly: must be a positive
 * whole number of milliseconds. `undefined` (unset) is valid and means "no explicit
 * override — use the provider-aware default" (see defaultJudgeTimeoutMs below).
 * Everything else — zero, negative, non-numeric, decimals, whitespace-only, a number
 * with a trailing unit like "8000ms" — throws rather than being coerced or ignored,
 * so a typo'd or malformed value fails loudly at startup instead of silently landing
 * on some default the operator never chose.
 */
export function parseExplicitJudgeTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  // Whole numbers only — no leading zeros beyond "0" itself, no sign, no decimal
  // point, no exponent notation, no surrounding whitespace already stripped above.
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(
      `Invalid AEGIS_JUDGE_TIMEOUT_MS value: "${value}" — must be a positive whole number of milliseconds (e.g. "45000").`
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid AEGIS_JUDGE_TIMEOUT_MS value: "${value}" — must be a positive whole number of milliseconds (e.g. "45000").`
    );
  }
  return parsed;
}

/**
 * The timeout to use when AEGIS_JUDGE_TIMEOUT_MS is not explicitly set — provider-aware
 * because a single fixed default cannot fit both the demo/Anthropic path (already
 * fast in practice) and real Gemini's observed latency, and a short timeout tuned for
 * the former would make a Gemini-backed deployment escalate almost every transaction
 * before Gemini ever gets the chance to actually respond. Call with whether the judge
 * that was actually constructed (see createServerIntentJudge) is a GeminiIntentJudge —
 * never with AEGIS_RISK_PROVIDER's raw value directly, so this stays correct even for
 * the auto-inferred (no explicit AEGIS_RISK_PROVIDER) selection path.
 */
export function defaultJudgeTimeoutMs(isGemini: boolean): number {
  return isGemini ? GEMINI_DEFAULT_JUDGE_TIMEOUT_MS : DEFAULT_JUDGE_TIMEOUT_MS;
}

/**
 * Selects which rail adapters to register. In demo mode this ALWAYS returns only
 * `mockX402Rail`, even if a `stripeAdapter` is passed — the caller (main.ts) is
 * additionally structured to never construct one from a real STRIPE_SECRET_KEY while
 * demo mode is on (see main.ts), but this function enforces the same guarantee
 * independently: a Stripe adapter reaching this function while demoMode is true is
 * silently and unconditionally excluded, not just "not constructed upstream" — two
 * independent layers, not one, is what "cannot accidentally use a live/test Stripe
 * key" means here.
 */
export function selectRailAdapters(opts: { demoMode: boolean; mockX402Rail: RailAdapter; stripeAdapter?: RailAdapter }): RailAdapter[] {
  if (opts.demoMode) {
    return [opts.mockX402Rail];
  }
  return opts.stripeAdapter ? [opts.mockX402Rail, opts.stripeAdapter] : [opts.mockX402Rail];
}
