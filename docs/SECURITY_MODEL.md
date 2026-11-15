# Security Model

This document describes the security guarantees Aegis's current implementation
actually provides, and states plainly where those guarantees stop. For the underlying
design rationale and threat-by-threat analysis, see [TRUST_MODEL.md](TRUST_MODEL.md)
and [THREAT_MODEL.md](THREAT_MODEL.md) — this document is the "what the running code
does today" companion to those.

## 1. Authority boundaries

Every agent holds a [Biscuit](https://www.biscuitsec.org/) capability token
(`src/capability/`), not a database row or a session flag. The token itself encodes
its caveats — max amount, currency, allowed categories, allowed rails, expiry — and
verification is cryptographic, not a lookup that a bug or an admin action could quietly
bypass. A request presenting an invalid, expired, or malformed token is rejected before
any policy or risk logic runs at all.

## 2. Attenuation is structurally narrowing-only

`src/capability`'s attenuation function rejects, at mint time, any attempt to produce a
child token wider than its parent in *any* dimension — a larger amount, an added
category, an added rail, or a later expiry. This is enforced by the attenuation
function itself, not by convention or by trusting a caller to only ask for narrower
tokens. There is no code path that produces a child token wider than its parent.

## 3. Mission boundaries and atomic budget enforcement

A mission (`src/mission/`) layers a narrower, bounded objective on top of an agent's
existing token — its own goal, its own cumulative budget, optional category/
counterparty allowlists. Enforcement is one atomic SQL statement per attempt:
`budget − reserved − settled ≥ requested`, checked and reserved in the same write
(`src/mission/reservation.ts`). This is what makes it safe under many simultaneous
requests, not just correct when tested one at a time — see the Security workspace's
concurrent-budget-race scenario, which fires 20 real, concurrent `POST /transactions`
calls against one $2,000 mission and asserts, from the server's own re-fetched state,
that authorized spend never exceeds the budget.

**Mission-required invariant (sticky).** Budget enforcement only binds if it cannot be
skipped, so it is not optional per request: once an agent has been assigned any mission
(a row in `missions`, any status), every `/simulate` and `/transactions` call for it
must name a mission, and the same rule applies to both. Ending all of its missions does
not restore unrestricted mission-less spending. The property is derived from the
`missions` table (rows are never deleted), so it is durable across restarts and applies
to legacy agents without a migration. Unknown and not-yours mission ids return an
identical `404`; malformed ids return `400`.
A mission-less request already past this check and awaiting the intent judge when an
agent's first mission is created is re-checked immediately before the rail (see §4,
"Last-moment re-check") and denied. Spend recorded before this rule existed is not
rewritten; the independent verifier reports it as a `legacy` binding violation.

## 4. Revocation

Revoking an agent (`POST /agents/:id/revoke`) marks that token's identifier revoked.
Verification of any *descendant* token checks its full ancestry, not just its own
signature — so revoking one node makes every token derived from it fail its very next
verification, with no separate cascade/cleanup step to run or forget to run. Revocation
is itself written to the ledger, attributed. The Security workspace's revocation
scenario demonstrates this directly: the same transaction that succeeds before
revocation is denied immediately after, by the real capability layer, not a scripted
before/after.

**Last-moment re-check (closes the judge-wait window).** `decideTransaction` verifies the
capability at its start and then awaits the intent judge — up to 8s (Anthropic/demo) or
45s (Gemini) by default. A revocation, token expiry, or mission cancel/expiry landing in
that window used to still reach the rail. `executeTransaction`
(`src/execution/executeTransaction.ts`) now re-runs `verifyTransaction` (revocation
ancestry + expiry + caveats) and a caller-supplied synchronous `preExecutionGuard`
(`src/api/routes/transactions.ts`: mission still active and unexpired; or, for a
mission-less request, the agent still not mission-bound — this also closes the earlier
"F5" gap) **immediately before** `adapter.execute()`, with no `await` in between. On
failure the rail is never called, the response is a `deny`, a `pre_execution_recheck`
ledger entry records the withdrawal (the earlier `allow` decision entry is not
rewritten — the ledger is append-only), and the existing non-allow path returns the
reservation. Proven by `src/api/__tests__/api-pre-rail-recheck.test.ts`, which holds the
judge open on a test-controlled promise, revokes/cancels/expires while the request is
provably in flight, and asserts zero rail calls (6 of its 7 tests fail if the re-check
is removed).

**Remaining edge case**: a revocation that lands *after* the rail call has begun (while a
real network request to a rail such as Stripe is outstanding) cannot recall that request.
The window is now only the rail's own latency, not the judge's.

## 4a. Escalation resolution (operator review)

An `escalate` verdict can only come from the risk stage (the capability/policy stage
only ever denies), so an escalation always means "policy allowed it, but the intent judge
or the behavioral baseline was not satisfied". A real `POST /transactions` that
escalates is parked as a row in the `escalations` table and a `escalation_opened`
ledger entry; the response carries `escalation: { escalationId, status: "pending" }`.
`/simulate` never opens one. One request opens at most one escalation (the originating
idempotency key is unique), so a retry replays the same handle.

**Who may resolve.** Only the principal that owns the agent, authenticated by its API key
(`POST /escalations/:id/approve|reject`, `requirePrincipalAuth`). The agent's own
capability token is a different credential class and is rejected on these routes with 401 —
**an agent cannot approve its own escalation** (tested with the agent's real token).
Another principal gets the same 404 as for a missing id. A reason (1–500 chars) is required
and is recorded with the operator's principal id and a timestamp in an `escalation_resolved`
ledger entry.

**Approval is not a bypass.** The operator's decision replaces *only* the risk stage.
Everything else is re-run, synchronously and in order, with no `await` before the rail:
1. the agent's stored capability token is re-verified (revocation of the agent or any
   ancestor, expiry, every caveat);
2. the mission must still be active and unexpired (or, for a mission-less escalation, the
   agent must still not be mission-bound);
3. the budget is reserved **at approval time** with the same atomic conditional `UPDATE`
   used for ordinary transactions. Nothing is held while an escalation is pending, so two
   escalations that each fit a budget but not together cannot both be approved — the second
   is refused with 409 and stays pending;
4. `executeApprovedEscalation` (next to `executeTransaction`, the only module that calls a
   rail) runs the capability + mission guard check again immediately before the rail call; a
   change is ledgered as a `pre_execution_recheck` entry (`originalVerdict: "escalate"`) and
   the rail is not called.

If steps 1–3 fail at approval time the response is 409, the escalation **stays pending**, and
the operator can still reject it. A rejected escalation never reaches a rail, and a retry of
the original request replays the cached `escalate` (same Idempotency-Key) or re-evaluates
from scratch (new key) — it can never execute the rejected transaction.

**Exactly one decision.** Pending → approved/rejected is a single conditional
`UPDATE … WHERE status = 'pending'`; of any number of duplicate or conflicting resolutions one
wins. Repeating the *same* decision by the same principal is an idempotent 200
(`replayed: true`, never re-executed); the opposite decision is 409.

**Crash safety.** The rail is called with a key derived from the escalation
(`escalation:<id>`). An approved escalation whose outcome was never recorded (process died)
is marked `indeterminate` at startup, is **never re-executed**, and its budget reservation
stays held (fail closed; same stance as an orphaned idempotency key). A reservation taken for
an escalation that was still pending is returned at startup.

**Separation of duties — what is and is not enforced.**
- *Enforced:* the escalated agent (and any holder of only its capability token) cannot approve
  or reject; only the owning principal's API key can; the deciding identity is recorded.
- *Not enforced:* a human developer who submits transactions as an agent and the human
  operator who reviews them are separate people only by convention. The identity model has one
  human credential per principal (the API key) and the same principal owns the agent, so
  "the developer cannot approve their own agent's transaction" **cannot be enforced** today,
  and the ledger records `resolvedBy` as the principal id, not an individual. Minimal change
  required: a reviewer role on principals (e.g. a `reviewers` table or a `role` column plus
  a second API-key class) with the rule `reviewer ≠ agent owner / initiator`, enforced in
  `requireOwnedEscalation`. Not built — it needs a decision about how reviewers are
  provisioned.
- Escalations do not expire on a timer; an operator who never decides leaves the transaction
  unexecuted (fail closed).

## 5. Idempotency and crash safety

Every transaction requires an idempotency key (`src/api/idempotency.ts`). A retried
request with the same key cannot execute twice, including across a hard process
restart — an in-flight claim whose outcome cannot be confirmed after a crash is
permanently rejected rather than silently replayed (`src/api/__tests__/api-restart.test.ts`
exercises this directly by simulating a restart mid-flight).

## 6. Risk evaluation — two independently disclosed layers

- **Behavioral baseline** (`src/risk/baseline.ts`): a rolling rate check and an
  amount-deviation check. Deliberately simple, explicit heuristics — not a trained
  anomaly model, not multi-hop collusion-graph analysis. Either flag alone forces
  `escalate`, regardless of what the intent judge concluded.
- **Intent-consistency judge** (`src/risk/types.ts`): pluggable. In demo mode
  (`AEGIS_DEMO_MODE=true`) it is a fixed, disclosed deterministic stand-in
  (`src/api/demoMode.ts`'s `createDemoIntentJudge()`) that always returns
  `"consistent"` and says so, explicitly, in its own rationale text — it performs no
  analysis and must never be read as AI judgment. Outside demo mode it is one of two
  independent, real implementations — `AnthropicIntentJudge`
  (`src/risk/anthropicJudge.ts`, requires `ANTHROPIC_API_KEY`) or `GeminiIntentJudge`
  (`src/risk/geminiJudge.ts`, requires `GEMINI_API_KEY`) — selected by
  `src/api/demoMode.ts`'s `createServerIntentJudge()`, never both at once; see the
  README's "Risk judge provider" section for the exact selection precedence. Both
  throw rather than guess a verdict on any malformed/unexpected response, which
  `safeJudge()` turns into `"unavailable"` → `escalate`, so a judge failure can only
  ever make the outcome stricter, never an `allow`.
  **This distinction is load-bearing for demo honesty**: every `ESCALATE` verdict
  reproducible in the current demo comes from the behavioral-baseline layer, not from
  AI judgment — see [TESTING.md](TESTING.md) and [DEMO.md](DEMO.md) for exactly how to
  reproduce one.

## 7. Rail isolation in demo mode

`src/api/demoMode.ts`'s `selectRailAdapters()` unconditionally excludes the Stripe
adapter whenever `AEGIS_DEMO_MODE=true` — even if a `STRIPE_SECRET_KEY` happens to be
present in the environment. This is enforced independently at two layers (also in
`src/api/main.ts`'s own adapter construction), so there is no single point of failure
that could let a real payment rail activate while demo mode is on. `mock_x402` is a
small, self-built mock rail with its own fixed price catalog — no real money can move
through it by construction.

## 8. Evidence and tamper detection

Every ledger entry (`src/state`) is Ed25519-signed and hash-chained to the entry before
it. Modifying an entry, breaking the `prevHash` link, or forging a signature with a
different key are each independently caught — both by Aegis's own `verifyChain()` and
by the standalone [`verifier/`](../verifier/README.md) tool, which imports nothing from
`src/` and re-derives integrity from only an exported ledger file and Aegis's public
key.

**The tamper demonstration never reaches production evidence.** The only tamper route
in the entire codebase (`src/api/demoTamper.ts`'s `applyDemoLedgerTamper`) is
constructed and mounted exactly once — by `src/api/securityLab.ts`, always bound to
the Security Demonstration Lab's own isolated database (§8a below), never to
production's. Production's ledger route (`src/api/routes/ledger.ts`, mounted from
`src/api/main.ts`) has no tamper endpoint reachable over HTTP at all, in any server
mode. What the route does, when reached, is narrow and fixed: it corrupts one stored
entry's `data` directly in the database — bypassing the normal write path entirely,
never touching `content_hash`, `signature`, or `prev_hash` — so the divergence is
exactly the "content changed, signature didn't" case `verifyChain()` and the
independent verifier both already prove they catch. It cannot repair, restore, or
selectively fix an entry; the lab's own **reset** is the only way its state changes,
and reset discards the whole instance rather than editing it in place.

**Verification cost, the memo, and cooperative verification.** A full chain verification
is O(entries) with an Ed25519 verify per entry (~160µs/entry, measured: ~2.1s at ~10,800
entries on the reference machine). Run synchronously it blocks the whole event loop, and the
load test (`scripts/loadtest.mjs`, [LOAD_TESTING.md](LOAD_TESTING.md)) showed the consequence:
with continuous writes every `/ledger` read cost 2.4–3.7s **and** writers' p95 latency rose
from ~0.5s to 2.5–3.2s — a cheap resource-amplification path for any authenticated principal,
because the chain is global across tenants. Two measures, neither of which weakens detection:
1. The result is memoized against a whole-database change token (`PRAGMA data_version` +
   `total_changes()`), so repeated reads of an *unchanged* database are free while **any** write
   — in-process or from another connection/process — forces a fresh full pass.
2. `GET /ledger` uses `verifyChainAsync()`: the *identical* whole-chain verification (the same
   per-row check as the synchronous one, so verdicts cannot diverge) that yields to the event
   loop between 200-row batches and shares one in-flight pass between concurrent callers. The
   rows examined are those present when the pass starts; a write that lands mid-pass
   invalidates the memo so the next call verifies again.
Measured effect at ~10,800 entries with 10 concurrent writers: write throughput 9.6 → 93 req/s,
writer p95 2.5s → 0.19s. The price is that the *read* is slower while writes continue (≈4.8s),
because it now shares the CPU instead of monopolising it. The memo and the async path cannot
hide tampering performed through SQLite (tests cover in-process UPDATE/DELETE, a forged
signature, and an out-of-band write from a second connection, in both variants). They do not
protect against someone editing the database file's bytes behind a running process's back.
**Not implemented:** incremental/checkpointed verification — it would make each read cheaper
but would verify old rows less often, i.e. weaken detection unless paired with a scheduled
full pass. Practical guidance: do not poll `/ledger` at high frequency on a large, busy ledger.

This is honestly described as **tamper-evident**, not "blockchain" and not
"trustless" — there is a single ledger signing key held by the running process
(`AEGIS_LEDGER_PRIVATE_KEY_HEX`), not distributed consensus. The property proven is
*detection* of tampering, not elimination of a trusted operator.

## 8a. Security Demonstration Lab isolation

`src/api/securityLab.ts` builds a complete second instance of the exact same,
unmodified pipeline (`createApp`, `decideTransaction`, `executeTransaction`, mission
reservation, the hash-chained ledger) — mounted at `/lab`, always, regardless of
`AEGIS_DEMO_MODE`. It is what the Security workspace's concurrent-budget-race,
revocation, and ledger-tamper scenarios actually run against, so they can be
demonstrated genuinely — against real code, not a mock — without any risk to real
evidence. Concretely, it never shares with production:

- **Identity** — a fresh root keypair and a fresh ledger signing keypair, generated at
  construction, distinct from production's.
- **Storage** — a private, in-memory (`:memory:`) SQLite database, never the
  file-backed production database (`AEGIS_DB_PATH`).
- **The intent judge** — always the deterministic demo stand-in
  (`createDemoIntentJudge()`), never a real Anthropic/Gemini call, regardless of what
  the real server is configured to use, so a lab session never spends real quota or
  claims to be an AI judgment it isn't.

The one thing deliberately shared is the mock `x402` merchant (and its payer-key
registry) already running for production's own `mock_x402` rail — safe to share
because it never moves real money either way, and duplicating it would mean running a
second fake HTTP server for no safety benefit. **Resetting the lab** (`POST
/lab/reset`) replaces this entire instance wholesale with a brand-new one; there is no
partial or selective reset, matching the same principle §8 states for production
evidence: state is never edited in place, only ever wholly recreated or (in
production) permanently appended to.

## 9. Separation of decision and custody

Aegis's own process never holds rail credentials or private keys capable of moving
real money on its own account — it produces a decision, and a rail adapter (using the
rail's own scoped credentials) executes. Compromising Aegis's decision logic does not,
by itself, grant custody of funds.

## 10. Honest limitations

- **Tail truncation is not detectable from a single snapshot.** Deleting the most
  *recent* ledger entries leaves a fully self-consistent remaining chain — there is
  nothing after the cut to contradict. The verifier's `--compare` mode partially
  mitigates this across two exports taken at different times; it does not solve it for
  one artifact examined in isolation. See [`verifier/README.md`](../verifier/README.md).
- **Single ledger signing key.** No threshold signing or HSM in the current
  implementation — the process holding `AEGIS_LEDGER_PRIVATE_KEY_HEX` is a single point
  of trust for new entries going forward (past entries remain independently verifiable
  even if that key is later compromised, since verification uses the *public* key).
- **No multi-hop collusion-graph analysis.** The behavioral baseline is per-agent, not
  a network-wide anomaly model — named as explicitly out of scope, not silently missing.
- **Demo mode's risk judgment is not AI evaluation.** Every escalation reproducible
  without external credentials comes from the disclosed deterministic baseline checks,
  never from a live model call.
- **Not production-ready for real money.** Correctness under concurrency has been load-tested
  at the scale of one developer machine (see [LOAD_TESTING.md](LOAD_TESTING.md)); it has not been
  tested at production volume or soak duration, penetration-tested, integrated with a real agent
  framework, run against live AI/payment credentials, or exposed to real users or real money.
