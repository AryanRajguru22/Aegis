import { verifyIntegrity, type IntegrityResult } from "./integrity.js";
import { reconstructMissionBudgets, type MissionBudgetResult } from "./missionBudget.js";
import { analyzeSettlementAttribution, type SettlementAttributionResult } from "./settlementAttribution.js";
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
  /**
   * Policy-compliance findings about settlements (the mission-required rule, audit
   * finding F1). Kept strictly separate from `integrity`: a finding here is NOT
   * evidence of tampering. null — not an empty result — when integrity failed,
   * because findings derived from an untrusted chain prove nothing.
   */
  settlementAttribution: SettlementAttributionResult | null;
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

  const settlementAttribution = integrity.valid ? analyzeSettlementAttribution(artifact.entries) : null;

  const overallVerified =
    integrity.valid &&
    missions.every((m) => m.evidenceSufficient && m.budgetInvariantHolds === true) &&
    settlementAttribution !== null &&
    settlementAttribution.ambiguous === 0 &&
    settlementAttribution.bindingViolations.legacy === 0 &&
    settlementAttribution.bindingViolations.postEpoch === 0;

  return {
    schemaVersion: artifact.schemaVersion,
    integrity: {
      valid: integrity.valid,
      entriesChecked: integrity.entriesChecked,
      brokenAtSeq: integrity.failure?.atSeq ?? null,
      reason: integrity.failure?.reason ?? null,
    },
    missions,
    settlementAttribution,
    overallVerified,
  };
}

function fmtMoney(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

const MAX_LISTED_FINDINGS = 10;

function renderAttributionSection(a: SettlementAttributionResult): string[] {
  const lines: string[] = [];
  const violations = a.bindingViolations.legacy + a.bindingViolations.postEpoch;
  lines.push("SETTLEMENT ATTRIBUTION (mission-required rule)");
  lines.push(`  Successful settlements: ${a.successfulSettlements}`);
  lines.push(`  ✓ attributed to a valid mission: ${a.attributedToMission}`);
  lines.push(`  ✓ permitted mission-less (agent had no mission at the time): ${a.permittedMissionless}`);
  if (a.bindingViolations.postEpoch > 0) {
    lines.push(`✗ ${a.bindingViolations.postEpoch} unattributed settlement(s) by a mission-bound agent AFTER the policy epoch (entry #${a.epochMarkerSeq}) — the rule was in force and was not enforced`);
  }
  if (a.bindingViolations.legacy > 0) {
    lines.push(
      a.epochMarkerSeq === null
        ? `! HISTORICAL: ${a.bindingViolations.legacy} unattributed settlement(s) by a mission-bound agent — this ledger records no policy epoch, so they cannot be shown to postdate the fix`
        : `! HISTORICAL: ${a.bindingViolations.legacy} unattributed settlement(s) by a mission-bound agent BEFORE the policy epoch (entry #${a.epochMarkerSeq})`
    );
  }
  if (a.ambiguous > 0) {
    lines.push(`? ${a.ambiguous} settlement(s) whose attribution cannot be established from the ledger`);
  }
  if (violations > 0) {
    lines.push("  Amount of unattributed settlements: amount cannot be determined");
    lines.push(`    (${a.amountNote})`);
  }
  if (a.epochMarkerSeq === null && violations > 0) {
    lines.push("  Policy epoch: not recorded in this ledger");
  }
  for (const finding of a.findings.slice(0, MAX_LISTED_FINDINGS)) {
    lines.push(`  - entry #${finding.seq} (${finding.agentId}): ${finding.reason}`);
  }
  if (a.findings.length > MAX_LISTED_FINDINGS) {
    lines.push(`  … and ${a.findings.length - MAX_LISTED_FINDINGS} more (use --json for the full list)`);
  }
  if (a.missionLinksWithoutExecution > 0) {
    lines.push(`  note: ${a.missionLinksWithoutExecution} mission_transaction_link entr${a.missionLinksWithoutExecution === 1 ? "y has" : "ies have"} no matching execution_result (over-states spend; informational)`);
  }
  if (violations > 0 || a.ambiguous > 0) {
    lines.push("  These are policy-compliance findings on a cryptographically intact ledger — not tampering.");
  }
  return lines;
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

  const attribution = report.settlementAttribution;
  if (attribution) {
    lines.push(...renderAttributionSection(attribution));
    lines.push("");
  }
  const postEpochViolations = attribution?.bindingViolations.postEpoch ?? 0;
  const legacyViolations = attribution?.bindingViolations.legacy ?? 0;
  const ambiguousSettlements = attribution?.ambiguous ?? 0;
  const budgetViolated = report.missions.some((m) => m.budgetInvariantHolds === false);

  if (anyInsufficient) {
    lines.push("VERDICT: INCOMPLETE (see INSUFFICIENT EVIDENCE above — not claimed as pass or fail)");
  } else if (postEpochViolations > 0 || budgetViolated) {
    lines.push("VERDICT: NOT VERIFIED");
  } else if (ambiguousSettlements > 0) {
    lines.push("VERDICT: INCOMPLETE (settlement attribution is ambiguous — see above; not claimed as pass or fail)");
  } else if (legacyViolations > 0) {
    lines.push("VERDICT: INTEGRITY VERIFIED — HISTORICAL POLICY FINDINGS (see above; not tampering, and not claimed as compliant)");
  } else if (report.overallVerified) {
    lines.push("✓ ALL INVARIANTS VERIFIED");
    lines.push("");
    lines.push("VERDICT: TRUSTED");
  } else {
    lines.push("VERDICT: NOT VERIFIED");
  }

  return lines.join("\n");
}

/**
 * 0 = verified, 1 = tamper / budget violation / mission-binding violation after the
 * policy epoch, 2 = malformed or insufficient evidence (incl. ambiguous settlement
 * attribution), 3 = integrity verified but HISTORICAL mission-binding findings only
 * (never reported as tampering, never reported as clean).
 */
export function exitCodeForReport(report: VerificationReport): 0 | 1 | 2 | 3 {
  if (!report.integrity.valid) return 1;
  const attribution = report.settlementAttribution;
  if (attribution && attribution.bindingViolations.postEpoch > 0) return 1;
  if (report.missions.some((m) => !m.evidenceSufficient)) return 2;
  if (report.missions.some((m) => m.budgetInvariantHolds === false)) return 1;
  if (attribution && attribution.ambiguous > 0) return 2;
  if (attribution && attribution.bindingViolations.legacy > 0) return 3;
  return 0;
}
