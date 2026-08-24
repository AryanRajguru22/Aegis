# Differentiation

Read [MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md) first. This document assumes
that landscape and answers the harder question: given how saturated it is, what — if
anything — can Aegis be that isn't a worse rebuild of something that already exists?

## 1. The core thesis, stated precisely

> Every existing player answers **"is this one transaction authorized?"** at the moment
> of execution. Nobody we found answers **"should this agent, given everything it has
> done and everything it was actually delegated to do, be allowed to do this — right now,
> across whichever rail it's about to use?"**

That distinction matters because of *where* each layer sits:

- **Identity layer** (Okta, Auth0, Descope, WorkOS, SPIFFE, Skyfire KYA): proves *who*
  is asking.
- **Mandate/rail layer** (AP2, Visa TAP, Mastercard AP4M, x402, Stripe ACP): proves *this
  specific transaction* was authorized by a signed credential and executes it.
- **Wallet/policy layer** (Fireblocks, Payman): enforces *static numeric caveats*
  (limits, scopes, time windows) on funds it custodies.

All three layers are **point-in-time and per-rail**. None of them holds a persistent,
cross-rail model of *one agent's entire financial existence* — its original delegated
goal, its behavioral baseline, its sub-agents, its running exposure across every rail it
touches simultaneously. That model is what Aegis is.

This is the same shape of move as Okta itself: Okta didn't invent OAuth, SAML, or
passwords — it became indispensable by being the control plane that made an
organization's *use* of many identity protocols coherent, auditable, and governable from
one place. Aegis proposes to do that for **agent financial authority**, not identity.

## 2. "Why isn't this just Fireblocks?" — the sharpest version of the question

Fireblocks is the closest existing product, so it deserves the most direct answer.

| | Fireblocks Agentic Payments Suite | Aegis |
|---|---|---|
| Scope | Funds custodied in a Fireblocks wallet, spent via stablecoin/x402 rails Fireblocks supports | Any rail (card, stablecoin, bank, agent-to-agent), custody-agnostic |
| Enforcement | Static caveats: scope, spend limit, time window, revocable | Static caveats **plus** continuous semantic/behavioral evaluation against the agent's original delegated intent |
| Unit of governance | A single agent's wallet | A **delegation tree** — root agent and every sub-agent it spawns, with attenuated (never-exceeding) authority at each level |
| Audit trail | Per-wallet transaction history | Unified, hash-chained ledger spanning every rail and every agent in a delegation tree, so a human/auditor sees one coherent story instead of N per-rail logs |
| Revocation | Revoke a wallet's access | Revoke a node in a delegation tree and watch authority **cascade-revoke** through every descendant sub-agent instantly |
| Decision timing | At execution | **Before** execution — a simulate/dry-run step returns a policy+risk verdict the caller can act on before committing |

None of these five differences require Fireblocks to be wrong or beatable on its own
turf — it isn't, and we shouldn't try to out-custody a custody company in 10 days. They
require Aegis to sit **one layer up**: Fireblocks (and Visa TAP, and x402, and Stripe)
become *rails Aegis can authorize spend on*, not things Aegis replaces.

## 3. The four capabilities that are actually new

Checked individually against every player in
[MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md), these four are where we did not
find an existing shipped product doing the same thing, even though each borrows
real, credible prior art rather than inventing primitives from nothing:

### 3.1 Rail-agnostic unified policy decision point (PDP)
**What exists:** Every mandate/rail protocol (AP2, TAP, AP4M, x402, ACP) is scoped to
its own rail. An organization running agents across a card rail and a stablecoin rail
today has two separate policy surfaces, two separate logs, no shared "total exposure"
view.
**What's new:** One policy decision — "may this agent spend $X on Y right now" —
evaluated identically regardless of which rail will ultimately execute it, with a single
place that knows the agent's *total* exposure across all of them.
**Real prior art we build on:** API gateway / policy-decision-point (PDP) architecture
from zero-trust security (e.g., OPA/Rego-style externalized policy evaluation) — a
well-understood pattern, just not applied here.

### 3.2 Capability-attenuated delegation trees with cascading revocation
**What exists:** Capability tokens for agents (SatGate, IETF draft) prove a *single*
agent's authority is properly scoped. Fireblocks can revoke a wallet.
**What's new:** Modeling an agent's *dynamically spawned sub-agents* as a live tree,
where each node's Biscuit token is cryptographically provable to be a strict subset of
its parent's, and where revoking any node instantly and verifiably cuts off every
descendant — demonstrated live, visually, for a tree the demo audience watches grow and
get pruned in real time.
**Real prior art we build on:** Biscuit tokens (macaroon-derived, offline attenuation,
Datalog caveats) — a real, maintained, credible library, not an invented format.

### 3.3 Intent-consistency risk engine (semantic drift detection)
**What exists:** Numeric/rule-based policy everywhere (spend limits, merchant allowlists,
time windows). Separately, "agent drift" is an active *research* topic (multiple 2026
arXiv papers on semantic/behavioral drift in long-horizon agents) — but we found no
shipped product that scores a proposed *financial* transaction against the agent's
original natural-language delegated goal using an LLM-as-judge, in addition to numeric
caveats.
**What's new:** A transaction can be well within every numeric limit (under the spend
cap, from an allowed merchant, correctly signed) and still be *wrong* — e.g., an agent
delegated to "book the cheapest flights under $400 for conferences" attempting to buy
$380 of GPU credits. Aegis's risk engine compares the semantic content of a proposed
transaction against the agent's Intent Mandate and its own behavioral history, flags the
mismatch, and can require escalation even though no static rule was broken.
**Real prior art we build on:** LLM-as-judge evaluation (well-established pattern for
semantic comparison) applied to a domain — financial intent-consistency — where it
isn't yet productized.

### 3.4 Pre-execution simulate/dry-run combining policy + risk + budget forecast
**What exists:** Dry-run/shadow-mode interceptors exist generically; DeFi bots simulate
transactions for gas/revert checks.
**What's new:** A single call that returns "if this transaction executed, here is the
policy verdict, the risk score, the remaining budget after, and the effect on the
delegation tree's aggregate exposure" — *before* anything is signed or sent to a rail —
specifically for the financial-agent decision, not a generic action.

These four compose into one thing: **a rail-agnostic, delegation-aware, semantically-
informed policy and accountability plane for autonomous agent finance.** That is the
product. Everything else (identity proofs, mandate formats, actual money movement) is
deliberately sourced from the ecosystem in §1 of MARKET_AND_COMPETITION.md, not rebuilt.

## 4. What we explicitly do NOT claim as differentiated

To keep the pitch honest and avoid the exact failure mode this document exists to
prevent:

- **Not differentiated:** "We give agents cryptographic identity." (Skyfire, Okta,
  SPIFFE, Auth0 all do this.)
- **Not differentiated:** "We let a human set a spending limit for an agent." (Every
  player in the landscape does this — it's table stakes, not a pitch.)
- **Not differentiated:** "We create an audit trail." (AP2 mandates already form a
  non-repudiable signed chain; the *unification across rails and delegation trees* is
  the differentiated part, not the existence of logging.)
- **Not differentiated:** "We use blockchain/stablecoins for agent payments." (x402,
  Mastercard AP4M, Crossmint, Catena Labs are all already there, with far more rail
  integration than we can build in 10 days.)
- **Not differentiated:** "We do fraud detection." (A commodity capability with dozens
  of incumbents re-skinning it as "agentic"; we should not lead with this framing —
  our risk engine's specific claim is intent-consistency against a delegated goal, not
  generic anomaly detection.)

## 5. Compete, integrate, or ignore — summary table

| Layer | Representative players | Aegis stance |
|---|---|---|
| Identity / "who is this agent" | Okta, Auth0, Descope, WorkOS, SPIFFE, Skyfire | Integrate (consume as input) |
| Mandate capture / "what was I asked to do" | Google AP2, Nekuda | Integrate (consume Intent Mandates as input) |
| Payment execution rails | Visa TAP, Mastercard AP4M, x402, Stripe ACP, Crossmint | Integrate (rail adapters; execute through them, never around them) |
| Wallet custody + static policy | Fireblocks, Payman | Integrate where possible; differentiate on the decision layer above them |
| Agent-to-agent transport | Google A2A, AGNTCY | Integrate (carry our tokens over their transport) |
| Regulated banking for agents | Catena Labs | Long-term partner/integration path, not a 10-day target |
| **Policy decision + behavioral risk + delegation-tree accountability across all of the above** | **Nobody found shipping this today** | **This is Aegis** |
