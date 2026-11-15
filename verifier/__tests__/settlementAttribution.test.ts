import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildReport, exitCodeForReport, renderHumanReport, type VerificationReport } from "../report.js";
import type { LedgerExportArtifact } from "../schema.js";
import { buildSignedArtifact, ev, type RawEvent } from "./chainBuilder.js";

/**
 * F1 verifier gap: the mission-required rule (API commit f3dbf21) is enforced at
 * request time, but the independent verifier used to look only at
 * `mission_transaction_link` entries — a settlement that never produced one (a
 * mission-less spend) was invisible to it. These tests drive the verifier's public
 * surface (buildReport / exitCodeForReport / renderHumanReport) over real, validly
 * signed synthetic ledgers, and pin two things apart that must never be conflated:
 * cryptographic integrity failures (exit 1, "NOT VERIFIED") and policy-compliance
 * findings on an intact ledger.
 */

interface Finding {
  seq: number;
  agentId: string;
  classification: "legacy_violation" | "post_epoch_violation" | "ambiguous";
  reason: string;
}
interface Attribution {
  successfulSettlements: number;
  attributedToMission: number;
  permittedMissionless: number;
  ambiguous: number;
  bindingViolations: { legacy: number; postEpoch: number };
  epochMarkerSeq: number | null;
  amountMinorUnits: null;
  amountNote: string;
  missionLinksWithoutExecution: number;
  findings: Finding[];
}

function run(events: RawEvent[]): { artifact: LedgerExportArtifact; report: VerificationReport; att: Attribution } {
  const artifact = buildSignedArtifact(events);
  const report = buildReport(artifact);
  const att = (report as unknown as { settlementAttribution: Attribution | null }).settlementAttribution as Attribution;
  return { artifact, report, att };
}

describe("settlement attribution — compliant ledgers stay clean (backwards compatible)", () => {
  test("a valid mission-linked settlement is attributed: no findings, exit 0, TRUSTED", () => {
    const { report, att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ...ev.missionSettlement("a1", "ref-1", "m-1", 3_800)]);
    assert.equal(report.integrity.valid, true);
    assert.equal(att.successfulSettlements, 1);
    assert.equal(att.attributedToMission, 1);
    assert.equal(att.bindingViolations.legacy + att.bindingViolations.postEpoch, 0);
    assert.equal(att.ambiguous, 0);
    assert.equal(report.overallVerified, true);
    assert.equal(exitCodeForReport(report), 0);
    assert.match(renderHumanReport(report), /VERDICT: TRUSTED/);
  });

  test("a mission-less settlement by an agent that has NEVER been assigned a mission is permitted token-only authority, not a finding", () => {
    const { report, att } = run([ev.agent("a1"), ev.exec("a1", "ref-1"), ev.exec("a1", "ref-2")]);
    assert.equal(att.successfulSettlements, 2);
    assert.equal(att.permittedMissionless, 2);
    assert.equal(att.bindingViolations.legacy + att.bindingViolations.postEpoch, 0);
    assert.equal(exitCodeForReport(report), 0);
  });

  test("an agent's mission-less settlement BEFORE its first mission is permitted; the same agent's later one is a violation (sticky)", () => {
    const { att } = run([ev.agent("a1"), ev.exec("a1", "before"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "after")]);
    assert.equal(att.permittedMissionless, 1);
    assert.equal(att.bindingViolations.legacy, 1);
    assert.equal(att.findings.length, 1);
    assert.equal(att.findings[0]!.classification, "legacy_violation");
  });

  test("failed and denied attempts are not settlements", () => {
    const { att } = run([
      ev.agent("a1"),
      ev.missionCreated("a1", "m-1"),
      ev.exec("a1", "", false),
      { kind: "decision", agentId: "a1", principalId: "p-1", data: { verdict: "deny" } },
    ]);
    assert.equal(att.successfulSettlements, 0);
    assert.equal(att.findings.length, 0);
  });

  test("two interleaved mission settlements (concurrent requests) are each attributed by rail reference, not by adjacency", () => {
    const { report, att } = run([
      ev.agent("a1"),
      ev.missionCreated("a1", "m-1"),
      ev.missionCreated("a1", "m-2"),
      ev.exec("a1", "ref-A"),
      ev.exec("a1", "ref-B"),
      ev.outcome("a1", "ref-B", "m-2", 500),
      ev.link("a1", "m-2", 500),
      ev.outcome("a1", "ref-A", "m-1", 700),
      ev.link("a1", "m-1", 700),
    ]);
    assert.equal(att.successfulSettlements, 2);
    assert.equal(att.attributedToMission, 2);
    assert.equal(att.findings.length, 0);
    assert.equal(exitCodeForReport(report), 0);
  });

  test("a link with no execution_result behind it (over-states spend) is reported informationally and does not change the verdict", () => {
    const { report, att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.link("a1", "m-1", 100)]);
    assert.equal(att.missionLinksWithoutExecution, 1);
    assert.equal(exitCodeForReport(report), 0);
  });
});

describe("settlement attribution — legacy ledgers (no policy-epoch marker): historical finding, never tampering", () => {
  const legacy = () => [ev.agent("a1"), ev.missionCreated("a1", "m-1", 40_000), ...ev.missionSettlement("a1", "ref-1", "m-1", 38_000), ev.exec("a1", "ref-2")];

  test("a mission-less settlement by a mission-bound agent is a legacy violation: integrity still valid, exit 3, not 'TRUSTED'", () => {
    const { report, att } = run(legacy());
    assert.equal(report.integrity.valid, true, "the chain is intact — this is NOT tampering");
    assert.equal(att.bindingViolations.legacy, 1);
    assert.equal(att.bindingViolations.postEpoch, 0);
    assert.equal(att.epochMarkerSeq, null);
    assert.equal(report.overallVerified, false);
    assert.equal(exitCodeForReport(report), 3);
    const text = renderHumanReport(report);
    assert.doesNotMatch(text, /VERDICT: TRUSTED/);
    assert.doesNotMatch(text, /HASH CHAIN INVALID/);
    assert.match(text, /not tampering/i);
    assert.match(text, /HISTORICAL/);
  });

  test("the unattributed amount is NOT claimed: it is null with an explicit note (execution_result carries no amount)", () => {
    const { att } = run(legacy());
    assert.equal(att.amountMinorUnits, null);
    assert.match(att.amountNote, /cannot be determined/i);
    assert.doesNotMatch(renderHumanReport(run(legacy()).report), /unattributed.*\$\d/i, "no dollar figure may be attached to unattributed settlements");
  });

  test("the human report states the unattributed count and that the amount cannot be determined", () => {
    const text = renderHumanReport(run(legacy()).report);
    assert.match(text, /1 unattributed/i);
    assert.match(text, /amount cannot be determined/i);
  });
});

describe("settlement attribution — explicit policy-epoch marker", () => {
  test("a bound agent's mission-less settlement AFTER the marker is a post-epoch violation: exit 1", () => {
    const { report, att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.epochMarker(), ev.exec("a1", "ref-1")]);
    assert.equal(att.epochMarkerSeq, 3);
    assert.equal(att.bindingViolations.postEpoch, 1);
    assert.equal(att.bindingViolations.legacy, 0);
    assert.equal(att.findings[0]!.classification, "post_epoch_violation");
    assert.equal(report.integrity.valid, true);
    assert.equal(exitCodeForReport(report), 1);
  });

  test("violations before the marker stay legacy; violations after it are post-epoch; they are counted separately", () => {
    const { att, report } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "old"), ev.epochMarker(), ev.exec("a1", "new")]);
    assert.equal(att.bindingViolations.legacy, 1);
    assert.equal(att.bindingViolations.postEpoch, 1);
    assert.equal(exitCodeForReport(report), 1, "any post-epoch violation dominates");
  });

  test("with the marker present and only pre-marker violations the result is still the historical exit 3", () => {
    const { report } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "old"), ev.epochMarker()]);
    assert.equal(exitCodeForReport(report), 3);
  });

  test("a marker for a different policy, or with malformed data, is ignored", () => {
    for (const marker of [ev.epochMarker({ policy: "something-else" }), ev.epochMarker({ policy: 42 }), { ...ev.epochMarker(), data: null }]) {
      const { att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), marker, ev.exec("a1", "x")]);
      assert.equal(att.epochMarkerSeq, null);
      assert.equal(att.bindingViolations.legacy, 1);
      assert.equal(att.bindingViolations.postEpoch, 0);
    }
  });

  test("if several valid markers exist, the earliest one is the boundary", () => {
    const { att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.epochMarker(), ev.exec("a1", "r1"), ev.epochMarker(), ev.exec("a1", "r2")]);
    assert.equal(att.epochMarkerSeq, 3);
    assert.equal(att.bindingViolations.postEpoch, 2);
  });

  test("mission-attributed and permitted settlements after the marker are not violations", () => {
    const { report, att } = run([
      ev.agent("a1"),
      ev.agent("a2"),
      ev.epochMarker(),
      ev.exec("a2", "free"),
      ev.missionCreated("a1", "m-1"),
      ...ev.missionSettlement("a1", "ref-1", "m-1", 100),
    ]);
    assert.equal(att.bindingViolations.postEpoch, 0);
    assert.equal(exitCodeForReport(report), 0);
  });
});

describe("settlement attribution — mission validity and ambiguous / incomplete histories", () => {
  test("a settlement whose link names a mission created for a DIFFERENT agent is not attributed: ambiguous, never silently passed", () => {
    const { att, report } = run([ev.agent("a1"), ev.agent("a2"), ev.missionCreated("a2", "m-other"), ...ev.missionSettlement("a1", "ref-1", "m-other", 100)]);
    assert.equal(att.attributedToMission, 0);
    assert.equal(att.ambiguous, 1);
    assert.equal(exitCodeForReport(report), 2);
  });

  test("a settlement attributed to a mission with no mission_created evidence at all is ambiguous", () => {
    const { att } = run([ev.agent("a1"), ...ev.missionSettlement("a1", "ref-1", "ghost", 100)]);
    assert.equal(att.attributedToMission, 0);
    assert.equal(att.ambiguous, 1);
  });

  test("a mission_created that appears AFTER the settlement does not retroactively validate it", () => {
    const { att } = run([ev.agent("a1"), ...ev.missionSettlement("a1", "ref-1", "m-1", 100), ev.missionCreated("a1", "m-1")]);
    assert.equal(att.attributedToMission, 0);
  });

  test("an outcome and settlement with NO budget link (the documented crash window) is ambiguous: real spend may be missing from the budget proof", () => {
    const { att, report } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "ref-1"), ev.outcome("a1", "ref-1", "m-1", 100)]);
    assert.equal(att.ambiguous, 1);
    assert.equal(att.findings[0]!.classification, "ambiguous");
    assert.equal(exitCodeForReport(report), 2);
  });

  test("duplicate rail references make every involved settlement ambiguous (identity cannot be established)", () => {
    const { att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ...ev.missionSettlement("a1", "dup", "m-1", 100), ev.exec("a1", "dup")]);
    assert.equal(att.ambiguous, 2);
    assert.equal(att.attributedToMission, 0);
  });

  test("an older-format history (execution_result then a later link, no pipeline outcome) is ambiguous, not a proven violation", () => {
    const { att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "ref-1"), ev.link("a1", "m-1", 100)]);
    assert.equal(att.ambiguous, 1);
    assert.equal(att.bindingViolations.legacy, 0);
  });

  test("an outcome/link for a different agent's rail reference does not attribute this agent's settlement", () => {
    const { att } = run([
      ev.agent("a1"),
      ev.agent("a2"),
      ev.missionCreated("a1", "m-1"),
      ev.missionCreated("a2", "m-2"),
      ev.exec("a1", "shared-ref"),
      ev.outcome("a2", "shared-ref", "m-2", 100),
      ev.link("a2", "m-2", 100),
    ]);
    assert.equal(att.attributedToMission, 0);
    assert.equal(att.bindingViolations.legacy, 1, "a1 is bound and its settlement has no attribution of its own");
  });

  test("a malformed success flag or missing reference never crashes the analysis", () => {
    const { att } = run([
      ev.agent("a1"),
      ev.missionCreated("a1", "m-1"),
      { kind: "execution_result", agentId: "a1", principalId: "p-1", data: null },
      { kind: "execution_result", agentId: "a1", principalId: "p-1", data: { success: "yes" } },
      { kind: "execution_result", agentId: "a1", principalId: "p-1", data: { success: true } },
    ]);
    assert.equal(att.successfulSettlements, 1);
    assert.equal(att.bindingViolations.legacy, 1);
  });
});

describe("settlement attribution — policy findings never mask cryptographic failures", () => {
  const legacyEvents = () => [ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "ref-1")];

  test("control: the untampered legacy ledger is integrity-valid with a historical finding (exit 3)", () => {
    const { report } = run(legacyEvents());
    assert.equal(report.integrity.valid, true);
    assert.equal(exitCodeForReport(report), 3);
  });

  test("the SAME ledger with one entry's data altered fails integrity: exit 1, NOT VERIFIED, and no policy section is presented as a result", () => {
    const { artifact } = run(legacyEvents());
    const tampered: LedgerExportArtifact = JSON.parse(JSON.stringify(artifact));
    (tampered.entries[2]!.data as Record<string, unknown>).reference = "forged";
    const report = buildReport(tampered);
    assert.equal(report.integrity.valid, false);
    assert.equal(exitCodeForReport(report), 1);
    assert.equal((report as unknown as { settlementAttribution: unknown }).settlementAttribution, null);
    const text = renderHumanReport(report);
    assert.match(text, /HASH CHAIN INVALID/);
    assert.match(text, /VERDICT: NOT VERIFIED/);
    assert.doesNotMatch(text, /HISTORICAL/);
  });

  test("a forged signature on an otherwise policy-clean ledger is still exit 1", () => {
    const { artifact } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ...ev.missionSettlement("a1", "ref-1", "m-1", 100)]);
    const tampered: LedgerExportArtifact = JSON.parse(JSON.stringify(artifact));
    const sig = tampered.entries[1]!.signature;
    tampered.entries[1]!.signature = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    const report = buildReport(tampered);
    assert.equal(report.integrity.valid, false);
    assert.equal(exitCodeForReport(report), 1);
  });

  test("deleting the mission-binding evidence (an interior entry) is a chain failure, not a quietly clean policy result", () => {
    const { artifact } = run(legacyEvents());
    const tampered: LedgerExportArtifact = JSON.parse(JSON.stringify(artifact));
    tampered.entries.splice(1, 1); // remove the mission_created entry that made the agent bound
    const report = buildReport(tampered);
    assert.equal(report.integrity.valid, false);
    assert.equal(exitCodeForReport(report), 1);
  });
});

describe("settlement attribution — end to end through the real CLI", () => {
  const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

  function runCli(artifact: LedgerExportArtifact, extraArgs: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "aegis-attribution-test-"));
    try {
      const path = join(dir, "artifact.json");
      writeFileSync(path, JSON.stringify(artifact));
      return spawnSync(process.execPath, [CLI_PATH, path, ...extraArgs], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("legacy ledger with a mission-less settlement by a bound agent: exit 3, historical wording, integrity lines still green", () => {
    const { artifact } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "ref-1")]);
    const result = runCli(artifact);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /✓ HASH CHAIN VALID/);
    assert.match(result.stdout, /HISTORICAL/);
    assert.doesNotMatch(result.stdout, /VERDICT: TRUSTED/);
  });

  test("--json exposes the structured attribution result, with a null amount", () => {
    const { artifact } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "ref-1")]);
    const parsed = JSON.parse(runCli(artifact, ["--json"]).stdout);
    assert.equal(parsed.settlementAttribution.bindingViolations.legacy, 1);
    assert.equal(parsed.settlementAttribution.amountMinorUnits, null);
    assert.equal(parsed.integrity.valid, true);
  });

  test("post-epoch violation: exit 1; tampered legacy ledger: exit 1 with the integrity failure reported", () => {
    const post = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.epochMarker(), ev.exec("a1", "ref-1")]);
    assert.equal(runCli(post.artifact).status, 1);

    const legacy = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ev.exec("a1", "ref-1")]);
    const tampered: LedgerExportArtifact = JSON.parse(JSON.stringify(legacy.artifact));
    (tampered.entries[1]!.data as Record<string, unknown>).budgetMinorUnits = 1;
    const result = runCli(tampered);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /HASH CHAIN INVALID/);
    assert.doesNotMatch(result.stdout, /HISTORICAL/);
  });
});

describe("settlement attribution — operator-approved escalations settle exactly like any other settlement", () => {
  const P = "acme-corp";
  const opened = (agentId: string, escalationId: string): RawEvent => ({ kind: "escalation_opened", agentId, principalId: P, data: { escalationId, reason: "ambiguous" } });
  const resolved = (agentId: string, escalationId: string, decision: "approve" | "reject"): RawEvent => ({
    kind: "escalation_resolved",
    agentId,
    principalId: P,
    data: { escalationId, decision, resolvedBy: P, reason: "checked" },
  });
  /** Exactly what the API writes for an approved, mission-scoped escalation: execution_result (+ escalationId), pipeline outcome (source operator_approval), link. */
  const approvedSettlement = (agentId: string, escalationId: string, reference: string, missionId: string, amount: number): RawEvent[] => {
    const [exec, outcome, link] = ev.missionSettlement(agentId, reference, missionId, amount) as [RawEvent, RawEvent, RawEvent];
    return [
      opened(agentId, escalationId),
      resolved(agentId, escalationId, "approve"),
      { ...exec, data: { ...(exec.data as object), escalationId } },
      { ...outcome, data: { ...(outcome.data as object), source: "operator_approval", escalationId } },
      link,
    ];
  };

  test("an approved, mission-scoped escalation's settlement is attributed to its mission with no ambiguity: the verifier needs no special case", () => {
    const { report, att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), ...approvedSettlement("a1", "esc_1", "ref-1", "m-1", 3_800)]);
    assert.equal(report.integrity.valid, true);
    assert.equal(att.successfulSettlements, 1);
    assert.equal(att.attributedToMission, 1);
    assert.equal(att.ambiguous, 0);
    assert.equal(att.bindingViolations.legacy + att.bindingViolations.postEpoch, 0);
    assert.equal(att.missionLinksWithoutExecution, 0);
    assert.equal(exitCodeForReport(report), 0);
  });

  test("an approved escalation for a mission-less agent that was never mission-bound is permitted token-only spending", () => {
    const { att, report } = run([ev.agent("a1"), opened("a1", "esc_1"), resolved("a1", "esc_1", "approve"), ev.exec("a1", "ref-1")]);
    assert.equal(att.permittedMissionless, 1);
    assert.equal(att.ambiguous, 0);
    assert.equal(exitCodeForReport(report), 0);
  });

  test("a rejected escalation (opened + resolved, no execution_result) adds no settlement and no finding", () => {
    const { att, report } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), opened("a1", "esc_1"), resolved("a1", "esc_1", "reject")]);
    assert.equal(att.successfulSettlements, 0);
    assert.equal(att.findings.length, 0);
    assert.equal(exitCodeForReport(report), 0);
  });

  test("an approved settlement by a mission-bound agent that wrote NO mission attribution is still caught as a binding violation (approval is not a bypass)", () => {
    const { att } = run([ev.agent("a1"), ev.missionCreated("a1", "m-1"), opened("a1", "esc_1"), resolved("a1", "esc_1", "approve"), ev.exec("a1", "ref-1")]);
    assert.equal(att.bindingViolations.legacy + att.bindingViolations.postEpoch, 1);
  });
});
