import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateArtifact, type LedgerExportArtifact } from "./schema.js";
import { buildReport, renderHumanReport, exitCodeForReport } from "./report.js";
import { compareExports } from "./compareExports.js";

/**
 * Judge-facing entry point. Fully offline: reads local file(s), does local
 * computation, prints a result, exits. Never opens a network connection, never reads
 * an API key, never calls any Aegis server/API/dashboard.
 *
 * Usage: node verifier/dist/cli.js <artifact.json> [--json] [--compare <older-artifact.json>]
 * Exit codes: 0 = verified, 1 = tamper/violation detected, 2 = malformed/insufficient evidence.
 * --compare never changes the exit code — it is a supplementary, partial check (see
 * verifier/compareExports.ts) covering only what a single artifact cannot: whether an
 * older export's entries were later truncated.
 */
function readValidatedArtifact(path: string): LedgerExportArtifact {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`AEGIS INDEPENDENT VERIFIER\n\nCould not read artifact file "${path}": ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`AEGIS INDEPENDENT VERIFIER\n\nArtifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const validation = validateArtifact(parsed);
  if (!validation.ok) {
    console.error(`AEGIS INDEPENDENT VERIFIER\n\nMALFORMED ARTIFACT — refusing to guess: ${validation.reason}`);
    process.exit(2);
  }
  return validation.artifact;
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const compareIndex = args.indexOf("--compare");
  const comparePath = compareIndex >= 0 ? args[compareIndex + 1] : undefined;
  const path = args.find((a, i) => !a.startsWith("--") && (compareIndex < 0 || i !== compareIndex + 1));

  if (!path) {
    console.error("Usage: node verifier/dist/cli.js <artifact.json> [--json] [--compare <older-artifact.json>]");
    process.exit(2);
  }

  const artifact = readValidatedArtifact(path);
  const report = buildReport(artifact);

  let compareResult: ReturnType<typeof compareExports> | undefined;
  if (comparePath) {
    const olderArtifact = readValidatedArtifact(comparePath);
    compareResult = compareExports(olderArtifact.entries, artifact.entries);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ...report, compare: compareResult ?? null }, null, 2));
  } else {
    console.log(renderHumanReport(report));
    if (compareResult) {
      console.log("");
      console.log("CROSS-EXPORT COMPARISON (partial — detects only truncation/history changes SINCE the older export)");
      if (compareResult.suspicious) {
        for (const finding of compareResult.findings) console.log(`✗ ${finding}`);
      } else {
        console.log("✓ no truncation or historical changes detected relative to the older export");
      }
    }
  }

  process.exit(exitCodeForReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
