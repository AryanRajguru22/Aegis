import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareExports } from "../compareExports.js";
import type { ExportedLedgerEntry } from "../schema.js";

function e(seq: number, contentHash: string): ExportedLedgerEntry {
  return { seq, kind: "x", agentId: "a", principalId: "p", data: {}, createdAt: "t", prevHash: "0".repeat(64), contentHash, signature: "s" };
}

describe("compareExports() — partial, cross-export tail-truncation mitigation only", () => {
  test("identical exports: not suspicious", () => {
    const a = [e(1, "h1"), e(2, "h2")];
    const result = compareExports(a, a);
    assert.equal(result.suspicious, false);
  });

  test("a strictly append-only newer export (same history plus new entries): not suspicious", () => {
    const older = [e(1, "h1"), e(2, "h2")];
    const newer = [e(1, "h1"), e(2, "h2"), e(3, "h3")];
    const result = compareExports(older, newer);
    assert.equal(result.suspicious, false);
  });

  test("a shrinking max seq (tail truncation between exports) is flagged", () => {
    const older = [e(1, "h1"), e(2, "h2"), e(3, "h3")];
    const newer = [e(1, "h1"), e(2, "h2")];
    const result = compareExports(older, newer);
    assert.equal(result.suspicious, true);
    assert.match(result.findings[0]!, /LOWER/);
  });

  test("a changed historical entry (same seq, different contentHash across exports) is flagged", () => {
    const older = [e(1, "h1"), e(2, "h2")];
    const newer = [e(1, "h1-changed"), e(2, "h2")];
    const result = compareExports(older, newer);
    assert.equal(result.suspicious, true);
    assert.match(result.findings[0]!, /content hash differs/);
  });

  test("does not itself claim to solve tail truncation for a SINGLE artifact — it only compares two", () => {
    const only = [e(1, "h1")];
    const result = compareExports(only, only);
    assert.equal(result.suspicious, false, "comparing an artifact to itself proves nothing about whether IT was truncated relative to some unknown true history");
  });
});
