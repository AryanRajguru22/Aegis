/**
 * Core types for the Aegis capability-token module.
 *
 * Scope note (see docs/MVP_SCOPE.md): this module is the isolated, provable core —
 * root token issuance, attenuation, ancestry/caveat verification, and cascading
 * revocation. It deliberately does NOT implement cumulative/windowed spend tracking
 * (e.g. "$500 per week across many transactions") — that requires ledger state and
 * belongs to the policy engine layer built on top of this module, not the token
 * primitive itself. Each caveat here is a per-transaction ceiling.
 *
 * Money is represented in integer minor units (e.g. cents for USD), not floats.
 * This is both standard financial-engineering practice (no floating-point rounding
 * error) and a hard requirement of the underlying Biscuit datalog engine, which does
 * not support decimal number literals (confirmed empirically — see the attenuation
 * module's caveat-compilation comments).
 */

/** An allowlist-style caveat set attached to a capability token. */
export interface Caveats {
  /** Maximum amount, in integer minor units (e.g. cents), a single transaction may be for. */
  maxAmountMinorUnits: number;
  /** ISO 4217-style currency code, e.g. "USD". Validated as a plain identifier, not a full ISO list. */
  currency: string;
  /** Non-empty allowlist of transaction categories this token may be used for. */
  categories: string[];
  /** Non-empty allowlist of rails (execution channels) this token may be used on. */
  rails: string[];
  /** ISO 8601 timestamp after which the token must no longer authorize anything. */
  expiresAt: string;
}

/** A transaction an agent is attempting to make, presented for verification. */
export interface TransactionRequest {
  amountMinorUnits: number;
  currency: string;
  category: string;
  rail: string;
  /** ISO 8601 timestamp of the attempt; defaults to "now" if omitted by the caller. */
  timestamp?: string;
}

export interface IssueRootTokenInput {
  principalId: string;
  agentId: string;
  /** Natural-language statement of what this agent was delegated to do. Free text, stored as an informational fact only — never used in an enforcement check. */
  delegatedGoal: string;
  caveats: Caveats;
}

export interface AttenuateInput {
  parentTokenBase64: string;
  /** The caveats already enforced by the parent token, supplied by the caller so we can fast-fail on an attempted widening before touching the crypto layer. */
  parentCaveats: Caveats;
  agentId: string;
  /** The sub-agent's own caveats. Must be equal-or-narrower than parentCaveats in every dimension. */
  caveats: Caveats;
}

export interface VerifyResult {
  allowed: boolean;
  /** Present when allowed is false: which caveat(s) failed, or that the token/an ancestor was revoked. */
  reason?: string;
  /** The revocation identifiers (one per block) found in the presented token, for diagnostics/audit. */
  revocationIdentifiers: string[];
}

export interface RevocationRecord {
  revocationId: string;
  revokedAt: string;
  reason: string;
}
