import { AnthropicIntentJudge } from "../risk/anthropicJudge.js";
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

/**
 * Selects the IntentJudge to construct. In demo mode, ANTHROPIC_API_KEY is never even
 * read here — the deterministic stand-in is used unconditionally, so there is no code
 * path where demo mode could accidentally depend on (or accidentally skip) a real key.
 * Outside demo mode, behavior is byte-for-byte the same as before this module existed:
 * a real ANTHROPIC_API_KEY is required, and its absence is a hard, thrown error — the
 * caller (main.ts) is responsible for treating that as a fail-closed startup refusal,
 * exactly as it already did.
 */
export function createServerIntentJudge(opts: { demoMode: boolean; anthropicApiKey?: string }): IntentJudge {
  if (opts.demoMode) {
    return createDemoIntentJudge();
  }
  if (!opts.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when AEGIS_DEMO_MODE is not enabled.");
  }
  return new AnthropicIntentJudge({ apiKey: opts.anthropicApiKey });
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
