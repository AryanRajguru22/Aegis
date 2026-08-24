import { Router, type RequestHandler } from "express";
import { decideTransaction } from "../../decision/decide.js";
import { executeTransaction } from "../../execution/executeTransaction.js";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import type { ClaimOutcome, IdempotencyCache, IdempotencyRecord } from "../idempotency.js";
import { parseCounterparty, parseTransactionBody } from "../validation.js";

const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const COMPLETE_WRITE_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a claim this caller does NOT own to settle. Repeatedly re-attempts
 * tryClaim with the same (scopedKey, requestHash) — while the original claimant is
 * still executing this returns "pending" every time (a pure status check, no new
 * side effect), until either the claimant completes (this call then returns
 * "completed" with the shared result) or the claimant's execution threw and released
 * the claim, in which case this call transparently becomes the new claimant
 * ("claimed") and the caller is now responsible for executing — see the route handler
 * below. This is what satisfies "no permanently stuck in-flight record" for the
 * in-process-throw case; the cross-restart case is handled separately by
 * createSqliteIdempotencyCache's startup reconciliation into "orphaned".
 */
async function waitForClaim(
  idempotency: IdempotencyCache,
  scopedKey: string,
  requestHash: string,
  { pollIntervalMs, timeoutMs }: { pollIntervalMs: number; timeoutMs: number }
): Promise<ClaimOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const outcome = idempotency.tryClaim(scopedKey, requestHash);
    if (outcome.kind !== "pending") return outcome;
    if (Date.now() >= deadline) {
      throw new ApiError(
        409,
        "Another request with this Idempotency-Key is still being processed and did not complete in time — retry shortly"
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * A bounded, synchronous best-effort at persisting a genuinely-completed result.
 * Called only after execution has already, definitively happened — see the route
 * handler's comment on why a failure here must never be treated the same as execution
 * itself failing. A few immediate retries are enough to ride out a transient SQLite
 * write hiccup without adding real latency; if all of them fail, the caller decides
 * how to degrade safely (see below).
 */
function tryCompleteWithRetry(idempotency: IdempotencyCache, scopedKey: string, record: IdempotencyRecord): boolean {
  let lastError: unknown;
  for (let attempt = 0; attempt < COMPLETE_WRITE_ATTEMPTS; attempt++) {
    try {
      idempotency.complete(scopedKey, record);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  // eslint-disable-next-line no-console
  console.error(
    `Idempotency cache write failed ${COMPLETE_WRITE_ATTEMPTS} times for "${scopedKey}" AFTER a successful execution. ` +
      `The claim is deliberately left "pending" (never released) so no future attempt can re-execute it — it will ` +
      `either be served correctly once a write eventually succeeds, or be reconciled to "orphaned" on the next ` +
      `process restart. Last error:`,
    lastError
  );
  return false;
}

export function createTransactionsRouter(deps: AppDependencies, requireAgent: RequestHandler): Router {
  const router = Router();

  router.post("/simulate", requireAgent, async (req, res) => {
    const agent = req.agent!;
    const transaction = parseTransactionBody(req.body);

    const decision = await decideTransaction(
      {
        tokenBase64: req.agentToken!,
        rootPublicKey: deps.rootPublicKey,
        agentId: agent.agentId,
        principalId: agent.principalId,
        delegatedGoal: agent.delegatedGoal,
        transaction,
      },
      {
        revocationStore: deps.revocationStore,
        ledger: deps.ledger,
        intentJudge: deps.intentJudge,
        baselineWindow: deps.baselineWindow,
        judgeTimeoutMs: deps.judgeTimeoutMs,
      }
    );

    res.status(200).json({ agentId: agent.agentId, decision });
  });

  router.post("/transactions", requireAgent, async (req, res) => {
    const agent = req.agent!;
    const idempotencyKeyHeader = req.headers["idempotency-key"];
    if (!idempotencyKeyHeader || typeof idempotencyKeyHeader !== "string") {
      throw new ApiError(400, 'Header "Idempotency-Key" is required for POST /transactions');
    }

    const transaction = parseTransactionBody(req.body);
    const counterparty = parseCounterparty(req.body);

    const scopedKey = `${agent.agentId}:${idempotencyKeyHeader}`;
    const requestHash = deps.idempotency.hashRequest({ transaction, counterparty });
    const pollIntervalMs = deps.idempotencyPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const waitTimeoutMs = deps.idempotencyWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

    // Atomically claim the key. Exactly one concurrent caller across any number of
    // simultaneous identical requests ever gets "claimed" — see idempotency.ts's doc
    // comment for why this is race-free, not just race-unlikely.
    let outcome = deps.idempotency.tryClaim(scopedKey, requestHash);

    if (outcome.kind === "pending") {
      outcome = await waitForClaim(deps.idempotency, scopedKey, requestHash, { pollIntervalMs, timeoutMs: waitTimeoutMs });
    }

    if (outcome.kind === "orphaned") {
      // A previous process died mid-claim on this exact key — see startup
      // reconciliation in createSqliteIdempotencyCache. We genuinely cannot tell
      // whether it had already executed, so this key can never be claimed, completed,
      // or replayed again; the only safe answer is a permanent, explicit rejection.
      throw new ApiError(
        409,
        "This Idempotency-Key was in progress when the server restarted and its outcome could not be confirmed — it can never be reused; retry with a new Idempotency-Key"
      );
    }

    if (outcome.kind === "hash_mismatch") {
      throw new ApiError(
        409,
        "This Idempotency-Key was already used with a different request body — use a new key for a new transaction"
      );
    }

    if (outcome.kind === "completed") {
      // Sequential replay (this call is itself the second/Nth attempt and found an
      // already-completed record) and the concurrent case (this call waited for a
      // still-executing sibling to finish) both land here, and both get back the
      // exact same response the original execution produced — never a fresh one.
      res.status(outcome.record.status).json(outcome.record.body);
      return;
    }

    // outcome.kind === "claimed": this request, and only this request, executes.
    let result;
    try {
      result = await executeTransaction(
        {
          tokenBase64: req.agentToken!,
          rootPublicKey: deps.rootPublicKey,
          agentId: agent.agentId,
          principalId: agent.principalId,
          delegatedGoal: agent.delegatedGoal,
          counterparty,
          transaction,
          idempotencyKey: scopedKey,
        },
        {
          revocationStore: deps.revocationStore,
          ledger: deps.ledger,
          intentJudge: deps.intentJudge,
          rails: deps.rails,
          baselineWindow: deps.baselineWindow,
          judgeTimeoutMs: deps.judgeTimeoutMs,
        }
      );
    } catch (error) {
      // decideTransaction/executeTransaction represent every normal business outcome
      // (allow/deny/escalate, settled/failed execution) as data, never a throw — so
      // reaching here means execution itself never genuinely completed (a bug, a DB
      // error partway through deciding). Nothing valid happened, so it is safe to
      // release the claim and let a retry with the same key attempt again from
      // scratch.
      deps.idempotency.release(scopedKey);
      throw error;
    }

    // Execution genuinely completed at this point — allow/deny/escalate and
    // settled/failed executions are all real, final outcomes. A failure from here on
    // is a CACHING problem, not an execution problem, and must never be treated as
    // "nothing happened": releasing the claim now would let a retry call
    // executeTransaction a second time for a transaction that may have already
    // settled on a real rail.
    const responseBody = { agentId: agent.agentId, ...result };
    tryCompleteWithRetry(deps.idempotency, scopedKey, { requestHash, status: 200, body: responseBody });
    // Whether or not the cache write ultimately succeeded, this caller — the one that
    // actually triggered the real execution — gets the true, accurate result. Never
    // fabricate a failure response for a transaction that genuinely succeeded.
    res.status(200).json(responseBody);
  });

  return router;
}
