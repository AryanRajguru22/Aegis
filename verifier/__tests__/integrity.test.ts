import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalContent, sha256Hex, GENESIS_HASH } from "../canonical.js";
import { verifyIntegrity } from "../integrity.js";
import { validateArtifact, SCHEMA_VERSION } from "../schema.js";
import type { ExportedLedgerEntry } from "../schema.js";

/**
 * Adversarial tests for Proof 1 (verifier/integrity.ts), built entirely from the
 * verifier's OWN canonical.ts (already proven, in canonical.test.ts, to agree with
 * real production hashes) plus Node's own `node:crypto` for signing — never imports
 * src/state/ledger.ts or its verifyChain(). A synthetic Ed25519 keypair is generated
 * once per test file run; it never signs anything Aegis considers real.
 */

function keyToHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "spki", format: "der" })).toString("hex");
}

function sign(privateKey: KeyObject, data: string): string {
  return cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("hex");
}

interface RawEntry {
  kind: string;
  agentId: string;
  principalId: string;
  data: unknown;
}

/** Builds a real, internally-consistent, validly-signed chain of N entries — the same shape a genuine export artifact would carry. */
function buildChain(privateKey: KeyObject, inputs: RawEntry[]): ExportedLedgerEntry[] {
  const entries: ExportedLedgerEntry[] = [];
  let prevHash = GENESIS_HASH;
  let seq = 1;
  for (const input of inputs) {
    const createdAt = `2026-01-01T00:00:0${seq}.000Z`;
    const content = canonicalContent({ kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash });
    const contentHash = sha256Hex(content);
    const signature = sign(privateKey, contentHash);
    entries.push({ seq, kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash, contentHash, signature });
    prevHash = contentHash;
    seq += 1;
  }
  return entries;
}

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, publicKeyHex: keyToHex(publicKey) };
}

describe("verifyIntegrity() — Proof 1, adversarial cases", () => {
  test("1. a valid, untouched ledger verifies", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } },
      { kind: "mission_created", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", budgetMinorUnits: 100 } },
      { kind: "mission_transaction_link", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", amountMinorUnits: 50, success: true } },
    ]);
    const result = verifyIntegrity(publicKeyHex, chain);
    assert.equal(result.valid, true);
    assert.equal(result.entriesChecked, 3);
  });

  test("2. a modified entry (data changed after the fact) is caught at content_hash", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } },
      { kind: "agent_registered", agentId: "agent-2", principalId: "p-1", data: { x: 2 } },
    ]);
    chain[0]!.data = { x: 999 }; // tamper after signing, hash/signature left as-is
    const result = verifyIntegrity(publicKeyHex, chain);
    assert.equal(result.valid, false);
    assert.equal(result.failure!.stage, "content_hash");
    assert.equal(result.failure!.atSeq, 1);
  });

  test("3. a deleted INTERIOR entry is caught (the entry after the gap has a prevHash pointing to the missing entry)", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } },
      { kind: "agent_registered", agentId: "agent-2", principalId: "p-1", data: { x: 2 } },
      { kind: "agent_registered", agentId: "agent-3", principalId: "p-1", data: { x: 3 } },
    ]);
    const withGap = [chain[0]!, chain[2]!]; // delete seq 2
    const result = verifyIntegrity(publicKeyHex, withGap);
    assert.equal(result.valid, false);
    assert.equal(result.failure!.stage, "sequence_continuity");
    assert.equal(result.failure!.atSeq, 3);
  });

  test("3b. a deleted TAIL entry (the most recent one) is NOT detectable from a single snapshot — documented limitation, not a bug", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } },
      { kind: "agent_registered", agentId: "agent-2", principalId: "p-1", data: { x: 2 } },
      { kind: "agent_registered", agentId: "agent-3", principalId: "p-1", data: { x: 3 } },
    ]);
    const truncated = chain.slice(0, 2); // remove the last entry
    const result = verifyIntegrity(publicKeyHex, truncated);
    assert.equal(result.valid, true, "the remaining chain is genuinely self-consistent — this is a real, documented evidence gap, not something to paper over");
  });

  test("4. reordered entries are caught (swapping breaks prevHash continuity)", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } },
      { kind: "agent_registered", agentId: "agent-2", principalId: "p-1", data: { x: 2 } },
      { kind: "agent_registered", agentId: "agent-3", principalId: "p-1", data: { x: 3 } },
    ]);
    // Swap the seq labels of entries 2 and 3 to simulate a reordering attack, keeping content/hash/signature bound to their original data.
    const reordered = [chain[0]!, { ...chain[2]!, seq: 2 }, { ...chain[1]!, seq: 3 }];
    const result = verifyIntegrity(publicKeyHex, reordered);
    assert.equal(result.valid, false);
    assert.equal(result.failure!.stage, "prev_hash_continuity");
  });

  test("5. a modified amount is caught (amount lives inside the signed `data`)", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "mission_transaction_link", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", amountMinorUnits: 100, success: true } },
    ]);
    chain[0]!.data = { missionId: "m-1", amountMinorUnits: 999999, success: true };
    const result = verifyIntegrity(publicKeyHex, chain);
    assert.equal(result.valid, false);
    assert.equal(result.failure!.stage, "content_hash");
  });

  test("6. a modified mission ID is caught (missionId lives inside the signed `data`)", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [
      { kind: "mission_transaction_link", agentId: "agent-1", principalId: "p-1", data: { missionId: "victim-mission", amountMinorUnits: 100, success: true } },
    ]);
    chain[0]!.data = { missionId: "different-mission", amountMinorUnits: 100, success: true };
    const result = verifyIntegrity(publicKeyHex, chain);
    assert.equal(result.valid, false);
    assert.equal(result.failure!.stage, "content_hash");
  });

  test("7. a forged signature (attacker recomputes the hash but cannot sign without the private key) is caught", () => {
    const { privateKey, publicKeyHex } = keys();
    const attacker = keys(); // a different keypair — simulates not having Aegis's real private key
    const chain = buildChain(privateKey, [{ kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } }]);
    // Attacker changes data, correctly recomputes contentHash, but can only sign with their own key.
    const tamperedData = { x: 999 };
    const tamperedContent = canonicalContent({ kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: tamperedData, createdAt: chain[0]!.createdAt, prevHash: chain[0]!.prevHash });
    const tamperedHash = sha256Hex(tamperedContent);
    chain[0]!.data = tamperedData;
    chain[0]!.contentHash = tamperedHash;
    chain[0]!.signature = sign(attacker.privateKey, tamperedHash);
    const result = verifyIntegrity(publicKeyHex, chain); // verified against the REAL public key, not the attacker's
    assert.equal(result.valid, false);
    assert.equal(result.failure!.stage, "signature");
  });

  test("8. a malformed artifact is rejected by schema validation before any proof runs", () => {
    assert.equal(validateArtifact(null).ok, false);
    assert.equal(validateArtifact({}).ok, false);
    assert.equal(validateArtifact({ schemaVersion: "wrong-version", exportedAt: "x", publicKeyHex: "ab", entries: [] }).ok, false);
    assert.equal(validateArtifact({ schemaVersion: SCHEMA_VERSION, exportedAt: "x", publicKeyHex: "ab", entries: [] }).ok, false, "empty entries array must be rejected");
    assert.equal(validateArtifact({ schemaVersion: SCHEMA_VERSION, exportedAt: "x", publicKeyHex: "not-hex!!", entries: [{}] }).ok, false);
    assert.equal(
      validateArtifact({ schemaVersion: SCHEMA_VERSION, exportedAt: "x", publicKeyHex: "ab", entries: [{ seq: "not-a-number" }] }).ok,
      false
    );
  });

  test("valid artifact round-trips through validateArtifact() unchanged", () => {
    const { privateKey, publicKeyHex } = keys();
    const chain = buildChain(privateKey, [{ kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { x: 1 } }]);
    const artifact = { schemaVersion: SCHEMA_VERSION, exportedAt: "2026-01-01T00:00:00.000Z", publicKeyHex, entries: chain };
    const result = validateArtifact(artifact);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.artifact.entries.length, 1);
      assert.equal(result.artifact.publicKeyHex, publicKeyHex);
    }
  });
});
