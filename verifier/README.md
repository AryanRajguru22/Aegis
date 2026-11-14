# Aegis Independent Verifier

A standalone, offline tool that checks Aegis's ledger **without trusting Aegis**.

It does not call the Aegis server, does not use an API key, does not open a network
connection, and does not import any of Aegis's own verification code
(`src/state/ledger.ts`'s `verifyChain()`, `src/mission/ledger.ts`'s
`computeMissionSpent()`). Every check here is a separate, from-scratch
implementation, so a bug or a lie in the real product's own code cannot make this
tool agree with it by accident.

## What it reads

One exported JSON artifact (see **Exporting a ledger** below) plus, embedded in that
same file, Aegis's **public** ledger verification key. Nothing else. The artifact is
produced by `verifier/export/exportLedger.js`, which reads the SQLite database file
directly and read-only — never through the Aegis HTTP API, since `GET /ledger` is
always scoped to one principal or agent and a partial view cannot be verified as a
whole chain.

## What it proves

**Proof 1 — Ledger integrity** (`verifier/integrity.ts`): given only the entries and
the public key, independently re-derives:
- sequence continuity (no gaps, starts at the fixed genesis hash)
- hash-chain continuity (each entry's `prevHash` matches the previous entry's own
  content hash)
- content-hash correctness (each entry's stored hash matches what its own fields
  actually hash to)
- Ed25519 signature authenticity against the supplied public key

**Proof 2 — Mission budget safety** (`verifier/missionBudget.ts`): reconstructs, from
the raw entries alone, each mission's budget (from its one `mission_created` entry)
and its cumulative *settled* spend (summing only `mission_transaction_link` entries
with `success: true` — denied, escalated, and failed-execution attempts never produce
one), then checks spend never exceeded budget. This only runs meaningfully once Proof
1 has already passed — a budget number computed from an already-broken chain is not a
proof of anything, so it is never presented as one.

**Proof 3 — Settlement attribution** (`verifier/settlementAttribution.ts`): checks the
mission-required rule the API now enforces (an agent that has ever been assigned a
mission must name one on every spend). It finds every real settlement — an
`execution_result` with `success: true` — and asks whether it can be attributed to a
valid mission:

- The settlement is joined, by its **rail reference** (unique per settlement), to a
  `mission_pipeline_outcome` and then to a `mission_transaction_link` for the same
  mission and amount. Position in the ledger is never used for the join, because
  concurrent requests interleave.
- "Valid mission" means a `mission_created` entry for the same agent and principal exists
  before the settlement.
- A settlement with no attribution by an agent that had **no** mission yet is
  *permitted* (token-only authority is still allowed for never-assigned agents). The same
  settlement by an agent that already had a mission is a **mission-binding violation**.
- Evidence that cannot decide the question (duplicate rail references, an outcome with no
  budget link, an older-format history with no outcome, a mission with no creation entry
  or owned by another agent) is reported as **ambiguous** — never as a pass and never as
  a proven violation.

This proof is, like Proof 2, only computed after Proof 1 passes. Its findings are
**policy-compliance findings, not integrity failures**: they never appear in the
"hash chain" lines, and a tampered ledger reports the cryptographic failure and nothing
else.

### Policy epoch (legacy vs. post-fix activity)

A ledger entry of `kind: "policy_epoch"` with `data.policy: "mission-binding"` marks the
point from which the rule was being enforced. It is an ordinary signed, hash-chained
entry, so it cannot be inserted, moved or removed without failing Proof 1. If several
exist the earliest is used; entries with another policy or malformed data are ignored.

- Violations **before** the marker, or in a ledger with **no** marker, are reported as
  **HISTORICAL** (exit 3).
- Violations **after** the marker mean the rule was in force and was not enforced (exit 1).

**The API writes this marker** (`src/api/policyEpoch.ts`) once per ledger, at the first
server start under the rule (production ledger and each Security Lab instance). A ledger
that predates the rule therefore gets its marker at the upgrade point: earlier
unattributed spend is classified as historical, and any after it is a real violation.
Ledgers exported from a server that never ran this version carry no marker, and the
verifier reports their findings as historical because it cannot tell the two apart.

## What it deliberately does not trust

The Aegis dashboard, the Aegis API, any server response, any number Aegis itself
reports as "spent" or "remaining," any in-memory application state, and any
precomputed "verified" flag. It also does not trust its own export step to have been
run honestly — the export tool is a convenience for producing evidence, not part of
the trust boundary; the verifier makes no assumption about who ran it or how.

## Exporting a ledger

```
npm run build:verifier
node verifier/dist/export/exportLedger.js <path-to-aegis.db> <publicKeyHex> [outputPath]
```

`publicKeyHex` is printed by the Aegis server itself at startup, on the line:

```
Ledger PUBLIC VERIFICATION KEY (safe to share — use with the independent verifier): <hex>
```

Copy that value — never the private key line printed just above it. If `outputPath`
is omitted, the artifact is printed to stdout.

## Running verification

```
node verifier/dist/cli.js <artifact.json>
node verifier/dist/cli.js <artifact.json> --json
node verifier/dist/cli.js <artifact.json> --compare <older-artifact.json>
```

Exit codes: `0` = verified, `1` = tamper, budget violation, or a mission-binding
violation after the policy epoch, `2` = malformed artifact, insufficient evidence, or
ambiguous settlement attribution (never silently treated as a pass), `3` = integrity
verified but **historical** mission-binding findings only (not tampering, and not
reported as clean).

## Expected behavior

A genuine, untouched export:

```
LEDGER INTEGRITY
✓ SEQUENCE CONTINUOUS (16 entries)
✓ HASH CHAIN VALID
✓ SIGNATURE VALID

MISSION BUDGETS
✓ mission-example
  Budget: $1000.00
  Max committed spend: $760.00
  Overspend: $0.00

✓ ALL INVARIANTS VERIFIED

VERDICT: TRUSTED
```

## Tamper demonstration

Modify any field inside one entry's `data` in the exported JSON file directly (for
example, shrink a settled `amountMinorUnits`) without touching its `contentHash` or
`signature` — exactly what an attacker with only file-write access, and not Aegis's
private key, could attempt. Re-running the verifier against that file reports:

```
LEDGER INTEGRITY
✗ HASH CHAIN INVALID
  First detected corruption: entry #<n>
  Reason: stored content hash does not match the entry's own fields — the entry was modified after being written

MISSION BUDGETS
  (skipped — mission results depend on ledger integrity, which failed above)

VERDICT: NOT VERIFIED
```

Exit code `1`. The verifier never repairs, restores, or offers to "fix" a broken
chain — a real Aegis instance's actual database file is never modified by any of
this; only the standalone exported JSON copy is ever touched in this demonstration.

## Budget proof

`Max committed spend` in the passing example above is independently recomputed from
raw ledger entries, not read from any Aegis API response. In live verification this
value has been shown to match, to the cent, what `GET /missions/:id` independently
reports as `spentMinorUnits` — the two are produced by two separately-written code
paths agreeing on the same underlying facts.

## Known limitations (disclosed, not hidden)

**The amount of an unattributed settlement cannot be determined.** An `execution_result`
records the rail reference but no amount and no mission, and the policy/decision entries
carry no key tying them to a specific settlement (under concurrency they are not
adjacent either). The verifier therefore reports a *count* and states that the amount
cannot be determined; it never estimates one. Exact amounts would require the API to
record the amount (or the idempotency key) on the decision/settlement events — a
separate follow-up, deliberately not done here.

**Legacy ledgers cannot be classified as pre- or post-fix without a marker.** See
"Policy epoch" above. Spend that happened before the rule existed is not rewritten and is
reported as historical.

**Agent binding is inferred from `mission_created` entries.** That is the same fact the
API derives from its missions table; a mission registered but whose ledger entry is
missing (a crash between the two writes) would make the verifier treat the agent as
unbound until that entry exists.

**A budget-link gap is reported, not repaired.** A settlement whose outcome was written
but whose `mission_transaction_link` was not (the documented crash window) is
*ambiguous*: that spend is real but absent from the Proof 2 budget total.

**Tail truncation is undetectable from a single snapshot.** If the most *recent*
entries are deleted outright (not modified — removed), the remaining chain is fully
self-consistent; there is nothing left to reveal the gap. This is a real, architectural
limitation, not an oversight — `src/state/ledger.ts` names the production mitigation
(periodic root-hash anchoring to a public chain) as explicitly out of scope for this
core. `--compare <older-artifact.json>` provides a **partial** mitigation: given two
exports taken at different times, it flags a shrinking sequence range or a changed
historical entry. It proves nothing about a single artifact examined in isolation.

**Single trusted signer.** The ledger's tamper-evidence is anchored to one Ed25519
keypair held by the running Aegis process — this is a real, useful integrity
guarantee ("nobody altered this record without the private key"), not a trustless,
blockchain-style guarantee ("no single party could have altered this record"). Aegis
does not claim to be a blockchain, and this tool does not either.
