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
 * This function is the only place in the codebase that is allowed to call a rail
 * adapter's execute() — see the test suite's "money only moves after allow" cases.
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

  const adapter = deps.rails.get(input.transaction.rail);
  const idempotencyKey = input.idempotencyKey ?? `${input.agentId}:${randomUUID()}`;

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
    data: { ...execution, idempotencyKey },
  });

  return { decision, execution };
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
