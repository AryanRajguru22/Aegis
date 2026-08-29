import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SCHEMA_VERSION } from "../schema.js";

/**
 * Offline, read-only ledger exporter — NOT part of the trusted verifier itself (see
 * verifier/integrity.ts's and verifier/report.ts's doc comments). Its job is only to
 * produce a static artifact file; the verifier, once handed any artifact, makes no
 * assumption about how honestly this step was run.
 *
 * Deliberately reads the SQLite file directly rather than calling GET /ledger:
 * that HTTP route is always scoped to one principal or agent (see
 * src/api/routes/ledger.ts), and the hash chain is a single GLOBAL sequence — a
 * scoped subset would show spurious broken-chain results at every point an excluded
 * entry was interleaved, even on a genuinely untampered ledger. This script instead
 * selects the complete `ledger_entries` table, unscoped, exactly as
 * src/state/ledger.ts's own verifyChain() does internally.
 *
 * Opens the database with { readOnly: true } — enforced by SQLite itself, not merely
 * by this script's own discipline — and issues only a single SELECT. Never opens a
 * network connection, never requires or reads any API key, never touches
 * private-key material (the public key must be supplied by the caller, e.g. copied
 * from the server's own boot log — see the PUBLIC VERIFICATION KEY line added to
 * src/api/main.ts in Step 14.1).
 */

interface LedgerRow {
  seq: number;
  kind: string;
  agent_id: string;
  principal_id: string;
  data_json: string;
  created_at: string;
  prev_hash: string;
  content_hash: string;
  signature: string;
}

export function exportLedgerFromDb(dbPath: string, publicKeyHex: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT * FROM ledger_entries ORDER BY seq ASC`).all() as unknown as LedgerRow[];

    const entries = rows.map((row) => ({
      seq: Number(row.seq),
      kind: String(row.kind),
      agentId: String(row.agent_id),
      principalId: String(row.principal_id),
      data: JSON.parse(String(row.data_json)),
      createdAt: String(row.created_at),
      prevHash: String(row.prev_hash),
      contentHash: String(row.content_hash),
      signature: String(row.signature),
    }));

    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      publicKeyHex,
      entries,
    };

    return JSON.stringify(artifact, null, 2);
  } finally {
    db.close();
  }
}

function main(): void {
  const [dbPath, publicKeyHex, outPath] = process.argv.slice(2);
  if (!dbPath || !publicKeyHex) {
    console.error(
      "Usage: node verifier/dist/export/exportLedger.js <path-to-aegis.db> <publicKeyHex> [outputPath]\n" +
        '  publicKeyHex: copy from the server\'s own startup log line "Ledger PUBLIC VERIFICATION KEY..."'
    );
    process.exit(2);
  }

  let json: string;
  try {
    json = exportLedgerFromDb(dbPath, publicKeyHex);
  } catch (error) {
    console.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote ${outPath}`);
  } else {
    console.log(json);
  }
}

// Only run as a side effect when this file is executed directly (`node exportLedger.js ...`),
// never merely by being imported — this keeps exportLedgerFromDb() safely unit-testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
