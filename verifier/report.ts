import { verifyIntegrity, type IntegrityResult } from "./integrity.js";
import { reconstructMissionBudgets, type MissionBudgetResult } from "./missionBudget.js";
import type { LedgerExportArtifact } from "./schema.js";

export interface VerificationReport {
  schemaVersion: string;
  integrity: {
    valid: boolean;
    entriesChecked: number;
    brokenAtSeq: number | null;
    reason: string | null;
  };
  /**
   * Only populated when integrity.valid is true. A mission-budget number derived
   * from an already-broken chain would not be a proof of anything, so this is left
   * empty rather than presented as if it were meaningful.
   */
  missions: MissionBudgetResult[];
  overallVerified: boolean;
}

/**
 * Combines Proof 1 and Proof 2 into the final result. This is the ONLY place the two
 * are wired together — verifier/integrity.ts and verifier/missionBudget.ts remain
 * independent, single-purpose modules. Mission budget results are only ever computed
 * (and only ever meaningful) once integrity has already passed — a mission "PASS"
 * shown alongside a broken chain would be exactly the kind of overclaim this whole
 * tool exists to avoid.
 */
export function buildReport(artifact: LedgerExportArtifact): VerificationReport {
  const integrity: IntegrityResult = verifyIntegrity(artifact.publicKeyHex, artifact.entries);

  const missions = integrity.valid ? reconstructMissionBudgets(artifact.entries) : [];

  const overallVerified = integrity.valid && missions.every((m) => m.evidenceSufficient && m.budgetInvariantHolds === true);

  return {
    schemaVersion: artifact.schemaVersion,
    integrity: {
      valid: integrity.valid,
      entriesChecked: integrity.entriesChecked,
      brokenAtSeq: integrity.failure?.atSeq ?? null,
      reason: integrity.failure?.reason ?? null,
    },
    missions,
    overallVerified,
  };
}

function fmtMoney(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

/** Renders the ~10-second, judge-facing text report. */
export function renderHumanReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push("AEGIS INDEPENDENT VERIFIER");
  lines.push("(offline — does not call Aegis's server, API, or dashboard)");
  lines.push("");
  lines.push("LEDGER INTEGRITY");

  if (report.integrity.valid) {
    lines.push(`✓ SEQUENCE CONTINUOUS (${report.integrity.entriesChecked} entries)`);
    lines.push("✓ HASH CHAIN VALID");
    lines.push("✓ SIGNATURE VALID");
  } else {
    lines.push("✗ HASH CHAIN INVALID");
    lines.push(`  First detected corruption: entry #${report.integrity.brokenAtSeq}`);
    lines.push(`  Reason: ${report.integrity.reason}`);
  }
  lines.push("");

  if (!report.integrity.valid) {
    lines.push("MISSION BUDGETS");
    lines.push("  (skipped — mission results depend on ledger integrity, which failed above)");
    lines.push("");
    lines.push("VERDICT: NOT VERIFIED");
    return lines.join("\n");
  }

  lines.push("MISSION BUDGETS");
  if (report.missions.length === 0) {
    lines.push("  (no missions found in this artifact)");
  }
  let anyInsufficient = false;
  for (const mission of report.missions) {
    if (!mission.evidenceSufficient) {
      anyInsufficient = true;
      lines.push(`? ${mission.missionId} — INSUFFICIENT EVIDENCE`);
      lines.push(`  ${mission.reason}`);
      continue;
    }
    const mark = mission.budgetInvariantHolds ? "✓" : "✗";
    lines.push(`${mark} ${mission.missionId}`);
    lines.push(`  Budget: ${fmtMoney(mission.budgetMinorUnits!)}`);
    lines.push(`  Max committed spend: ${fmtMoney(mission.maximumObservedSpendMinorUnits)}`);
    lines.push(`  Overspend: ${fmtMoney(mission.overspendMinorUnits!)}`);
  }
  lines.push("");

  if (anyInsufficient) {
    lines.push("VERDICT: INCOMPLETE (see INSUFFICIENT EVIDENCE above — not claimed as pass or fail)");
  } else if (report.overallVerified) {
    lines.push("✓ ALL INVARIANTS VERIFIED");
    lines.push("");
    lines.push("VERDICT: TRUSTED");
  } else {
    lines.push("VERDICT: NOT VERIFIED");
  }

  return lines.join("\n");
}

/** 0 = verified, 1 = tamper/violation detected, 2 = malformed/insufficient evidence. */
export function exitCodeForReport(report: VerificationReport): 0 | 1 | 2 {
  if (!report.integrity.valid) return 1;
  if (report.missions.some((m) => !m.evidenceSufficient)) return 2;
  if (report.missions.some((m) => m.budgetInvariantHolds === false)) return 1;
  return 0;
}
