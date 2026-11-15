import { Router, type RequestHandler } from "express";
import { verifyTransaction } from "../../capability/authorize.js";
import type { TransactionRequest } from "../../capability/types.js";
import { executeApprovedEscalation } from "../../execution/executeTransaction.js";
import { LEDGER_KIND_MISSION_PIPELINE_OUTCOME, LEDGER_KIND_MISSION_TRANSACTION_LINK } from "../../mission/index.js";
import {
  escalationExecutionKey,
  LEDGER_KIND_ESCALATION_RESOLVED,
  type EscalationRecord,
  type EscalationStatus,
} from "../../state/escalations.js";
import type { RailExecutionResult } from "../../rails/types.js";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import { recheckMissionBeforeRail } from "./transactions.js";

const MAX_REASON_LENGTH = 500;
const STATUSES: ReadonlySet<string> = new Set<EscalationStatus>(["pending", "approved", "rejected"]);

function parseReason(body: unknown): string {
  const reason = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ApiError(400, '"reason" is required: say why you are approving or rejecting this transaction');
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ApiError(400, `"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  }
  return reason.trim();
}

/** The same 404 for "no such escalation" and "someone else's", so ids can't be probed (mirrors requireOwnedMission). */
function requireOwnedEscalation(deps: AppDependencies, escalationId: string, principalId: string): EscalationRecord {
  const esc = deps.escalations.get(escalationId);
  if (!esc || esc.principalId !== principalId) {
    throw new ApiError(404, `Escalation "${escalationId}" not found`);
  }
  return esc;
}

function present(esc: EscalationRecord) {
  return {
    escalationId: esc.escalationId,
    status: esc.status,
    agentId: esc.agentId,
    missionId: esc.missionId,
    counterparty: esc.counterparty,
    transaction: esc.transaction,
    delegatedGoal: esc.delegatedGoal,
    escalationReason: esc.escalationReason,
    risk: esc.risk,
    createdAt: esc.createdAt,
    resolvedBy: esc.resolvedBy,
    resolvedAt: esc.resolvedAt,
    resolutionReason: esc.resolutionReason,
    outcome: esc.outcome,
    outcomeDetail: esc.outcomeDetail,
    outcomeAt: esc.outcomeAt,
  };
}

/**
 * Operator resolution of escalated transactions.
 *
 * Who may resolve: only the principal that owns the agent, authenticated by its API key
 * (requirePrincipal). An agent's capability token is a different credential class and is
 * rejected by that middleware — so an agent can never approve its own escalation. What is
 * NOT enforced is separation between a human "developer" and a human "operator" who share
 * one principal API key: the identity model has a single human credential per principal
 * (see docs/SECURITY_MODEL.md, "Separation of duties").
 *
 * Approval re-runs every safeguard except the risk stage, which the operator's decision
 * replaces: capability re-verification (revocation, expiry, caveats), mission still
 * active, and an atomic budget reservation made at approval time (nothing is held while
 * an escalation is pending). Rejection never reaches a rail.
 */
export function createEscalationsRouter(deps: AppDependencies, requirePrincipal: RequestHandler, requireAgent: RequestHandler): Router {
  const router = Router();

  router.get("/escalations", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const status = req.query.status;
    if (status !== undefined && (typeof status !== "string" || !STATUSES.has(status))) {
      throw new ApiError(400, 'Query parameter "status" must be one of: pending, approved, rejected');
    }
    const escalations = deps.escalations.listByPrincipal(principalId, status as EscalationStatus | undefined);
    res.status(200).json({ escalations: escalations.map(present) });
  });

  router.get("/escalations/:id", requirePrincipal, (req, res) => {
    const esc = requireOwnedEscalation(deps, req.params.id as string, req.principalId!);
    res.status(200).json(present(esc));
  });

  /** What the escalated AGENT may learn: whether its transaction was approved/rejected and how it ended — not who decided. */
  router.get("/transactions/escalations/:id", requireAgent, (req, res) => {
    const agent = req.agent!;
    const esc = deps.escalations.get(req.params.id as string);
    if (!esc || esc.agentId !== agent.agentId) {
      throw new ApiError(404, `Escalation "${req.params.id}" not found`);
    }
    res.status(200).json({
      escalationId: esc.escalationId,
      status: esc.status,
      resolutionReason: esc.resolutionReason,
      resolvedAt: esc.resolvedAt,
      outcome: esc.outcome,
    });
  });

  router.post("/escalations/:id/reject", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const reason = parseReason(req.body);
    const esc = requireOwnedEscalation(deps, req.params.id as string, principalId);

    if (esc.status !== "pending") {
      if (esc.status === "rejected" && esc.resolvedBy === principalId) {
        res.status(200).json({ escalation: present(esc), replayed: true });
        return;
      }
      throw new ApiError(409, `Escalation is already ${esc.status} and can no longer be rejected`);
    }

    if (!deps.escalations.resolve(esc.escalationId, "rejected", principalId, reason)) {
      throw new ApiError(409, "Escalation was resolved by another request first");
    }
    const resolved = deps.escalations.get(esc.escalationId)!;
    deps.ledger.append({
      kind: LEDGER_KIND_ESCALATION_RESOLVED,
      agentId: esc.agentId,
      principalId: esc.principalId,
      data: {
        escalationId: esc.escalationId,
        decision: "reject",
        resolvedBy: principalId,
        resolvedAt: resolved.resolvedAt,
        reason,
        missionId: esc.missionId,
        counterparty: esc.counterparty,
        transaction: esc.transaction,
      },
    });
    res.status(200).json({ escalation: present(resolved) });
  });

  router.post("/escalations/:id/approve", requirePrincipal, async (req, res) => {
    const principalId = req.principalId!;
    const reason = parseReason(req.body);
    const esc = requireOwnedEscalation(deps, req.params.id as string, principalId);

    if (esc.status !== "pending") {
      if (esc.status === "approved" && esc.resolvedBy === principalId) {
        // Idempotent replay of the same decision: report the current state, never execute again.
        res.status(200).json({ escalation: present(esc), replayed: true });
        return;
      }
      throw new ApiError(409, `Escalation is already ${esc.status} and can no longer be approved`);
    }

    const agent = deps.agents.get(esc.agentId);
    if (!agent) throw new ApiError(409, `Agent "${esc.agentId}" no longer exists — this escalation cannot be approved`);
    const transaction = esc.transaction as unknown as TransactionRequest & { purpose: string };
    const missionId = esc.missionId ?? undefined;

    // ---- Preflight: everything below is synchronous, so nothing can change between these
    // checks, the budget reservation, the status change and the rail call. A failure here
    // leaves the escalation PENDING — the operator can still reject it.
    let capability;
    try {
      capability = verifyTransaction(agent.tokenBase64, deps.rootPublicKey, transaction, deps.revocationStore);
    } catch (error) {
      throw new ApiError(409, `Cannot approve: the agent's capability could not be verified (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!capability.allowed) {
      throw new ApiError(409, `Cannot approve: the agent's capability no longer authorizes this transaction — ${capability.reason ?? "denied"}`);
    }
    const missionState = recheckMissionBeforeRail(deps, esc.agentId, missionId);
    if (!missionState.ok) {
      throw new ApiError(409, `Cannot approve: ${missionState.reason}`);
    }

    const executionKey = escalationExecutionKey(esc.escalationId);
    if (missionId !== undefined) {
      const reservation = deps.reservations.reserve(missionId, transaction.amountMinorUnits, executionKey);
      if (reservation.kind === "insufficient_budget") {
        throw new ApiError(409, "Cannot approve: this transaction would now exceed the mission's remaining budget");
      }
      if (reservation.kind === "mission_not_active") {
        throw new ApiError(409, `Cannot approve: the mission is not active (status: "${reservation.status}")`);
      }
      if (reservation.kind === "mission_not_found") {
        throw new ApiError(409, "Cannot approve: the mission no longer exists");
      }
    }
    const releaseReservation = (): void => {
      if (missionId !== undefined) deps.reservations.release(missionId, transaction.amountMinorUnits, executionKey);
    };

    // ---- The decision. Exactly one caller can move pending -> approved.
    if (!deps.escalations.resolve(esc.escalationId, "approved", principalId, reason)) {
      releaseReservation();
      throw new ApiError(409, "Escalation was resolved by another request first");
    }
    const resolved = deps.escalations.get(esc.escalationId)!;

    // From here the escalation is approved. If we fail before the rail is reached, record
    // that nothing happened; if we fail after, the outcome is unknowable (indeterminate).
    let railReached = false;
    try {
      deps.ledger.append({
        kind: LEDGER_KIND_ESCALATION_RESOLVED,
        agentId: esc.agentId,
        principalId: esc.principalId,
        data: {
          escalationId: esc.escalationId,
          decision: "approve",
          resolvedBy: principalId,
          resolvedAt: resolved.resolvedAt,
          reason,
          missionId: esc.missionId,
          counterparty: esc.counterparty,
          transaction: esc.transaction,
        },
      });

      const pending = executeApprovedEscalation(
        {
          tokenBase64: agent.tokenBase64,
          rootPublicKey: deps.rootPublicKey,
          agentId: esc.agentId,
          principalId: esc.principalId,
          delegatedGoal: esc.delegatedGoal,
          counterparty: esc.counterparty,
          transaction,
          idempotencyKey: executionKey,
          escalationId: esc.escalationId,
          approvedBy: principalId,
        },
        {
          revocationStore: deps.revocationStore,
          ledger: deps.ledger,
          intentJudge: deps.intentJudge,
          rails: deps.rails,
          // The very same last-moment mission guard the normal path uses.
          preExecutionGuard: () => recheckMissionBeforeRail(deps, esc.agentId, missionId),
          baselineWindow: deps.baselineWindow,
          judgeTimeoutMs: deps.judgeTimeoutMs,
        }
      );
      railReached = true; // executeApprovedEscalation reaches the rail (or withdraws) synchronously, before its first await
      const result = await pending;

      if (result.blocked) {
        railReached = false;
        releaseReservation();
        deps.escalations.recordOutcome(esc.escalationId, "blocked", { reason: result.reason, stage: result.stage });
        res.status(409).json({
          error: result.reason,
          escalation: present(deps.escalations.get(esc.escalationId)!),
        });
        return;
      }

      const execution: RailExecutionResult = result.execution;
      if (missionId !== undefined) {
        deps.ledger.append({
          kind: LEDGER_KIND_MISSION_PIPELINE_OUTCOME,
          agentId: esc.agentId,
          principalId: esc.principalId,
          data: {
            missionId,
            amountMinorUnits: transaction.amountMinorUnits,
            category: transaction.category,
            counterparty: esc.counterparty,
            verdict: "allow",
            reason: `Escalation approved by operator: ${reason}`,
            source: "operator_approval",
            escalationId: esc.escalationId,
            execution,
          },
        });
        if (execution.success) {
          // Same discipline as the normal path: the durable spend record first, then the reservation is released.
          deps.ledger.append({
            kind: LEDGER_KIND_MISSION_TRANSACTION_LINK,
            agentId: esc.agentId,
            principalId: esc.principalId,
            data: { missionId, amountMinorUnits: transaction.amountMinorUnits, success: true },
          });
        }
      }
      releaseReservation();
      deps.escalations.recordOutcome(
        esc.escalationId,
        execution.success ? "settled" : "failed",
        { rail: execution.rail, reference: execution.reference, success: execution.success, error: execution.error ?? null }
      );
      res.status(200).json({ escalation: present(deps.escalations.get(esc.escalationId)!), execution });
    } catch (error) {
      if (!railReached) {
        // Nothing reached a payment rail. Give the capacity back and say so.
        try {
          releaseReservation();
          deps.escalations.recordOutcome(esc.escalationId, "error", { error: error instanceof Error ? error.message : String(error) });
        } catch {
          /* best effort — startup reconciliation resolves the rest */
        }
      } else {
        // The rail may have been reached. Never retry, never release: fail closed.
        deps.escalations.recordOutcome(esc.escalationId, "indeterminate", {
          error: error instanceof Error ? error.message : String(error),
          note: "Bookkeeping failed after the rail may have been called; the reservation is intentionally kept.",
        });
      }
      throw error;
    }
  });

  return router;
}
