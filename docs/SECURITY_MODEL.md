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

## 4. Revocation

Revoking an agent (`POST /agents/:id/revoke`) marks that token's identifier revoked.
Verification of any *descendant* token checks its full ancestry, not just its own
signature — so revoking one node makes every token derived from it fail its very next
verification, with no separate cascade/cleanup step to run or forget to run. Revocation
is itself written to the ledger, attributed. The Security workspace's revocation
scenario demonstrates this directly: the same transaction that succeeds before
revocation is denied immediately after, by the real capability layer, not a scripted
before/after.

**Known edge case, not solved**: an in-flight transaction already past the capability
check and mid-execution at a rail when a revocation lands is not guaranteed-cancellable.
The demo scopes this by keeping that window short; full transactional guarantees here
are named in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §6 as production
hardening work, not claimed as solved.

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
- **Not production-ready.** This is a from-scratch technical demonstration — it has not
  been load-tested at real scale, integrated with a real agent framework, or exposed to
  real users or real money.
