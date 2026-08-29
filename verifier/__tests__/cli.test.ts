import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalContent, sha256Hex, GENESIS_HASH } from "../canonical.js";
import { SCHEMA_VERSION } from "../schema.js";

/**
 * End-to-end tests: spawns the actual compiled CLI (verifier/dist/cli.js) as a real
 * child process against real artifact files on disk — the same way a judge would run
 * it. Exercises the full path: file read -> JSON parse -> schema validation -> Proof 1
 * -> Proof 2 -> rendered output -> process exit code.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "cli.js");

function keyToHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "spki", format: "der" })).toString("hex");
}
function sign(privateKey: KeyObject, data: string): string {
  return cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("hex");
}

function buildValidArtifact() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = keyToHex(publicKey);

  const inputs = [
    { kind: "agent_registered", agentId: "agent-1", principalId: "p-1", data: { delegatedGoal: "x" } },
    { kind: "mission_created", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", budgetMinorUnits: 2000 } },
    { kind: "mission_transaction_link", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", amountMinorUnits: 1900, success: true } },
  ];

  let prevHash = GENESIS_HASH;
  let seq = 1;
  const entries = inputs.map((input) => {
    const createdAt = `2026-01-01T00:00:0${seq}.000Z`;
    const content = canonicalContent({ kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash });
    const contentHash = sha256Hex(content);
    const signature = sign(privateKey, contentHash);
    const entry = { seq, kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash, contentHash, signature };
    prevHash = contentHash;
    seq += 1;
    return entry;
  });

  return { schemaVersion: SCHEMA_VERSION, exportedAt: "2026-01-01T00:00:00.000Z", publicKeyHex, entries };
}

describe("verifier CLI — end-to-end, real child process, real files", () => {
  test("a valid artifact: exit 0, VERDICT: TRUSTED, human output readable in ~10 seconds", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-verifier-test-"));
    try {
      const path = join(dir, "artifact.json");
      writeFileSync(path, JSON.stringify(buildValidArtifact()));

      const result = spawnSync(process.execPath, [CLI_PATH, path], { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /HASH CHAIN VALID/);
      assert.match(result.stdout, /VERDICT: TRUSTED/);
      assert.match(result.stdout, /ALL INVARIANTS VERIFIED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid artifact with --json: exit 0, machine-readable overallVerified: true", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-verifier-test-"));
    try {
      const path = join(dir, "artifact.json");
      writeFileSync(path, JSON.stringify(buildValidArtifact()));

      const result = spawnSync(process.execPath, [CLI_PATH, path, "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.overallVerified, true);
      assert.equal(parsed.integrity.valid, true);
      assert.equal(parsed.missions[0].budgetInvariantHolds, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered artifact (data mutated after export): exit 1, VERDICT: NOT VERIFIED, names the broken entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-verifier-test-"));
    try {
      const artifact = buildValidArtifact();
      artifact.entries[2]!.data = { missionId: "m-1", amountMinorUnits: 1, success: true }; // tamper: shrink recorded spend without updating hash/signature
      const path = join(dir, "artifact.json");
      writeFileSync(path, JSON.stringify(artifact));

      const result = spawnSync(process.execPath, [CLI_PATH, path], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /HASH CHAIN INVALID/);
      assert.match(result.stdout, /entry #3/);
      assert.match(result.stdout, /VERDICT: NOT VERIFIED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed artifact (not valid JSON): exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-verifier-test-"));
    try {
      const path = join(dir, "artifact.json");
      writeFileSync(path, "{ this is not valid json");

      const result = spawnSync(process.execPath, [CLI_PATH, path], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a structurally malformed artifact (missing required fields): exit 2, refuses to guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-verifier-test-"));
    try {
      const path = join(dir, "artifact.json");
      writeFileSync(path, JSON.stringify({ schemaVersion: SCHEMA_VERSION }));

      const result = spawnSync(process.execPath, [CLI_PATH, path], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /MALFORMED ARTIFACT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nonexistent file: exit 2, clear error, never crashes with a stack trace", () => {
    const result = spawnSync(process.execPath, [CLI_PATH, "/no/such/file.json"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Could not read artifact file/);
  });

  test("a mission overspend (evidence-sufficient but budget violated): exit 1, VERDICT: NOT VERIFIED", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-verifier-test-"));
    try {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicKeyHex = keyToHex(publicKey);
      const inputs = [
        { kind: "mission_created", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", budgetMinorUnits: 100 } },
        { kind: "mission_transaction_link", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", amountMinorUnits: 100, success: true } },
        { kind: "mission_transaction_link", agentId: "agent-1", principalId: "p-1", data: { missionId: "m-1", amountMinorUnits: 50, success: true } },
      ];
      let prevHash = GENESIS_HASH;
      let seq = 1;
      const entries = inputs.map((input) => {
        const createdAt = `2026-01-01T00:00:0${seq}.000Z`;
        const content = canonicalContent({ kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash });
        const contentHash = sha256Hex(content);
        const signature = sign(privateKey, contentHash);
        const e = { seq, kind: input.kind, agentId: input.agentId, principalId: input.principalId, data: input.data, createdAt, prevHash, contentHash, signature };
        prevHash = contentHash;
        seq += 1;
        return e;
      });
      const artifact = { schemaVersion: SCHEMA_VERSION, exportedAt: "2026-01-01T00:00:00.000Z", publicKeyHex, entries };
      const path = join(dir, "artifact.json");
      writeFileSync(path, JSON.stringify(artifact));

      const result = spawnSync(process.execPath, [CLI_PATH, path], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /HASH CHAIN VALID/, "integrity itself is genuinely intact here — only the budget invariant is violated");
      assert.match(result.stdout, /VERDICT: NOT VERIFIED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
