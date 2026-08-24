# MVP Scope

Assumes everything in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and
[DIFFERENTIATION.md](DIFFERENTIATION.md). This document is the answer to "what do we
actually build in 10 days" — including three candidate versions, why the middle one is
recommended, the smallest core that still demonstrates the real thesis, a concrete tech
stack, and the demo script.

## 1. Three candidate versions

### V1 — "Guardrail" (leanest, lowest-risk)
Single rail (Stripe test mode only), rule-based policy engine only (no LLM-judge risk
engine), capability tokens present but no live delegation-tree visualization, basic
append-only log (not demonstrably hash-chained in the UI).
- **Pro:** Very achievable in 10 days, low technical risk.
- **Con:** This is, honestly, a spending-limit wrapper around Stripe — exactly the
  "generic AI wallet / simple spending-limit system" the brief said not to build. It
  demonstrates none of the four differentiated capabilities in
  [DIFFERENTIATION.md](DIFFERENTIATION.md) §3. **Not recommended.**

### V2 — "Trust Mesh" (recommended MVP)
Two heterogeneous rails (Stripe test mode + a mock x402-style stablecoin endpoint we
build ourselves), a live delegation tree with real Biscuit-token attenuation and
cascading revocation, the intent-consistency risk engine (Claude as LLM-judge) alongside
deterministic policy checks, a pre-execution `/simulate` endpoint, a hash-chained ledger
with a UI that lets a judge verify tamper-evidence live, and a real-time force-graph
dashboard of agents/sub-agents and the transaction stream.
- **Pro:** Demonstrates all four differentiated capabilities, honestly scoped, achievable
  by treating the two rails as thin adapters rather than deep integrations.
- **Con:** Meaningfully more work than V1; requires discipline to not gold-plate any one
  component. See §3 for the cut list if time runs short.
- **This is the recommended target.**

### V3 — "Full Vision" (long-term, not a 10-day target)
Real integrations with AP2 mandate ingestion, Visa TAP and/or Mastercard AP4M as actual
rails, federated identity via a real IdP (Okta/Auth0), multi-hop graph analysis for
collusion detection, ledger anchoring to a public chain, and a regulated-partner path
(à la Catena Labs) for actually holding value. This is what Aegis becomes **if the
startup succeeds** — described fully in the final summary at the end of this
conversation, not something to scope for the hackathon.

## 2. The smallest technically feasible core (the non-negotiable floor)

If time is cut short, this is the minimum that still demonstrates the real thesis rather
than degrading into a toy — cutting below this list means the demo no longer proves
anything [DIFFERENTIATION.md](DIFFERENTIATION.md) claims:

1. A root agent with a real delegated goal (natural language, stored and used).
2. At least one sub-agent spawned at runtime with a **cryptographically attenuated**
   (provably narrower, not just UI-labeled-narrower) capability token.
3. At least **two** different rails a transaction can be routed through, so
   rail-agnosticism is demonstrated, not asserted.
4. A `/simulate` call that returns a real policy+risk verdict before execution.
5. At least one transaction that is **numerically within policy but flagged by the
   intent-consistency check** — this single moment is the "holy shit" beat; without it,
   Aegis looks identical to a static spending-limit tool.
6. A revoke action on the root (or an intermediate) agent that visibly and immediately
   cuts off a sub-agent's ability to transact.
7. A ledger view where a judge can see the hash chain and understand (in one sentence)
   why tampering with an old entry would be detectable.

Everything else (polish, a third rail, richer dashboards, more elaborate policy
templates) is additive, not load-bearing.

## 3. Cut list, in order, if time runs short

1. Cut: multiple risk-rule types beyond the one intent-consistency demo scenario.
2. Cut: a third rail.
3. Cut: sophisticated behavioral-baseline statistics (a hardcoded/simplified
   "unusual for this agent" heuristic is fine for the demo if genuinely time-constrained
   — but this must be disclosed to judges if asked, not presented as more than it is).
4. Never cut: the two rails, the attenuated delegation tree, the simulate endpoint, the
   one drift-catch demo moment, cascading revocation, and the hash-chained ledger view —
   these seven items in §2 are the whole pitch.

## 4. Recommended technical stack

Chosen to maximize hackathon velocity (single primary language, minimal moving infra)
while keeping every "technically impressive" claim real rather than mocked:

- **Language/runtime:** TypeScript end-to-end (Node backend + Next.js frontend). One
  language keeps a small team fast; TypeScript has solid crypto and WebSocket tooling
  and avoids needing a second Python service just for the LLM-judge call (that's a
  regular API call to Claude, not a local ML workload).
- **Capability tokens:** [Biscuit](https://www.biscuitsec.org/) (`biscuit-wasm`/
  `@biscuit-auth` bindings) — real, maintained, offline-attenuation, Datalog-based
  caveats. This is a deliberate choice over inventing our own token format: using the
  same primitive the real ecosystem (SatGate, the IETF draft) is converging on is *more*
  credible to informed judges, not less, and it's genuinely less work than designing and
  securing a bespoke format.
- **LLM-judge:** Claude (Sonnet) via the Anthropic API, given a structured prompt with
  the agent's delegated goal and the proposed transaction, returning a structured
  consistent/inconsistent/ambiguous verdict with rationale. No fine-tuning, no local
  model.
- **Database:** Postgres (Neon or Supabase for zero-ops hosting) — relational for the
  Agent Record delegation graph (integrity of ancestry matters), and the audit ledger as
  an append-only table where each row stores `content_hash` and `prev_hash` (per
  delegation-tree, chained) — a straightforward hash-chain, correctly described as
  **tamper-evident**, not as "a blockchain."
- **Rail 1 (card):** **Stripe, test mode.** Real API, real judge-recognizable brand,
  zero cost, safe. This is the rail that makes the demo feel like "real money," even
  though no real money moves.
- **Rail 2 (stablecoin-style):** a small mock service we build that mimics the x402
  pattern (HTTP 402 + payment requirements + signed retry) — genuinely different
  request/response shape and settlement model from Stripe, which is exactly what proves
  rail-agnosticism rather than two skins over one path. (A real x402/testnet integration
  is a reasonable stretch goal, not a requirement — see cut list.)
- **Real-time dashboard:** Next.js + WebSocket (or SSE) pushing live ledger events; a
  force-directed graph view (e.g., a lightweight D3/force-graph library) rendering the
  delegation tree growing, transactions flowing, and a visible red "blocked/escalated"
  state on the flagged transaction, plus an obvious revoke button whose effect is shown
  propagating through the tree live.

## 5. Demo script (the "holy shit" moment)

1. Principal delegates a root agent: *"Book the cheapest flights and hotels for our
   conferences this quarter, budget $2,000."* Root agent's capability token is minted
   with that goal and a $2,000/quarter cap.
2. Root agent spawns two sub-agents live on screen — a "flights" sub-agent and a
   "hotels" sub-agent — each with a visibly narrower, cryptographically attenuated token
   (smaller budget, narrower category).
3. Flights sub-agent books a flight via **Rail 1 (Stripe test mode)** — visibly allowed,
   ledger entry appears, dashboard updates in real time.
4. Hotels sub-agent pays a vendor via **Rail 2 (mock x402 stablecoin rail)** — same
   Aegis decision path, different rail under the hood — proving rail-agnosticism, not
   just claiming it.
5. **The moment:** the flights sub-agent then attempts a $380 purchase of "GPU cloud
   credits" — well under its remaining budget, from a technically-allowed category if you
   only checked numbers. Aegis's intent-consistency check catches the mismatch against
   the delegated goal ("book flights/hotels for conferences") and **escalates to a
   human** instead of silently allowing it, visibly explaining why in plain language.
   This is the single moment that proves Aegis is not a spending-limit tool.
6. Principal, from the dashboard, hits **revoke** on the root agent. Both sub-agents'
   next transaction attempts fail instantly and visibly — the cascading-revocation
   payoff.
7. Judge opens the ledger view: every step above is there, hash-chained, and the
   presenter shows that editing an old entry would break the chain — the accountability
   payoff, made concrete rather than asserted.

This script hits, in order: delegation, attenuation, rail-agnosticism (twice, on two
real different rails), the intent-consistency differentiator (the actual "holy shit"
beat), cascading revocation, and verifiable audit — i.e., every claim in
[DIFFERENTIATION.md](DIFFERENTIATION.md) §3, demonstrated rather than described, in
under three minutes.

## 6. Prototype vs. production, named explicitly

| Component | Hackathon MVP | Production (V3) |
|---|---|---|
| Identity | Aegis-issued stand-in tokens | Federated via Okta/Auth0/Descope/WorkOS/SPIFFE/Skyfire |
| Mandates | Our own delegated-goal field | Ingest real AP2 Intent/Cart Mandates |
| Rails | Stripe test mode + mock x402-style endpoint | Real Visa TAP, Mastercard AP4M, x402, Stripe ACP, bank rails |
| Ledger | Postgres hash-chain, single operator | Same design, periodically anchored to a public chain for third-party verifiability |
| Risk engine | Single intent-consistency check + simple baseline heuristic | Full behavioral modeling + multi-hop collusion graph analysis |
| Custody | None — Aegis never holds funds, by design at every stage | Same principle held even at scale; regulatory engagement as a separate, named future workstream |
