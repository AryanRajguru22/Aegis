import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalContent, sha256Hex, GENESIS_HASH } from "../canonical.js";
import { SCHEMA_VERSION, type ExportedLedgerEntry, type LedgerExportArtifact } from "../schema.js";

/**
 * Shared test helper: builds a real, internally-consistent, validly-signed ledger
 * artifact from plain event inputs, using the verifier's OWN canonical.ts and Node's
 * node:crypto — never any Aegis production code. The keypair is a throwaway generated
 * per call; it never signs anything Aegis considers real.
 */

export interface RawEvent {
  kind: string;
  agentId: string;
  principalId: string;
  data: unknown;
}

function keyToHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "spki", format: "der" })).toString("hex");
}

export function buildSignedArtifact(events: readonly RawEvent[]): LedgerExportArtifact {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const entries: ExportedLedgerEntry[] = [];
  let prevHash = GENESIS_HASH;
  let seq = 1;
  for (const input of events) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
    const content = canonicalContent({ kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash });
    const contentHash = sha256Hex(content);
    const signature = cryptoSign(null, Buffer.from(contentHash, "utf8"), privateKey).toString("hex");
    entries.push({ seq, kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash, contentHash, signature });
    prevHash = contentHash;
    seq += 1;
  }
  return { schemaVersion: SCHEMA_VERSION, exportedAt: "2026-01-01T00:00:00.000Z", publicKeyHex: keyToHex(publicKey), entries };
}

const P = "p-1";

export const ev = {
  agent: (agentId: string): RawEvent => ({ kind: "agent_registered", agentId, principalId: P, data: { delegatedGoal: "x" } }),

  missionCreated: (agentId: string, missionId: string, budgetMinorUnits = 100_000): RawEvent => ({
    kind: "mission_created",
    agentId,
    principalId: P,
    data: { missionId, budgetMinorUnits, goal: "g", currency: "USD" },
  }),

  /** The verifier's policy-epoch boundary marker — see verifier/settlementAttribution.ts. */
  epochMarker: (overrides: Record<string, unknown> = {}): RawEvent => ({
    kind: "policy_epoch",
    agentId: "system",
    principalId: "system",
    data: { policy: "mission-binding", version: 1, ...overrides },
  }),

  /** A real rail settlement: an `execution_result` with success true. Carries NO amount and NO missionId, exactly like production. */
  exec: (agentId: string, reference: string, success = true): RawEvent => ({
    kind: "execution_result",
    agentId,
    principalId: P,
    data: { success, rail: "stripe_test", reference, settledAt: "2026-01-01T00:00:00.000Z", idempotencyKey: `${agentId}:${reference}` },
  }),

  outcome: (agentId: string, reference: string, missionId: string, amountMinorUnits: number): RawEvent => ({
    kind: "mission_pipeline_outcome",
    agentId,
    principalId: P,
    data: { missionId, amountMinorUnits, category: "flights", counterparty: "acme", verdict: "allow", reason: "ok", execution: { success: true, rail: "stripe_test", reference } },
  }),

  link: (agentId: string, missionId: string, amountMinorUnits: number): RawEvent => ({
    kind: "mission_transaction_link",
    agentId,
    principalId: P,
    data: { missionId, amountMinorUnits, success: true },
  }),

  /** A complete, normal mission-scoped settlement, in the exact order the API writes it: execution_result, mission_pipeline_outcome, mission_transaction_link. */
  missionSettlement: (agentId: string, reference: string, missionId: string, amountMinorUnits: number): RawEvent[] => [
    ev.exec(agentId, reference),
    ev.outcome(agentId, reference, missionId, amountMinorUnits),
    ev.link(agentId, missionId, amountMinorUnits),
  ],
};
