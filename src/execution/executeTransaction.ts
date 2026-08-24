import { randomUUID } from "node:crypto";
import { decideTransaction } from "../decision/decide.js";
import type { RailExecutionResult } from "../rails/types.js";
import type { ExecuteDependencies, ExecuteTransactionInput, ExecuteTransactionResult } from "./types.js";

export const LEDGER_KIND_EXECUTION_RESULT = "execution_result";

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
