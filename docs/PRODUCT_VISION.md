# Product Vision

See [MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md) and
[DIFFERENTIATION.md](DIFFERENTIATION.md) for the research this vision is built on. This
document assumes both and states what we're actually building.

## 1. Problem definition

Autonomous AI agents are gaining the ability to act financially on behalf of humans and
organizations — buying, subscribing, negotiating, paying vendors, transacting with other
agents — without a human approving each individual action. The industry's response so
far (2025–2026) has been to build **identity proofs** (who is this agent) and
**one-shot authorization mandates** (was this specific purchase approved) — see the
landscape doc. What's missing is governance of an agent's *entire financial existence*:
what happens across the 500th transaction, not just the 1st; what happens when an agent
spawns three sub-agents to parallelize a task; what happens when a transaction is
technically within every rule but semantically wrong; what happens when something needs
to be shut off *right now* across a tree of agents nobody has a full picture of.

**The question Aegis exists to answer:** how do you give an autonomous agent real
financial agency — not a rubber-stamped single purchase, but the ability to operate
continuously, delegate to sub-agents, and transact across multiple rails — without
giving it unlimited, unaccountable, or un-revocable authority?

## 2. Core Aegis thesis

Aegis is a **rail-agnostic policy decision, behavioral risk, and accountability plane**
that sits above agent identity protocols and payment rails, not a replacement for any of
them. It consumes identity proofs and mandates from the existing ecosystem, evaluates
every proposed transaction against (a) capability-attenuated delegated authority, (b)
semantic consistency with the agent's original goal, and (c) the agent's behavioral
history — *before* money moves, on whichever rail is about to execute it — and produces
one unified, tamper-evident, cross-rail record of every decision it made. See
[DIFFERENTIATION.md](DIFFERENTIATION.md) §1–3 for exactly which parts of this are new
and which are deliberately borrowed from existing standards.

## 3. Actors in the system

- **Principal** — the human or organization that is the ultimate source of financial
  authority (owns the funding source: card, bank account, stablecoin wallet).
- **Root agent** — the agent the principal directly delegates to (e.g., "my
  procurement assistant"), holder of the top-level capability token.
- **Sub-agents** — ephemeral or persistent agents spawned by the root agent (or by
  another sub-agent) to perform narrower tasks, holding attenuated (never-broader)
  capability tokens derived from their parent's.
- **Aegis** — the policy decision point, risk engine, ledger, and revocation authority.
  Aegis never custodies funds and never itself initiates a payment; it decides and
  records, and hands execution to a rail.
- **Counterparty agents** — agents belonging to other principals/organizations, in
  agent-to-agent transaction scenarios.
- **Merchants / vendors / APIs** — traditional service providers, agent-aware or not.
- **Payment rails** — the systems that actually move money: card networks (via TAP/
  AP4M), stablecoin rails (x402), bank transfers, Stripe/ACP. Aegis authorizes; rails
  execute.
- **Identity providers** — Okta/Auth0/Descope/WorkOS/SPIFFE/Skyfire, attesting to agent
  identity upstream of Aegis.
- **Human reviewers** — humans in the loop for escalated, high-risk, or ambiguous
  decisions.
- **Auditors / compliance / regulators** — consumers of the unified audit trail after
  the fact.

## 4. Potential future business model

Not needed for the hackathon, but worth stating honestly since the prompt asks us to
design with company-formation ambition:

- **Usage-based fee on governed decisions**, analogous to a risk/compliance line item
  rather than a payment processing take rate — priced per policy decision evaluated
  and/or per $ of transaction volume governed, since Aegis never touches the money
  itself and shouldn't price like a payment processor.
- **Primary buyer, near-term:** engineering/security/finance teams at companies
  deploying internal agent fleets across multiple vendors and rails who currently have
  no unified way to answer "what did our agents authorize this month, and could we prove
  it to an auditor."
- **Primary buyer, medium-term:** AI agent platform/orchestration vendors (LangChain-
  style frameworks, vertical agent startups) who want to offer "safe autonomous
  spending" as a feature without building trust infrastructure themselves — a
  **B2B2B** motion, similar in shape to how Plaid became infrastructure other fintechs
  built on rather than a consumer product.
- **Longer-term, speculative:** once enough transaction/outcome data exists, an
  underwriting or insurance-like product — Aegis has the best available signal on
  whether an agent's spending behavior is "safe," which is the same signal an insurer of
  agent-caused financial loss would need.

## 5. Potential integrations

See [DIFFERENTIATION.md](DIFFERENTIATION.md) §5 for the full compete/integrate table.
In priority order for a real product roadmap: Google AP2 (mandate ingestion), Visa TAP /
Mastercard AP4M / x402 / Stripe ACP (rail adapters), Okta/Auth0/Descope/WorkOS/SPIFFE
(identity federation), Google A2A / AGNTCY (agent-to-agent transport carrying our
tokens), Slack/email/PagerDuty (human escalation channel).

## 6. What we should NOT build

Explicit non-goals, because the prompt asked and because scope discipline is the whole
game in 10 days:

- **Not a payment rail.** We do not move money ourselves. We authorize; a real rail
  (Stripe test mode, a mock stablecoin endpoint) executes.
- **Not a new identity protocol / IdP.** We consume identity assertions; we do not build
  a general-purpose OAuth server or credential-issuance system from scratch.
- **Not a foundation model.** We call an existing LLM (Claude) for the intent-consistency
  judge; we do not train or fine-tune anything.
- **Not a full KYC/AML pipeline.** Defer to existing providers (Stripe Identity, Persona)
  conceptually; do not attempt to build identity verification from scratch.
- **Not a consumer wallet app.** No end-user-facing wallet UI; Aegis is B2B
  infrastructure, demoed through a developer-facing dashboard.
- **Not a generic agent framework.** We are not competing with LangChain/CrewAI/AutoGen
  as an agent-building tool — we are infrastructure such frameworks (or agents built with
  them) would call into.
- **Not a blockchain / L1 / stablecoin issuer.** We may *use* an existing stablecoin/
  testnet as one demo rail; we do not build settlement infrastructure.
- **Not a generic fraud-detection product.** Our risk engine's claim is narrow and
  specific (intent-consistency against a delegated goal), not "we detect all fraud."
