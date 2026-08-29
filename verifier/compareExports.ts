import type { ExportedLedgerEntry } from "./schema.js";

export interface CompareResult {
  suspicious: boolean;
  findings: string[];
}

/**
 * Optional, partial mitigation for the one integrity gap a single snapshot cannot
 * detect on its own: tail truncation (deleting the most recent entries leaves a
 * fully self-consistent remaining chain — see verifier/integrity.ts's doc comment
 * and test 3b). This does NOT solve that gap in general; it only detects it across
 * TWO exports taken at different times, and only for what changed BETWEEN them. It
 * proves nothing about an artifact examined in isolation.
 *
 * Two checks, both intentionally narrow:
 *  1. A shrinking maximum seq between an older and a newer export is conclusive
 *     evidence that entries were removed in between — a genuinely append-only ledger
 *     can never make its own history shorter.
 *  2. Any seq present in both exports whose contentHash differs between them means
 *     two different signed histories exist for the same position — worth surfacing,
 *     even though (per src/state/ledger.ts's own doc comment on having a single
 *     trusted signer) this tool cannot independently determine which, if either, is
 *     authentic.
 */
export function compareExports(older: readonly ExportedLedgerEntry[], newer: readonly ExportedLedgerEntry[]): CompareResult {
  const findings: string[] = [];

  const olderMaxSeq = older.reduce((max, e) => Math.max(max, e.seq), 0);
  const newerMaxSeq = newer.reduce((max, e) => Math.max(max, e.seq), 0);
  if (newerMaxSeq < olderMaxSeq) {
    findings.push(
      `The newer export's highest seq (${newerMaxSeq}) is LOWER than the older export's (${olderMaxSeq}) — entries were removed between exports (tail truncation).`
    );
  }

  const olderBySeq = new Map(older.map((e) => [e.seq, e]));
  for (const entry of newer) {
    const previous = olderBySeq.get(entry.seq);
    if (previous && previous.contentHash !== entry.contentHash) {
      findings.push(`Entry #${entry.seq}'s content hash differs between the two exports — its recorded history changed.`);
    }
  }

  return { suspicious: findings.length > 0, findings };
}
