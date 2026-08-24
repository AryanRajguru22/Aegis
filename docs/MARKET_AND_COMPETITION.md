# Market and Competition

This document exists to prevent us from calling something innovative because it *sounds*
innovative. Before any capability is claimed as an Aegis differentiator, it is checked
against this landscape. If the landscape is wrong or stale, this file must be updated
before the claim is trusted again.

**Read this first, before anything else in `docs/`.** The rest of the design only makes
sense in light of how saturated this space already is.

---

## 1. The headline finding

As of August 2026, nearly every individual capability in the original Aegis brainstorm
list already exists, in production or near-production, usually backed by a company with
more distribution than a 10-day hackathon team can ever out-build:

| Capability | Who already ships it |
|---|---|
| Agent identity / "know your agent" | Skyfire (KYA), Okta for AI Agents, Auth0 (agents as first-class identities), Descope Agentic Identity Hub, WorkOS AuthKit + `auth.md`, SPIFFE/SVID workload identity |
| Delegated financial authority ("mandates") | Google AP2 (Intent / Cart / Payment mandates, W3C Verifiable Credentials), Visa Trusted Agent Protocol (TAP), Nekuda "Agentic Mandates" |
| Capability-scoped spend tokens | SatGate (macaroon-based agent capability tokens with budget caveats), IETF draft `attenuating-agent-tokens`, Fireblocks Policy Engine |
| Payment execution rails for agents | Mastercard Agent Pay / Agent Pay for Machines (agent-to-agent), Visa TAP, Coinbase x402 (stablecoin, HTTP 402), Stripe Agentic Commerce Protocol (ACP, with OpenAI), Crossmint (wallets/cards/stablecoins) |
| Agent-native banking / custody | Catena Labs (chartered trust bank for agents, founded by USDC co-creator), Fireblocks Agentic Payments Suite, Crossmint |
| Agent-to-agent communication/discovery | Google A2A, AGNTCY (Cisco/LangChain/Galileo/LlamaIndex/Glean) |
| Pre-execution simulation / dry-run | Microsoft Defender for AI Agents (pre-action evaluator + shadow execution), general "dry-run interceptor" pattern already standard in agent-ops tooling |
| Fraud/anomaly detection framing | Every incumbent fraud vendor (Trustpair, Protegrity, etc.) has an "agentic" product page; no dominant agent-native pure-play yet |
| Human escalation / approval workflows | Payman (approval thresholds), virtually every agent-ops platform |

Several of these are not scrappy startups — they are **network-backed standards** with
real governance: AP2 was donated by Google to the FIDO Alliance; MCP was donated by
Anthropic to the Agentic AI Foundation under the Linux Foundation; x402 has its own
Foundation co-run by Coinbase and Cloudflare. That level of institutional weight means
Aegis cannot plausibly position itself as *replacing* any of these. Trying to would be
building a competing electrical grid instead of a better appliance.

**Implication for Aegis:** we do not win by inventing a new identity protocol, a new
payment rail, or a new capability-token format. Those are being commoditized and
standardized in real time by parties with far more reach. We win, if we win at all, by
being the layer that makes sense of *all of them at once* — see
[DIFFERENTIATION.md](DIFFERENTIATION.md).

---

## 2. Detailed player-by-player breakdown

For each entry: what they do, how it works, what's missing, and whether Aegis should
compete, integrate, or ignore.

### 2.1 Google AP2 (Agent Payments Protocol)
- **What it is:** An open standard, announced Sept 2025, with 60+ launch partners
  (Mastercard, PayPal, Coinbase, Amex, Salesforce), now being handed to the FIDO Alliance.
- **How it works:** Three chained, cryptographically signed W3C Verifiable Credentials —
  an **Intent Mandate** (user delegates authority, with constraints like max price,
  expiry, allowed merchants), a **Cart Mandate** (user signs a specific cart at a
  specific price, hardware-backed device key), and a **Payment Mandate** (derived
  credential the payment network sees). v0.2.0 (April 2026) added "Human Not Present"
  payments for pre-authorized autonomous purchases.
- **Gap:** AP2 authorizes *one purchase at a time*. It has no concept of an agent's
  cumulative behavior across hundreds of transactions, no delegation-chain semantics for
  sub-agents spawned by an agent, and (per the "Whispers of Wealth" red-team paper) a
  demonstrated prompt-injection attack surface at the mandate-construction step — the
  mandate is only as trustworthy as the agent that assembled it.
- **Aegis stance:** **Integrate, don't compete.** Treat an AP2 Intent Mandate as one
  valid *input* to Aegis's policy decision, not a competing product.

### 2.2 Visa Trusted Agent Protocol (TAP)
- **What it is:** Visa's framework (with Cloudflare) for merchants to distinguish
  legitimate AI agents from bot traffic, using cryptographically signed HTTP messages.
- **How it works:** Signed headers carry agent identity, verified user identity, and a
  Payment Account Reference; merchants can trust the request came from a real,
  authorized agent rather than a scraper.
- **Gap:** Visa-network-specific. Says nothing about what happens *before* the
  request — i.e., whether the agent *should* be making this purchase given its broader
  mandate and history. It is a fraud/authenticity signal at checkout, not a policy engine.
- **Aegis stance:** **Integrate as a rail.** TAP-verified transactions are exactly the
  kind of execution-layer proof Aegis should accept and log, not duplicate.

### 2.3 Mastercard Agent Pay / Agent Pay for Machines (AP4M)
- **What it is:** Agent Pay (April 2025) tokenizes a card credential to a specific agent,
  merchant scope, and consent policy ("Agentic Tokens"). AP4M (June 2026) extends this to
  **agent-to-agent** payments — 30+ companies including Coinbase, Stripe, Adyen — with
  permissions/credentials recorded on Polygon, Solana, and Base.
- **Gap:** Same shape as TAP — strong at proving *who* is paying and *that* the token is
  scoped, weak at reasoning about whether a scoped-but-legal transaction is still
  *consistent with why the agent was funded in the first place*.
- **Aegis stance:** **Integrate as a rail** for agent-to-agent settlement, especially
  relevant to our agent-to-agent trust story.

### 2.4 Coinbase x402
- **What it is:** Revives HTTP 402 "Payment Required" for instant, login-free stablecoin
  micropayments. Server responds 402 with payment instructions; agent signs and retries.
  Now governed by the Linux Foundation-hosted x402 Foundation (Coinbase + Cloudflare);
  Fireblocks has joined and added a spend-governance security extension.
- **Gap:** A settlement primitive, not a policy layer. It answers "how does money move
  instantly" not "should this money move."
- **Aegis stance:** **Integrate as a rail** — genuinely the best fit for our
  micropayment / agent-to-agent demo scenarios given how lightweight it is.

### 2.5 Stripe Agentic Commerce Protocol (ACP) / Instant Checkout
- **What it is:** Stripe + OpenAI's open standard powering "buy it in ChatGPT" (Etsy,
  soon Shopify's million+ merchants). One-line-of-code enablement for merchants already
  on Stripe.
- **Gap:** Consumer-checkout shaped. Built for "human asks ChatGPT to buy one thing,"
  not for a fleet of autonomous agents transacting continuously and unsupervised.
- **Aegis stance:** **Integrate as a rail** for the consumer-purchase demo path; useful
  because it's the most "real" and judge-recognizable rail we can plug into with Stripe
  test mode.

### 2.6 Catena Labs
- **What it is:** An AI-native financial institution founded by USDC co-creator Sean
  Neville, $48M raised, filed for a national trust bank charter. Ships the open-source
  **Agent Commerce Kit** (identity, payments, receipts, human-oversight patterns) and
  plans regulated accounts, stablecoin rails across 10 chains, yield on idle balances.
- **Gap:** This is the closest thing to "what Aegis could become in 5 years" that
  already exists — but it is building the *regulated bank* layer (holding funds,
  chartering, custody), not a rail-agnostic policy/risk plane that sits *above* whichever
  bank or rail an organization already uses.
- **Aegis stance:** **Long-term, potential integration or acquisition-target
  relationship, not a direct 10-day competitor.** We are not chartering a bank in a
  hackathon. Their Agent Commerce Kit is worth reading as a reference pattern, not
  copying wholesale — see [DIFFERENTIATION.md](DIFFERENTIATION.md) for why our shape
  differs even where the goals overlap.

### 2.7 Skyfire (KYA / KYAPay)
- **What it is:** Identity ("Know Your Agent" — a signed JWT with verified agent-owner
  info) + payments (KYAPay, USDC settlement, sub-$5 micropayments) for agents, with
  OAuth2/OIDC compatibility.
- **Gap:** Strong on "who is this agent," weaker on "is this specific action consistent
  with what this agent is *for*," and has no delegation-chain/sub-agent model.
- **Aegis stance:** **Integrate as an identity source.** A Skyfire KYA assertion is
  exactly the kind of upstream identity proof Aegis should accept as input.

### 2.8 Payman
- **What it is:** SOC2/PCI platform where funded AI agents pay *humans* (payroll,
  reimbursements, tipping) under programmable policy (daily limits, per-transaction caps,
  approval thresholds). Partnered with Fifth Third Bank and Stripe.
- **Gap:** Policy is static/numeric (limits and thresholds), single-organization
  (agent-pays-human), no cross-agent delegation graph, no semantic/behavioral risk
  scoring.
- **Aegis stance:** **Adjacent, not overlapping.** Different transaction shape
  (agent→human vs. agent→vendor/agent). Worth knowing, not worth imitating.

### 2.9 Nekuda
- **What it is:** Seed-stage (Madrona, Amex Ventures, Visa Ventures) "Agentic Mandates" —
  contextual, verifiable capture of purchasing intent, spend limits, approval conditions.
  Visa Intelligent Commerce launch partner.
- **Gap:** Same shape as AP2 mandates — point-in-time intent capture for a purchase, not
  continuous governance of an agent's financial life or a multi-agent delegation tree.
- **Aegis stance:** **Watch as the closest philosophical competitor at the mandate
  layer**, but their scope (checkout-time intent capture) is narrower than ours
  (continuous, cross-rail, delegation-aware governance).

### 2.10 Fireblocks (Agentic Payments Suite)
- **What it is:** Institutional custody/wallet infrastructure vendor's May 2026 launch:
  Agentic Wallets (scoped permissions, spend limits, **revocable access**, enforced by
  Fireblocks Policy Engine) + Agentic Payments Gateway (merchant-side stablecoin
  acceptance). x402 Foundation member.
- **Gap:** This is the single closest existing product to "Aegis" in spirit — a policy
  engine governing agent spend authority with revocation. But it is **wallet-centric and
  stablecoin/blockchain-centric** — it governs funds that live in a Fireblocks-custodied
  wallet, on rails Fireblocks supports. It does not reason across a card-network
  transaction and a stablecoin transaction as *one governed identity's behavior*, and it
  has no publicly described intent-consistency/semantic-drift risk model — it enforces
  caveats (limits, scopes, time windows), not "does this look like something this agent
  should be doing."
- **Aegis stance:** **This is our most serious point of comparison.** Read
  [DIFFERENTIATION.md](DIFFERENTIATION.md) §2 for the specific, honest answer to
  "why isn't this just Fireblocks."

### 2.11 Identity/authorization infra: Okta, Auth0, Descope, WorkOS
- **What they do:** Treat AI agents and MCP servers as first-class identities. Okta for
  AI Agents (GA April 2026). Auth0 gives agents delegated-scope OAuth-style tokens with
  audit logging. Descope's Agentic Identity Control Plane adds policy-based governance
  and lifecycle management, plus "Outbound Apps" that hold tokens to external tools on
  the agent's behalf. WorkOS shipped `auth.md`, an open protocol (OAuth-based) for agent
  registration, plus WorkOS FGA (Zanzibar-style fine-grained authorization).
- **Gap:** These are **general-purpose** identity/authorization platforms (any API, any
  resource) — they answer "can this agent call this tool/endpoint," not "should this
  agent, given its financial mandate and behavioral history, spend this money right now."
  None of them contain a financial policy or risk model.
- **Aegis stance:** **Integrate as the identity/authorization substrate underneath us.**
  We do not want to rebuild OAuth or an FGA engine. Aegis's capability tokens should be
  able to be *issued through* or *federated with* these platforms, not compete with them
  for "who is this agent" — our value is specifically in the financial decision on top.

### 2.12 SPIFFE / SVID
- **What it is:** CNCF-graduated open standard for short-lived, cryptographically
  verifiable workload identity (X.509 or JWT SVIDs), increasingly proposed for ephemeral
  agent identity instead of static API keys.
- **Gap:** Infrastructure-boundary identity, not cross-organization or financial-capability
  semantics; known limitation is no native cross-protocol identity flow and X.509 issuance
  latency is a poor fit for agents spun up and torn down in milliseconds.
- **Aegis stance:** **Reference pattern for ephemeral sub-agent identity**, not something
  we reimplement from scratch in 10 days, but the *idea* (short-lived, narrowly-scoped,
  cryptographically provable identity for a thing that might exist for 90 seconds) is
  directly relevant to our delegation-tree design.

### 2.13 Capability-attenuation tokens: SatGate, IETF draft, Google DeepMind
- **What it is:** Macaroon/Biscuit-style tokens that let a holder *narrow* their own
  authority offline before handing it to a sub-agent (budget caveats, time windows, route
  scoping), without contacting the issuer. SatGate ships this specifically for AI agents.
  An IETF draft (`draft-niyikiza-oauth-attenuating-agent-tokens`) is standardizing
  JWT-encoded attenuation chains for agentic delegation. Google DeepMind has published
  work validating macaroon-based agent delegation architecture.
- **Gap:** This confirms capability attenuation is **not a novel idea** — it is an
  active, real, converging standardization effort. What's still missing everywhere we
  looked: a product that combines attenuated delegation *with* a semantic/behavioral risk
  layer and a unified cross-rail audit trail. The token mechanics are becoming
  commodity; the judgment layer on top of them is not.
- **Aegis stance:** **Use the real primitive (Biscuit tokens), don't reinvent it.**
  Being honest that this mechanism is prior art — and using a real, credible
  implementation of it — is *more* technically credible to informed judges than
  pretending we invented delegation-chain tokens.

### 2.14 Agent-to-agent protocols: Google A2A, AGNTCY
- **What it is:** A2A (Google, April 2025) — agent discovery ("Agent Cards"), task
  delegation, OAuth2/JWT mutual auth, RSA signatures, wide industry backing (Microsoft,
  AWS, Salesforce, PayPal, LangChain, Cisco...). AGNTCY (Cisco/LangChain/Galileo/
  LlamaIndex/Glean) adds the Open Agent Schema Framework and Agent Connect Protocol.
- **Gap:** Communication and capability-discovery layer, not a financial trust layer.
  Two agents can find each other and prove who they are via A2A; neither protocol says
  anything about whether the financial transaction that results should be allowed.
- **Aegis stance:** **Integrate as the transport our capability tokens ride over** for
  agent-to-agent scenarios — we are the financial-decision payload inside an A2A
  interaction, not a competitor to A2A itself.

### 2.15 Pre-execution simulation
- **What it is:** "Dry-run" / "shadow mode" interceptors are an established pattern in
  agent-ops (e.g., Microsoft Defender for AI Agents' pre-action evaluator), and DeFi bots
  have long simulated transactions before submission (gas estimation, revert checks).
- **Gap:** These exist as generic-action or DeFi-specific patterns. We did not find a
  product that simulates a **financial policy + risk decision** end-to-end
  (would this violate policy, would it look anomalous, what's the downstream budget
  impact) before an agent transaction commits, across heterogeneous rails.
- **Aegis stance:** **Build this — it's real, it's a legitimate technical component, and
  it's an excellent demo moment**, but be honest in the pitch that "simulate before you
  commit" as a *concept* is not new; our contribution is applying it specifically to the
  combined policy+risk+budget decision for financial agent transactions.

---

## 3. What this means for scoping

Two honest conclusions follow from this research, and both shape every other document in
this folder:

1. **Do not pitch Aegis as inventing agent identity, agent payments, or capability
   tokens.** Judges who know this space (increasingly likely — it's been front-page
   fintech news for a year) will immediately place us against Visa/Mastercard/Google/
   Fireblocks/SatGate if we claim novelty there, and we lose credibility instantly.

2. **The honest, defensible gap is the layer that makes an organization's use of *all of
   these* coherent, continuous, and accountable** — not a better rail, not a better
   identity proof, not a better token format, but the **policy decision + behavioral risk
   + unified audit** plane that consumes proofs from all of the above and reasons about an
   agent's entire financial life, not one checkout at a time. That thesis is developed in
   full in [DIFFERENTIATION.md](DIFFERENTIATION.md) and made concrete in
   [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and [MVP_SCOPE.md](MVP_SCOPE.md).
