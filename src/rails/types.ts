/**
 * A rail adapter is the thin, swappable translation layer between Aegis's internal
 * decision and a real payment rail's own API shape — see docs/SYSTEM_ARCHITECTURE.md
 * §1 and §8. Aegis's policy and risk engines never talk to a rail directly; they
 * produce a verdict, and only on "allow" does the execution layer (src/execution)
 * hand the transaction to whichever adapter matches transaction.rail. Two
 * structurally different adapters exist in this MVP specifically to prove
 * rail-agnosticism rather than assert it — see stripeTestRail.ts (a real card-network
 * API, PaymentIntent-shaped) and mockX402/ (an HTTP-native, signature-based paywall
 * protocol) for how differently the two actually work under this one interface.
 */
export interface RailExecutionRequest {
  agentId: string;
  principalId: string;
  amountMinorUnits: number;
  currency: string;
  category: string;
  /** The merchant, vendor, or counterparty this payment is going to. */
  counterparty: string;
  purpose: string;
  /** Stable across retries of the *same* attempt, so a rail adapter can avoid double-executing it. Generated fresh per new attempt by the execution layer, never reused across logically distinct transactions. */
  idempotencyKey: string;
}

export interface RailExecutionResult {
  success: boolean;
  /** Matches the adapter's own railId. */
  rail: string;
  /** Rail-specific reference for this settlement attempt — a Stripe PaymentIntent id, a mock-x402 receipt id, etc. Present even on failure when the rail assigned one before failing. */
  reference: string;
  settledAt: string;
  /** Present only when success is false. */
  error?: string;
  /** Rail-specific response payload, kept for audit purposes — never assumed to have a particular shape outside its own adapter. */
  raw?: unknown;
}

export interface RailAdapter {
  readonly railId: string;
  execute(request: RailExecutionRequest): Promise<RailExecutionResult>;
}

export interface RailRegistry {
  get(railId: string): RailAdapter | undefined;
  list(): string[];
}

export function createRailRegistry(adapters: RailAdapter[]): RailRegistry {
  const byId = new Map<string, RailAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.railId)) {
      throw new Error(`Duplicate rail adapter registered for railId "${adapter.railId}"`);
    }
    byId.set(adapter.railId, adapter);
  }
  return {
    get: (railId) => byId.get(railId),
    list: () => Array.from(byId.keys()),
  };
}
