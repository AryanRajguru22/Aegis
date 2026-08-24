# System Architecture

Assumes [TRUST_MODEL.md](TRUST_MODEL.md) and [THREAT_MODEL.md](THREAT_MODEL.md). This
document describes the components, the transaction lifecycle, and the long-term vs.
hackathon split. The hackathon-specific scoping and stack choice lives in
[MVP_SCOPE.md](MVP_SCOPE.md); this document describes the architecture those choices
implement.

## 1. Component overview

```
Principal
   |
   |  delegates (Intent Mandate: goal, funding source, top-level caveats)
   v
Root Agent  --(spawns, attenuates token)-->  Sub-agent  --(spawns)-->  Sub-agent
   |                                              |                        |
   +---------------------+-----------------------+------------------------+
                          |
                          v
              [ AEGIS: Policy Decision + Risk Engine ]
                 - Capability verifier (Biscuit chain)
                 - Rule-based policy engine (caveats, budgets)
                 - Intent-consistency risk engine (LLM judge)
                 - Behavioral baseline engine
                 - Simulation / dry-run endpoint
                 - Delegation graph + revocation authority
                 - Hash-chained audit ledger
                          |
             +------------+-------------+
             |            |             |
             v            v             v
        Rail Adapter  Rail Adapter  Rail Adapter
        (card / TAP)  (stablecoin/  (bank / ACP /
                        x402)        agent-to-agent)
             |            |             |
             v            v             v
          Merchant     Merchant      Counterparty
                                        Agent
```

Aegis is deliberately positioned as **middleware**: every rail adapter is a thin,
swappable translation layer between Aegis's internal decision representation and a real
rail's API shape. Adding a new rail means writing a new adapter, not changing the policy
or risk engine.

## 2. Transaction lifecycle

1. **Delegation.** Principal creates a root Agent Record with a delegated goal, a
   funding-source reference, and top-level capability token caveats (max spend, allowed
   categories, expiry).
2. **(Optional) Sub-agent spawn.** Root agent (or any agent) requests a narrower
   capability token for a sub-agent; Aegis attenuates it and records the new node in the
   delegation graph.
3. **Intent formation.** An agent decides to attempt a transaction and constructs a
   transaction request: amount, counterparty, category, rail, and — critically — a short
   natural-language statement of *why* (what task this serves).
4. **Simulate (dry-run).** The agent (or its calling framework) calls Aegis's
   `/simulate` endpoint first. Aegis returns a verdict — allow / deny / escalate — plus
   the reasoning, *without* touching a rail. This is optional in principle but is the
   pattern we want agents built against, because it lets an agent (or its developer)
   correct course before anything real happens.
5. **Policy check.** Aegis verifies the full capability-token ancestry chain
   (attenuation math, expiry, caveat satisfaction) against the requested transaction.
   Fails fast and cheaply if this alone rejects it.
6. **Risk check.** If policy passes, Aegis's risk engine evaluates: (a) intent-
   consistency — does this transaction's stated purpose and shape match the agent's
   delegated goal (LLM-judge comparison), and (b) behavioral-baseline — is this
   transaction anomalous relative to this agent's own recent history (rate, size,
   category shift).
7. **Verdict.** Combined into one decision: **allow**, **deny**, or **escalate to
   human**. Escalation pauses the transaction and notifies a human reviewer with full
   context (delegated goal, triggering rule, risk reasoning).
8. **Execution.** On allow (directly or after human approval), Aegis hands the
   transaction to the appropriate rail adapter, which executes against the real (or, for
   the demo, sandboxed/mocked) rail.
9. **Settlement callback.** The rail adapter reports back success/failure; Aegis records
   the outcome.
10. **Ledger write.** Every step above (simulation, policy verdict, risk verdict, human
    decision if any, execution result) is appended to the hash-chained audit ledger as
    linked, immutable entries — the full decision trail, not just the final outcome.

## 3. Financial policy engine

Two layers, deliberately kept separate because they have very different failure modes
and cost profiles (see [THREAT_MODEL.md](THREAT_MODEL.md) §11):

- **Deterministic layer:** capability-token/caveat verification — spend limits (amount +
  window), category/merchant allowlists, rail allowlists, expiry, delegation-chain
  integrity. Fast, no external dependency, always runs first, can hard-block.
- **Judgment layer:** the risk engine (below). Slower, depends on an external LLM call,
  configured to degrade to escalation rather than hard block on failure/timeout.

Policy is expressed as data (caveats attached to a capability token), not code — an
organization defines what an agent may do by minting a token with the right caveats, not
by writing conditional logic Aegis has to interpret. This keeps the policy model
auditable and makes attenuation (§ TRUST_MODEL.md) mechanically simple: narrowing a
policy is narrowing a data structure, not editing code.

## 4. Risk engine

- **Behavioral baseline:** a rolling statistical model per agent (or per delegation
  tree) — typical transaction size, rate, category distribution, counterparty set.
  New transactions are scored for deviation from this baseline. This is the closest
  component to "traditional" anomaly detection and is treated as such — useful, not the
  headline differentiator (see [DIFFERENTIATION.md](DIFFERENTIATION.md) §4).
- **Intent-consistency check:** the differentiated piece. The agent's delegated goal
  (natural language, captured at creation) and the proposed transaction's stated purpose
  are both passed to an LLM-judge call, which returns a structured verdict: consistent /
  inconsistent / ambiguous, with a short rationale. This is what catches the "technically
  within limits but not what this agent was for" case central to
  [DIFFERENTIATION.md](DIFFERENTIATION.md) §3.3.
- **Composite risk score:** baseline deviation + intent-consistency verdict + any
  static-rule proximity (e.g., "within 5% of spend cap") combine into the escalate/deny/
  allow decision. Thresholds are configurable per organization/agent, not hardcoded.

## 5. Audit and accountability

- Every Aegis decision (simulate, policy verdict, risk verdict, human action, execution
  result) is a ledger entry containing: a content hash of the entry, the hash of the
  previous entry for that delegation tree (or globally, depending on scale — see
  Data Architecture), and a signature. This produces a **tamper-evident hash chain**: any
  retroactive edit to an entry breaks every subsequent hash, which is independently
  verifiable by recomputing the chain. This is honestly described as **tamper-evident**,
  not "blockchain" or "trustless/decentralized" — there is a single ledger operator
  (Aegis) in the MVP; the cryptographic property is detection of tampering, not
  elimination of a trusted party. A production version could anchor periodic ledger
  roots to a public chain for external, third-party verifiability without changing the
  core design.
- The ledger is queryable per-agent, per-delegation-tree, or per-principal, and is the
  single source of truth an auditor or compliance reviewer would use — this unification
  across rails and agents is the specific accountability differentiator (see
  [DIFFERENTIATION.md](DIFFERENTIATION.md) §3).

## 6. Revocation / emergency controls

- Revocation targets a node in the delegation graph (an Agent Record). Because every
  descendant's capability-token verification requires its full ancestry chain to be
  currently valid (not just cryptographically well-formed), marking an ancestor revoked
  makes every descendant's *next* verification fail immediately — no need to individually
  track down and invalidate each sub-agent's token.
- Revocation is itself a ledger entry (attributed: who revoked, when, why), satisfying
  the accountability requirement even for emergency actions.
- A revoked agent's *in-flight* transaction (already past the policy check, mid-execution
  at a rail) is a real edge case: the MVP demo scopes this by keeping the window between
  "allow" and "execute" short and by having the rail adapter re-check revocation status
  immediately before calling the rail. Full transactional guarantees here (i.e.,
  guaranteed-cancellable in-flight execution) are a production hardening item, not
  claimed as solved.

## 7. Security architecture

- **Principle of least standing privilege:** capability tokens, not ambient credentials;
  short expiries; attenuation-only delegation (TRUST_MODEL.md §1, §3).
- **Fail closed** (TRUST_MODEL.md §1.5): unreachable dependency → deny/escalate, never
  silent-allow.
- **Separation of decision and custody:** Aegis never holds rail credentials/private
  keys for moving money — it authorizes, a rail adapter (using the rail's own
  credential/key material, scoped narrowly) executes. Compromising Aegis's decision
  logic does not, by itself, grant custody of funds (THREAT_MODEL.md §10).
- **Signed, attributable everything:** identity assertions, mandates, policy changes, and
  ledger entries are all signed; nothing enters the trusted decision path unsigned.

## 8. API architecture

Aegis exposes a small number of purpose-built endpoints rather than a generic CRUD API,
because the product is a decision service, not a database:

- `POST /agents` — register an Agent Record (principal, delegated goal, parent, initial
  caveats) → returns a capability token.
- `POST /agents/{id}/attenuate` — mint a narrower sub-agent token from a parent's.
- `POST /simulate` — dry-run a proposed transaction, returns a verdict without executing.
- `POST /transactions` — submit a transaction for real evaluation + (if allowed)
  execution via the appropriate rail adapter.
- `POST /agents/{id}/revoke` — revoke a node and cascade.
- `GET /ledger` (filterable by agent/tree/principal/time range) — query the audit trail.
- `GET /agents/{id}/graph` — the current delegation tree, for visualization.
- A WebSocket/SSE stream of live decisions, for the real-time dashboard.

This is intentionally a **decision API**, callable by an agent framework as a library/SDK
wrapper (so an agent developer adds "call Aegis before you pay" as one step in their
existing tool-use loop) rather than requiring agents to be rebuilt around Aegis.

## 9. Data architecture

- **Agent Records / delegation graph:** relational (principal → agent → sub-agent
  edges), since integrity of the ancestry chain is the whole security property — a
  graph/relational store with strong consistency, not an eventually-consistent store.
- **Capability tokens:** not stored as the source of truth themselves (they're
  self-contained, verifiable credentials) — Aegis stores the *caveats it issued* so it
  can reason about and display them, but verification of a presented token is
  cryptographic, not a database lookup (this is what makes attenuation fast and
  offline-capable).
- **Audit ledger:** append-only, hash-chained. Never updated or deleted, only appended.
  Partitioned per delegation-tree-root for scalability in production while still
  supporting a global verifiable order via periodic checkpoint hashes.
- **Behavioral baselines:** derived/materialized from the ledger, recomputed
  incrementally — not a separate source of truth, so there's never a question of the
  baseline disagreeing with the record of what actually happened.

## 10. Long-term infrastructure architecture (post-hackathon)

If this became a real company, the architecture should evolve toward:

- **Pluggable rail adapters as a real integration marketplace**, covering AP2, Visa TAP,
  Mastercard AP4M, x402, Stripe ACP, plus direct bank rails — genuinely rail-agnostic at
  the scale the pitch claims, not just the 2 rails feasible in 10 days.
- **Federated identity**, accepting real Okta/Auth0/Descope/WorkOS/SPIFFE/Skyfire
  assertions instead of Aegis-issued stand-in identity tokens.
- **Ledger anchoring** to a public chain (periodic Merkle-root checkpoints) for
  third-party-verifiable audit trails, addressing the "single trusted operator" honesty
  note in §5.
- **Multi-hop graph analysis** across the full ledger for the collusion/laundering-chain
  threat named but not solved in [THREAT_MODEL.md](THREAT_MODEL.md) §6.
- **Threshold/HSM-backed signing** for Aegis's own decision-signing keys, so no single
  compromised instance can unilaterally approve high-value transactions
  (THREAT_MODEL.md §10).
- **Regulatory posture work**: even though Aegis never custodies funds (deliberately, to
  avoid money-transmitter scope at MVP stage), a real company operating at scale in
  agent finance will need real compliance engagement — this is named as a known future
  cost, not solved by architecture alone.

## 11. Most technically difficult components

Ranked by genuine implementation difficulty for a 10-day team, informing the MVP scoping
in [MVP_SCOPE.md](MVP_SCOPE.md):

1. **Correct capability-token attenuation with cascading revocation**, demonstrated live
   and provably correct (not just "trust us it works") — the cryptographic chain
   verification and the revocation propagation both need to be genuinely right, not
   simulated in the UI.
2. **Low-latency composite risk decision** (deterministic checks + LLM-judge call)
   returned fast enough that a live demo doesn't stall waiting on it.
3. **A visually compelling, *real-time*, correct delegation-tree + transaction-stream
   dashboard** — this is as much a hard engineering problem (state sync, live graph
   layout) as it is a design problem.
4. **Two genuinely different, working rail adapters** (not two UI skins over one fake
   backend) — proving rail-agnosticism requires the two rails to actually behave
   differently under the hood.

## 12. Most differentiated components

See [DIFFERENTIATION.md](DIFFERENTIATION.md) §3 for the full argument; in one line each:
(1) the rail-agnostic unified policy decision point, (2) capability-attenuated
delegation trees with cascading revocation, (3) the intent-consistency risk engine, (4)
pre-execution simulate combining policy + risk + budget forecast in one call.
