/**
 * The exported artifact's shape and a fail-closed runtime validator. Independent of
 * src/state/ledger.ts's LedgerEntry type — this file defines the verifier's own
 * contract for what an artifact must look like, not an import of Aegis's internal
 * type.
 */

export const SCHEMA_VERSION = "aegis-ledger-export/1";

export interface ExportedLedgerEntry {
  seq: number;
  kind: string;
  agentId: string;
  principalId: string;
  data: unknown;
  createdAt: string;
  prevHash: string;
  contentHash: string;
  signature: string;
}

export interface LedgerExportArtifact {
  schemaVersion: string;
  exportedAt: string;
  /** PUBLIC VERIFICATION KEY only — an artifact must never carry a private key. */
  publicKeyHex: string;
  entries: ExportedLedgerEntry[];
}

export type ValidationResult = { ok: true; artifact: LedgerExportArtifact } | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainString(value: unknown): value is string {
  return typeof value === "string";
}

function isHexString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Rejects, with a specific human-readable reason, anything that doesn't structurally
 * match LedgerExportArtifact — including a schema version this build doesn't
 * recognize, a missing/empty public key, or an entries array with malformed rows.
 * Never guesses a default for a missing field and never silently drops a malformed
 * entry — see verifier/__tests__/integrity.test.ts's "malformed artifact" cases.
 */
export function validateArtifact(input: unknown): ValidationResult {
  if (input === null || typeof input !== "object") {
    return { ok: false, reason: "Artifact must be a JSON object" };
  }
  const obj = input as Record<string, unknown>;

  if (!isNonEmptyString(obj.schemaVersion)) {
    return { ok: false, reason: 'Artifact is missing a valid "schemaVersion" string' };
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `Unsupported schemaVersion "${obj.schemaVersion}" — this verifier understands "${SCHEMA_VERSION}"` };
  }
  if (!isNonEmptyString(obj.exportedAt)) {
    return { ok: false, reason: 'Artifact is missing a valid "exportedAt" string' };
  }
  if (!isHexString(obj.publicKeyHex)) {
    return { ok: false, reason: 'Artifact is missing a valid hex "publicKeyHex" (the PUBLIC VERIFICATION KEY)' };
  }
  if (!Array.isArray(obj.entries)) {
    return { ok: false, reason: 'Artifact is missing an "entries" array' };
  }
  if (obj.entries.length === 0) {
    return { ok: false, reason: '"entries" array is empty — nothing to verify' };
  }

  const entries: ExportedLedgerEntry[] = [];
  for (let i = 0; i < obj.entries.length; i++) {
    const raw = obj.entries[i];
    if (raw === null || typeof raw !== "object") {
      return { ok: false, reason: `entries[${i}] is not an object` };
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.seq !== "number" || !Number.isInteger(row.seq) || row.seq <= 0) {
      return { ok: false, reason: `entries[${i}].seq must be a positive integer, got ${JSON.stringify(row.seq)}` };
    }
    if (!isPlainString(row.kind) || row.kind.length === 0) {
      return { ok: false, reason: `entries[${i}].kind must be a non-empty string` };
    }
    if (!isPlainString(row.agentId)) {
      return { ok: false, reason: `entries[${i}].agentId must be a string` };
    }
    if (!isPlainString(row.principalId)) {
      return { ok: false, reason: `entries[${i}].principalId must be a string` };
    }
    if (!("data" in row)) {
      return { ok: false, reason: `entries[${i}].data is missing` };
    }
    if (!isNonEmptyString(row.createdAt)) {
      return { ok: false, reason: `entries[${i}].createdAt must be a non-empty string` };
    }
    if (!isHexString(row.prevHash) && row.prevHash !== "0".repeat(64)) {
      return { ok: false, reason: `entries[${i}].prevHash must be a hex string` };
    }
    if (!isHexString(row.contentHash)) {
      return { ok: false, reason: `entries[${i}].contentHash must be a hex string` };
    }
    if (!isHexString(row.signature)) {
      return { ok: false, reason: `entries[${i}].signature must be a hex string` };
    }
    entries.push({
      seq: row.seq,
      kind: row.kind,
      agentId: row.agentId,
      principalId: row.principalId,
      data: row.data,
      createdAt: row.createdAt,
      prevHash: row.prevHash as string,
      contentHash: row.contentHash,
      signature: row.signature,
    });
  }

  return {
    ok: true,
    artifact: { schemaVersion: obj.schemaVersion, exportedAt: obj.exportedAt, publicKeyHex: obj.publicKeyHex, entries },
  };
}
