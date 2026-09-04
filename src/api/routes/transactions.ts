import { Router, type RequestHandler } from "express";
import { decideTransaction } from "../../decision/decide.js";
import { executeTransaction } from "../../execution/executeTransaction.js";
import type { Caveats, TransactionRequest } from "../../capability/types.js";
import type { MissionRecord } from "../../state/missions.js";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import type { ClaimOutcome, IdempotencyCache, IdempotencyRecord } from "../idempotency.js";
import { checkMissionGate, computeMissionSpent, validateMissionAgainstToken, LEDGER_KIND_MISSION_POLICY_VERDICT, LEDGER_KIND_MISSION_TRANSACTION_LINK, LEDGER_KIND_MISSION_PIPELINE_OUTCOME } from "../../mission/index.js";
import { parseCounterparty, parseOptionalCounterparty, parseOptionalMissionId, parseTransactionBody } from "../validation.js";
import { computeSimulationFingerprint } from "../../decision/simulationCache.js";

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

type MissionGateResult =
  | { kind: "ok"; delegatedGoal: string }
  | { kind: "not_found" }
  | { kind: "not_owned" }
  | { kind: "token_violation"; reason: string }
  | { kind: "denied"; reason: string };

/**
 * The mission-to-pipeline integration boundary described in docs/SYSTEM_ARCHITECTURE.md's
 * mission flow: Mission/Goal → candidate transaction → capability verification →
 * deterministic policy → risk/intent evaluation → decision → execution → ledger.
 *
 * This function is everything that happens BEFORE that existing, unmodified pipeline
 * ever runs, and has NO side effects (no reservation, no ledger write) — used by both
 * /simulate (a pure dry-run) and, wrapped by runMissionPreflight below, /transactions.
 * It never mints, attenuates, or checks a capability token itself — a mission can only
 * ever narrow what the agent's own token already allows, never grant anything beyond
 * it, so every check here is a strictly ADDITIONAL, strictly NARROWING gate.
 * Ownership, then token-compatibility, then the deterministic policy gate
 * (checkMissionGate, pure — see src/mission/policy.ts) — cheapest and
 * least-trusted-input first, mirroring src/decision/decide.ts's own documented
 * ordering discipline.
 */
/**
 * Closes the gap explicitly flagged (but deliberately left unimplemented, "a future
 * orchestration step") in src/mission/policy.ts's own doc comment on checkMissionGate:
 * that pure, synchronous function only ever checks `mission.status`, never wall-clock
 * time — nothing previously transitioned a mission past its own expiresAt into status
 * "expired", so an expired-by-clock mission with status still "active" was silently
 * NOT denied at transaction time (found during a full backend audit; confirmed no
 * existing test covered this). This reconciliation runs first, lazily, on every
 * mission-gated attempt — no cron job, no background timer — and persists the
 * transition via the exact same MissionStore.close() the cancel route already uses,
 * so checkMissionGate's EXISTING `status !== "active"` branch now correctly denies an
 * expired mission with zero changes to that pure function itself.
 */
function reconcileMissionExpiry(deps: AppDependencies, mission: MissionRecord): MissionRecord {
  if (mission.status === "active" && new Date(mission.expiresAt).getTime() <= Date.now()) {
    return deps.missions.close(mission.missionId, "expired");
  }
  return mission;
}

function evaluateMissionGate(
  deps: AppDependencies,
  agent: { agentId: string; principalId: string; caveats: Record<string, unknown> },
  missionId: string,
  transaction: TransactionRequest & { purpose: string },
  counterparty: string
): MissionGateResult {
  let mission = deps.missions.get(missionId);
  if (!mission) {
    return { kind: "not_found" };
  }
  // Ownership checked BEFORE reconciling/observing expiry — a non-owner must see
  // exactly the same "not_owned" result regardless of the mission's real expiry
  // state, never a hint that distinguishes the two.
  if (mission.agentId !== agent.agentId || mission.principalId !== agent.principalId) {
    return { kind: "not_owned" };
  }
  mission = reconcileMissionExpiry(deps, mission);

  try {
    validateMissionAgainstToken(mission, agent.caveats as unknown as Caveats);
  } catch (error) {
    return { kind: "token_violation", reason: error instanceof Error ? error.message : String(error) };
  }

  const spentSoFar = computeMissionSpent(deps.ledger.listByAgent(agent.agentId), missionId);
  const gate = checkMissionGate(
    mission,
    { amountMinorUnits: transaction.amountMinorUnits, category: transaction.category, counterparty },
    spentSoFar
  );
  if (!gate.allowed) {
    return { kind: "denied", reason: gate.reason ?? "Mission policy denied this transaction" };
  }

  return { kind: "ok", delegatedGoal: mission.goal };
}

/**
 * The /transactions-only wrapper around evaluateMissionGate: on a passing gate,
 * additionally attempts the atomic budget reservation (see src/mission/reservation.ts)
 * — the REAL, concurrency-safe accept/reject decision. evaluateMissionGate running
 * first is purely a cheaper pre-check for a clearer denial reason in the common
 * (non-race) case; reserve()'s own atomic UPDATE, never a JS-level check, is what's
 * actually trusted for the budget decision — see reservation.ts's own doc comment.
 */
function runMissionPreflight(
  deps: AppDependencies,
  agent: { agentId: string; principalId: string; caveats: Record<string, unknown> },
  missionId: string,
  transaction: TransactionRequest & { purpose: string },
  counterparty: string,
  scopedKey: string
): MissionGateResult {
  const evaluation = evaluateMissionGate(deps, agent, missionId, transaction, counterparty);
  if (evaluation.kind !== "ok") {
    return evaluation;
  }

  const reservation = deps.reservations.reserve(missionId, transaction.amountMinorUnits, scopedKey);
  if (reservation.kind === "reserved") {
    return evaluation;
  }
  if (reservation.kind === "insufficient_budget") {
    return { kind: "denied", reason: "Transaction would exceed this mission's remaining budget" };
  }
  if (reservation.kind === "mission_not_active") {
    return { kind: "denied", reason: `Mission is not active (status: "${reservation.status}")` };
  }
  return { kind: "not_found" }; // reservation.kind === "mission_not_found" — raced with a concurrent deletion-equivalent; treat the same as never having found it
}

export function createTransactionsRouter(deps: AppDependencies, requireAgent: RequestHandler): Router {
  const router = Router();

  router.post("/simulate", requireAgent, async (req, res) => {
    const agent = req.agent!;
    const transaction = parseTransactionBody(req.body);
    const missionId = parseOptionalMissionId(req.body);
    const counterparty = parseOptionalCounterparty(req.body);

    let delegatedGoal = agent.delegatedGoal;

    // Backwards compatible: a request with no missionId behaves exactly as /simulate
    // always has. A dry run — no reservation is ever attempted here (see
    // runMissionPreflight, /transactions-only) — but the mission-gate ledger entry IS
    // written on a denial, mirroring how decideTransaction below already writes its
    // own ledger entries even during simulate (an existing, unchanged behavior).
    if (missionId !== undefined) {
      if (!counterparty) {
        throw new ApiError(400, '"counterparty" is required when "missionId" is present, to evaluate the mission\'s approved-counterparty gate');
      }
      const evaluation = evaluateMissionGate(deps, agent, missionId, transaction, counterparty);

      if (evaluation.kind === "not_found") {
        throw new ApiError(404, `Mission "${missionId}" not found`);
      }
      if (evaluation.kind === "not_owned") {
        throw new ApiError(403, `Mission "${missionId}" does not belong to the authenticated agent`);
      }
      if (evaluation.kind === "token_violation") {
        throw new ApiError(409, `Mission "${missionId}" exceeds the agent's own capability token: ${evaluation.reason}`);
      }
      if (evaluation.kind === "denied") {
        deps.ledger.append({
          kind: LEDGER_KIND_MISSION_POLICY_VERDICT,
          agentId: agent.agentId,
          principalId: agent.principalId,
          data: { missionId, allowed: false, reason: evaluation.reason, transaction, counterparty },
        });
        res.status(200).json({
          agentId: agent.agentId,
          decision: { verdict: "deny" as const, reason: evaluation.reason, source: "mission" as const },
        });
        return;
      }
      delegatedGoal = evaluation.delegatedGoal;
    }

    const decision = await decideTransaction(
      {
        tokenBase64: req.agentToken!,
        rootPublicKey: deps.rootPublicKey,
        agentId: agent.agentId,
        principalId: agent.principalId,
        delegatedGoal,
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

    // Only ever caches the intent-judge result — never the policy/capability verdict,
    // never baseline flags — and only when the risk stage actually ran (policy already
    // denying means decision.risk is absent, and there is nothing intent-judge-shaped
    // to reuse). See simulationCache.ts's doc comment for the full invalidation design;
    // this fingerprint uses the SAME raw presented token and effective delegatedGoal
    // that this exact decideTransaction call just used, so a later /transactions call
    // can only ever get a cache hit for a request that is identical in every field this
    // fingerprint covers.
    if (deps.simulationCache && decision.risk) {
      const fingerprint = computeSimulationFingerprint({
        tokenBase64: req.agentToken!,
        delegatedGoal,
        transaction,
        counterparty: counterparty ?? "",
        missionId,
      });
      deps.simulationCache.set(fingerprint, {
        intentJudgment: decision.risk.intentJudgment,
        computedAt: Date.now(),
      });
    }

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
    const missionId = parseOptionalMissionId(req.body);

    const scopedKey = `${agent.agentId}:${idempotencyKeyHeader}`;
    // missionId is folded into the hash: reusing the same Idempotency-Key with a
    // DIFFERENT missionId (or with/without one at all) must be detected as a
    // hash_mismatch, never silently treated as a replay of the original attempt.
    const requestHash = deps.idempotency.hashRequest({ transaction, counterparty, missionId: missionId ?? null });
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

    let delegatedGoal = agent.delegatedGoal;

    if (missionId !== undefined) {
      const preflight = runMissionPreflight(deps, agent, missionId, transaction, counterparty, scopedKey);

      if (preflight.kind === "not_found") {
        deps.idempotency.release(scopedKey);
        throw new ApiError(404, `Mission "${missionId}" not found`);
      }
      if (preflight.kind === "not_owned") {
        deps.idempotency.release(scopedKey);
        throw new ApiError(403, `Mission "${missionId}" does not belong to the authenticated agent`);
      }
      if (preflight.kind === "token_violation") {
        deps.idempotency.release(scopedKey);
        throw new ApiError(409, `Mission "${missionId}" exceeds the agent's own capability token: ${preflight.reason}`);
      }
      if (preflight.kind === "denied") {
        // A genuine mission-policy evaluation — recorded in the ledger, same as every
        // other Aegis verdict, and cached via idempotency exactly like a normal
        // deny/escalate response (NOT released — this is a final, cacheable decision,
        // not "nothing happened"; releasing here would both incorrectly let a retry
        // re-evaluate a decision that already has an answer, and — since the claim
        // would already be gone — make the tryCompleteWithRetry call below fail every
        // time), so a replay of this same key returns the identical denial without
        // re-evaluating anything.
        deps.ledger.append({
          kind: LEDGER_KIND_MISSION_POLICY_VERDICT,
          agentId: agent.agentId,
          principalId: agent.principalId,
          data: { missionId, allowed: false, reason: preflight.reason, transaction, counterparty },
        });
        const responseBody = {
          agentId: agent.agentId,
          decision: { verdict: "deny" as const, reason: preflight.reason, source: "mission" as const },
        };
        tryCompleteWithRetry(deps.idempotency, scopedKey, { requestHash, status: 200, body: responseBody });
        res.status(200).json(responseBody);
        return;
      }
      // preflight.kind === "ok": the mission's own goal is what this specific
      // transaction is judged against — sharper than the agent's whole standing
      // delegated goal, and the only mission-specific value threaded into the
      // otherwise completely unmodified pipeline below.
      delegatedGoal = preflight.delegatedGoal;
    }

    // outcome.kind === "claimed": this request, and only this request, executes.
    //
    // Consulted strictly AFTER the mission preflight above has finalized delegatedGoal
    // (a mission-narrowed goal must be part of the fingerprint, and this is the first
    // point it's known) and strictly BEFORE executeTransaction, which re-runs the
    // capability/policy check fresh regardless of what's found here — a cache hit only
    // ever skips the intent-judge network call, never any deterministic check. See
    // simulationCache.ts for why the raw presented token is part of the fingerprint
    // (any authority change invalidates automatically) and why a hit is single-use.
    const cached = deps.simulationCache?.get(
      computeSimulationFingerprint({
        tokenBase64: req.agentToken!,
        delegatedGoal,
        transaction,
        counterparty,
        missionId,
      })
    );

    let result;
    try {
      result = await executeTransaction(
        {
          tokenBase64: req.agentToken!,
          rootPublicKey: deps.rootPublicKey,
          agentId: agent.agentId,
          principalId: agent.principalId,
          delegatedGoal,
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
          cachedIntentJudgment: cached?.intentJudgment,
        }
      );
    } catch (error) {
      // decideTransaction/executeTransaction represent every normal business outcome
      // (allow/deny/escalate, settled/failed execution) as data, never a throw — so
      // reaching here means execution itself never genuinely completed (a bug, a DB
      // error partway through deciding). Nothing valid happened, so it is safe to
      // release the claim AND the mission reservation (if any), letting a retry with
      // the same key attempt again from scratch.
      deps.idempotency.release(scopedKey);
      if (missionId !== undefined) {
        deps.reservations.release(missionId, transaction.amountMinorUnits, scopedKey);
      }
      throw error;
    }

    // Execution genuinely completed at this point — allow/deny/escalate and
    // settled/failed executions are all real, final outcomes.
    if (missionId !== undefined) {
      // Records the FULL outcome of this mission-scoped attempt — regardless of
      // verdict — so it is visible in the mission's own history view even when it
      // was denied by capability/policy, escalated, or failed to execute (none of
      // which mission_policy_verdict or mission_transaction_link cover; see
      // src/mission/ledger.ts's doc comment on LEDGER_KIND_MISSION_PIPELINE_OUTCOME).
      // Written unconditionally, before the verdict-specific branches below, since it
      // carries no budget/reservation weight at all — computeMissionSpent and
      // reserve()'s own SQL only ever look at LEDGER_KIND_MISSION_TRANSACTION_LINK,
      // so this entry's kind, content, and ordering relative to the branches below
      // have zero effect on the budget-safety properties already proven for them.
      deps.ledger.append({
        kind: LEDGER_KIND_MISSION_PIPELINE_OUTCOME,
        agentId: agent.agentId,
        principalId: agent.principalId,
        data: {
          missionId,
          amountMinorUnits: transaction.amountMinorUnits,
          category: transaction.category,
          counterparty,
          verdict: result.decision.verdict,
          reason: result.decision.reason,
          policy: result.decision.policy,
          risk: result.decision.risk,
          execution: result.execution,
        },
      });

      if (result.decision.verdict !== "allow") {
        // Denied or escalated by the existing pipeline: nothing executed, no rail was
        // ever called (see executeTransaction's own guarantee) — the reservation
        // never became real spend, so it is released.
        deps.reservations.release(missionId, transaction.amountMinorUnits, scopedKey);
      } else if (result.execution && result.execution.success) {
        // A genuine settlement. The ledger entry is written FIRST, then the
        // reservation is released — in that order, deliberately: if a crash happens
        // between these two statements, the durable, hash-chained record of the real
        // spend already exists, and the reservation is simply left stuck (see
        // src/mission/reservation.ts's reconcileMissionReservations) rather than
        // silently disappearing, which is the safe direction. This is what makes the
        // reserved amount transition to ledger-recorded "settled" without ever being
        // counted in neither bucket (which would let it vanish from budget tracking)
        // — a brief window of being counted in BOTH (an accepted, documented,
        // conservative-only limitation) is the worst case, never the reverse.
        deps.ledger.append({
          kind: LEDGER_KIND_MISSION_TRANSACTION_LINK,
          agentId: agent.agentId,
          principalId: agent.principalId,
          data: { missionId, amountMinorUnits: transaction.amountMinorUnits, success: true },
        });
        deps.reservations.release(missionId, transaction.amountMinorUnits, scopedKey);
      } else {
        // verdict === "allow" but the rail itself failed: nothing was actually spent.
        deps.reservations.release(missionId, transaction.amountMinorUnits, scopedKey);
      }
    }

    const responseBody = { agentId: agent.agentId, ...result };
    tryCompleteWithRetry(deps.idempotency, scopedKey, { requestHash, status: 200, body: responseBody });
    // Whether or not the cache write ultimately succeeded, this caller — the one that
    // actually triggered the real execution — gets the true, accurate result. Never
    // fabricate a failure response for a transaction that genuinely succeeded.
    res.status(200).json(responseBody);
  });

  return router;
}
