import { randomUUID } from "node:crypto";
import { decideTransaction } from "../decision/decide.js";
import { verifyTransaction } from "../capability/authorize.js";
import type { VerifyResult } from "../capability/types.js";
import type { RailExecutionResult } from "../rails/types.js";
import type { ExecuteDependencies, ExecuteTransactionInput, ExecuteTransactionResult } from "./types.js";

export const LEDGER_KIND_EXECUTION_RESULT = "execution_result";
/** Written when an "allow" verdict is withdrawn at the last moment, before any rail was called. */
export const LEDGER_KIND_PRE_EXECUTION_RECHECK = "pre_execution_recheck";

/**
 * The final lifecycle stage described in docs/SYSTEM_ARCHITECTURE.md §2: decide, then
 * — strictly only on "allow" — hand off to whichever rail adapter matches
 * transaction.rail, then write the settlement outcome to the ledger. `deny` and
 * `escalate` verdicts return with no `execution` field at all: no rail adapter is
 * invoked, and no execution_result entry is written, because nothing was attempted.
 * Rail adapters are only ever called from this module (callRailAndRecord below) — by
 * this function after an "allow", or by executeApprovedEscalation after an operator
 * approved an escalation. See the test suite's "money only moves after allow" cases.
 */
export async function executeTransaction(
  input: ExecuteTransactionInput,
  deps: ExecuteDependencies
): Promise<ExecuteTransactionResult> {
  const decision = await decideTransaction(input, deps);

  if (decision.verdict !== "allow") {
    return { decision };
  }

  // Re-check at the last possible moment. decideTransaction verified the capability at
  // its start, but then awaited the intent judge (up to the judge timeout — seconds), and
  // a revocation, token expiry, or mission cancellation landing in that window must still
  // stop the payment. Everything from here to adapter.execute() is synchronous, so no
  // further change can interleave between this check and the rail call.
  const blocked = recheckBeforeRail(input, deps, decision.policy);
  if (blocked) {
    const reason = `Authority changed while this transaction was being evaluated — execution withdrawn before any rail was called: ${blocked.reason}`;
    deps.ledger.append({
      kind: LEDGER_KIND_PRE_EXECUTION_RECHECK,
      agentId: input.agentId,
      principalId: input.principalId,
      data: { allowed: false, reason, originalVerdict: "allow", stage: blocked.stage, transaction: input.transaction },
    });
    return { decision: { verdict: "deny", reason, policy: blocked.policy, risk: decision.risk } };
  }

  const idempotencyKey = input.idempotencyKey ?? `${input.agentId}:${randomUUID()}`;
  const execution = await callRailAndRecord(input, deps, idempotencyKey);

  return { decision, execution };
}

export interface ApprovedEscalationInput extends ExecuteTransactionInput {
  escalationId: string;
  /** The principal who approved it — recorded on the withdrawal entry if authority changes at the last moment. */
  approvedBy: string;
}

export type ApprovedEscalationResult =
  | { blocked: true; reason: string; stage: "capability" | "guard" }
  | { blocked: false; execution: RailExecutionResult };

/**
 * Executes a transaction the risk stage ESCALATED and an operator then APPROVED. It skips
 * only the risk stage — the human decision replaces it. Everything else is re-run: the
 * capability token is re-verified (revocation of the agent or any ancestor, expiry, every
 * caveat) and the caller's synchronous `preExecutionGuard` (mission still active, ...)
 * is consulted, with no await between those checks and the rail call. If either fails,
 * NO rail is called and a pre_execution_recheck entry records the withdrawal.
 *
 * This lives next to executeTransaction on purpose: it is the second, and only other,
 * caller of callRailAndRecord, so "money moves only inside this module, only after
 * authorization" stays true by construction.
 */
export async function executeApprovedEscalation(input: ApprovedEscalationInput, deps: ExecuteDependencies): Promise<ApprovedEscalationResult> {
  const blocked = recheckBeforeRail(input, deps, { allowed: true, revocationIdentifiers: [] });
  if (blocked) {
    const reason = `Authority changed after the operator's approval — execution withdrawn before any rail was called: ${blocked.reason}`;
    deps.ledger.append({
      kind: LEDGER_KIND_PRE_EXECUTION_RECHECK,
      agentId: input.agentId,
      principalId: input.principalId,
      data: { allowed: false, reason, originalVerdict: "escalate", stage: blocked.stage, escalationId: input.escalationId, approvedBy: input.approvedBy, transaction: input.transaction },
    });
    return { blocked: true, reason, stage: blocked.stage };
  }
  const idempotencyKey = input.idempotencyKey ?? `escalation:${input.escalationId}`;
  const execution = await callRailAndRecord(input, deps, idempotencyKey, { escalationId: input.escalationId });
  return { blocked: false, execution };
}

/**
 * The ONLY place in the codebase that calls a rail adapter's execute(). Both the normal
 * path (an "allow" verdict) and the operator-approved path (an approved escalation) go
 * through here, strictly after their own last-moment re-check. Always records the
 * outcome in the ledger as an execution_result entry.
 */
async function callRailAndRecord(
  input: ExecuteTransactionInput,
  deps: ExecuteDependencies,
  idempotencyKey: string,
  extraLedgerData?: Record<string, unknown>
): Promise<RailExecutionResult> {
  const adapter = deps.rails.get(input.transaction.rail);

  let execution: RailExecutionResult;
  if (!adapter) {
    // Policy already validated that this rail is in the token's allowlist — a missing
    // adapter here is an operational/configuration gap, not a security decision, and
    // must fail closed (report failure) rather than silently no-op as if it succeeded.
    execution = {
      success: false,
      rail: input.transaction.rail,
      reference: "",
      settledAt: new Date().toISOString(),
      error: `No rail adapter registered for rail "${input.transaction.rail}"`,
    };
  } else {
    try {
      execution = await adapter.execute({
        agentId: input.agentId,
        principalId: input.principalId,
        amountMinorUnits: input.transaction.amountMinorUnits,
        currency: input.transaction.currency,
        category: input.transaction.category,
        counterparty: input.counterparty,
        purpose: input.transaction.purpose,
        idempotencyKey,
      });
    } catch (error) {
      // A rail adapter is expected to catch its own errors and return a failure
      // result (both adapters in this codebase do), but this call site does not trust
      // that as a hard guarantee — an adapter bug that throws must not crash the
      // caller or skip the ledger write.
      execution = {
        success: false,
        rail: input.transaction.rail,
        reference: "",
        settledAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  deps.ledger.append({
    kind: LEDGER_KIND_EXECUTION_RESULT,
    agentId: input.agentId,
    principalId: input.principalId,
    data: { ...execution, idempotencyKey, ...(extraLedgerData ?? {}) },
  });

  return execution;
}

/** Returns undefined when execution may proceed; otherwise why it must not. Fails closed on any exception. */
function recheckBeforeRail(
  input: ExecuteTransactionInput,
  deps: ExecuteDependencies,
  originalPolicy: VerifyResult
): { stage: "capability" | "guard"; reason: string; policy: VerifyResult } | undefined {
  try {
    const policy = verifyTransaction(input.tokenBase64, input.rootPublicKey, input.transaction, deps.revocationStore);
    if (!policy.allowed) {
      return { stage: "capability", reason: policy.reason ?? "capability no longer authorizes this transaction", policy };
    }
  } catch (error) {
    const reason = `capability re-verification failed (${error instanceof Error ? error.message : String(error)})`;
    return { stage: "capability", reason, policy: { ...originalPolicy, allowed: false, reason } };
  }
  if (deps.preExecutionGuard) {
    try {
      const guard = deps.preExecutionGuard();
      if (!guard.ok) {
        return { stage: "guard", reason: guard.reason, policy: { ...originalPolicy, allowed: false, reason: guard.reason } };
      }
    } catch (error) {
      const reason = `pre-execution guard failed (${error instanceof Error ? error.message : String(error)})`;
      return { stage: "guard", reason, policy: { ...originalPolicy, allowed: false, reason } };
    }
  }
  return undefined;
}
