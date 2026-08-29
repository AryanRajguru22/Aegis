import { Router, type RequestHandler } from "express";
import type { Caveats } from "../../capability/types.js";
import type { MissionRecord } from "../../state/missions.js";
import { computeMissionSpent, remainingMissionBudget, validateMissionAgainstToken } from "../../mission/index.js";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import { requireOwnedAgent, requireOwnedMission } from "../auth.js";
import { parseCreateMissionBody } from "../validation.js";

const LEDGER_KIND_MISSION_CREATED = "mission_created";
const LEDGER_KIND_MISSION_CANCELLED = "mission_cancelled";

/**
 * Enriches a stored MissionRecord with the two numbers a principal actually wants to
 * see — spent and remaining — both derived live from the ledger via the exact same
 * pure functions (src/mission/ledger.ts) the transaction route itself uses to gate
 * spend, never a separately-tracked counter that could drift from what actually
 * happened. `reservedMinorUnits` is returned as-is from the mission record — it is
 * already the live, atomically-maintained figure (src/mission/reservation.ts).
 */
function toPublicMission(deps: AppDependencies, mission: MissionRecord) {
  const spentMinorUnits = computeMissionSpent(deps.ledger.listByAgent(mission.agentId), mission.missionId);
  const remainingMinorUnits = remainingMissionBudget(mission, spentMinorUnits) - mission.reservedMinorUnits;
  return {
    missionId: mission.missionId,
    agentId: mission.agentId,
    principalId: mission.principalId,
    goal: mission.goal,
    budgetMinorUnits: mission.budgetMinorUnits,
    currency: mission.currency,
    allowedCategories: mission.allowedCategories,
    approvedCounterparties: mission.approvedCounterparties,
    status: mission.status,
    expiresAt: mission.expiresAt,
    createdAt: mission.createdAt,
    reservedMinorUnits: mission.reservedMinorUnits,
    spentMinorUnits,
    remainingMinorUnits,
  };
}

export function createMissionsRouter(deps: AppDependencies, requirePrincipal: RequestHandler): Router {
  const router = Router();

  router.post("/missions", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const body = parseCreateMissionBody(req.body);
    const agent = requireOwnedAgent(deps.agents, body.agentId, principalId);

    try {
      validateMissionAgainstToken(body, agent.caveats as unknown as Caveats);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : String(error));
    }

    let mission: MissionRecord;
    try {
      mission = deps.missions.register({
        missionId: body.missionId,
        agentId: body.agentId,
        principalId,
        goal: body.goal,
        budgetMinorUnits: body.budgetMinorUnits,
        currency: body.currency,
        allowedCategories: body.allowedCategories,
        approvedCounterparties: body.approvedCounterparties,
        expiresAt: body.expiresAt,
      });
    } catch (error) {
      throw new ApiError(409, error instanceof Error ? error.message : String(error));
    }

    deps.ledger.append({
      kind: LEDGER_KIND_MISSION_CREATED,
      agentId: body.agentId,
      principalId,
      data: {
        missionId: body.missionId,
        goal: body.goal,
        budgetMinorUnits: body.budgetMinorUnits,
        currency: body.currency,
        allowedCategories: body.allowedCategories,
        approvedCounterparties: body.approvedCounterparties,
        expiresAt: body.expiresAt,
      },
    });

    res.status(201).json(toPublicMission(deps, mission));
  });

  router.get("/missions", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    res.status(200).json({ missions: deps.missions.listByPrincipal(principalId).map((m) => toPublicMission(deps, m)) });
  });

  router.get("/agents/:agentId/missions", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const agent = requireOwnedAgent(deps.agents, req.params.agentId as string, principalId);
    res.status(200).json({ missions: deps.missions.listByAgent(agent.agentId).map((m) => toPublicMission(deps, m)) });
  });

  router.get("/missions/:id", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const mission = requireOwnedMission(deps.missions, req.params.id as string, principalId);
    res.status(200).json(toPublicMission(deps, mission));
  });

  router.post("/missions/:id/cancel", requirePrincipal, (req, res) => {
    const principalId = req.principalId!;
    const missionId = req.params.id as string;
    const mission = requireOwnedMission(deps.missions, missionId, principalId);

    if (mission.status !== "active") {
      throw new ApiError(409, `Mission "${missionId}" is not active (status: "${mission.status}") and cannot be cancelled`);
    }

    const cancelled = deps.missions.close(missionId, "cancelled");

    deps.ledger.append({
      kind: LEDGER_KIND_MISSION_CANCELLED,
      agentId: mission.agentId,
      principalId,
      data: { missionId },
    });

    res.status(200).json(toPublicMission(deps, cancelled));
  });

  return router;
}
