import { sha256Hex, stableStringify } from "../state/crypto.js";
import type { TransactionRequest } from "../capability/types.js";
import type { SafeIntentJudgment } from "./types.js";

/**
 * Avoids an unnecessary second real intent-judge call (a real network round-trip,
 * against a real provider's rate/quota limits) when a client calls /simulate and then
 * immediately /transactions for the exact same, unchanged transaction and authority
 * context — the common "Simulate, review, then Execute" UI flow. This module owns
 * exactly two responsibilities: computing a fingerprint from every input that could
 * change what the intent judge would say, and a short-lived, single-use store keyed
 * by that fingerprint. It has NO opinion about policy, missions, capability, or
 * execution — those are untouched by this module and by its presence in the request
 * flow (see src/api/routes/transactions.ts for exactly where it's consulted, always
 * strictly after the deterministic mission-gate/capability checks would already have
 * run or short-circuited denial).
 *
 * Only the intent-judge result is ever cached — never the behavioral-baseline flags,
 * which src/decision/decide.ts always recomputes fresh regardless of a cache hit, and
 * never the policy/capability/mission verdict, which is never even consulted by this
 * module at all. A reused judgment can therefore never suppress a freshly-detected
 * behavioral anomaly, and can never be reached at all if policy denies.
 */

export interface CachedRiskResult {
  intentJudgment: SafeIntentJudgment;
  computedAt: number;
}

export interface SimulationCache {
  /** Stores a freshly-computed Simulate result under its fingerprint. */
  set(fingerprint: string, result: CachedRiskResult): void;
  /**
   * Single-use: a matching entry is removed on the FIRST get(), whether or not it
   * turns out to still be within its TTL — so a fingerprint can satisfy at most one
   * Execute's reuse, never repeated reuse across many later Executes of the same
   * transaction shape. Returns undefined for "no entry" and "entry expired" alike;
   * callers cannot distinguish the two, by design — either way the correct behavior
   * is identical: fall through to a fresh judge call.
   */
  get(fingerprint: string): CachedRiskResult | undefined;
}

/** 2 minutes — long enough to cover a human reviewing a Simulate result before clicking Execute, short enough that "reuse" never means "an AI opinion from an old session." */
export const DEFAULT_SIMULATION_CACHE_TTL_MS = 120_000;

/**
 * Every input that could change what the intent judge would say or that the caller
 * (src/api/routes/transactions.ts) treats as security-relevant enough that a change
 * must invalidate reuse. `tokenBase64` is the raw, presented capability token — using
 * the full token string (not just agentId) means ANY authority change (re-attenuation,
 * a differently-scoped token for the same agentId, revocation status is checked
 * separately and always fresh) automatically produces a different fingerprint, with no
 * need to separately enumerate which caveat fields matter. `delegatedGoal` is the
 * EFFECTIVE goal actually passed to the judge — the mission's own goal when a mission
 * is attached, the agent's standing goal otherwise — so a different mission (or the
 * same mission with a different goal, if that ever becomes editable) invalidates reuse
 * without this function needing any mission-specific knowledge.
 */
export interface SimulationFingerprintInput {
  tokenBase64: string;
  delegatedGoal: string;
  transaction: Pick<TransactionRequest, "amountMinorUnits" | "currency" | "category" | "rail"> & { purpose: string };
  counterparty: string;
  missionId?: string;
}

export function computeSimulationFingerprint(input: SimulationFingerprintInput): string {
  return sha256Hex(
    stableStringify({
      tokenBase64: input.tokenBase64,
      delegatedGoal: input.delegatedGoal,
      amountMinorUnits: input.transaction.amountMinorUnits,
      currency: input.transaction.currency,
      category: input.transaction.category,
      rail: input.transaction.rail,
      purpose: input.transaction.purpose,
      counterparty: input.counterparty,
      missionId: input.missionId ?? null,
    })
  );
}

export function createInMemorySimulationCache(opts: { ttlMs?: number } = {}): SimulationCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_SIMULATION_CACHE_TTL_MS;
  const store = new Map<string, CachedRiskResult>();

  function purgeExpired(now: number): void {
    // Opportunistic, on-write only — bounds memory growth from Simulate calls that
    // are never followed by a matching Execute, without needing a background timer
    // for what is, in this codebase's actual scale, a small, short-lived map.
    for (const [key, entry] of store) {
      if (now - entry.computedAt > ttlMs) store.delete(key);
    }
  }

  return {
    set(fingerprint, result) {
      purgeExpired(result.computedAt);
      store.set(fingerprint, result);
    },
    get(fingerprint) {
      const entry = store.get(fingerprint);
      if (!entry) return undefined;
      store.delete(fingerprint); // single-use, regardless of freshness
      if (Date.now() - entry.computedAt > ttlMs) return undefined; // expired — treat as a miss
      return entry;
    },
  };
}
