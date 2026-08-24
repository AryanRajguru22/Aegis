# Trust Model

Assumes [PRODUCT_VISION.md](PRODUCT_VISION.md) (actors) and
[DIFFERENTIATION.md](DIFFERENTIATION.md) (why Aegis sits above existing identity/mandate
protocols rather than replacing them).

## 1. Governing principles

1. **The human/organizational principal is the only root of trust.** Aegis never
   originates authority — it only ever attenuates, evaluates, and can revoke authority
   that traces back to a principal's explicit delegation.
2. **No standing trust.** A capability token proves an agent *may* attempt an action
   within stated bounds; it does not mean the action *will* be approved. Every
   transaction is re-evaluated by the policy+risk engine at the moment it's attempted,
   regardless of how the token was issued or how many prior transactions succeeded.
   This is the deliberate difference from a one-shot mandate model (AP2/TAP): trust is
   continuously re-verified, not granted once and assumed forever.
3. **Attenuation only, never amplification.** A sub-agent's capability token can only be
   a strict subset of its parent's (narrower spend limit, narrower merchant scope,
   shorter time window, fewer permitted actions). This is enforced cryptographically by
   the token format (Biscuit — see [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)), not
   just by policy convention, so it holds even if the issuing service is compromised
   after the fact.
4. **Short-lived over long-lived.** Capability tokens default to short expiries,
   especially for ephemeral sub-agents. A leaked token should be worthless soon, not
   worthless "whenever someone notices."
5. **Fail closed, not open.** If Aegis cannot reach a rail, cannot get a risk verdict in
   time, or is itself degraded, the default is to deny/escalate, not to let the
   transaction through unevaluated. (This has real cost — it means Aegis becomes a
   dependency an organization must trust operationally — and that tradeoff is named
   explicitly in [THREAT_MODEL.md](THREAT_MODEL.md) rather than hidden.)
6. **Aegis decides and records; it never custodies funds.** This keeps Aegis out of
   money-transmitter/custody regulatory scope for the hackathon and MVP stage, and keeps
   the product honestly scoped as a decision/accountability layer, not a bank.

## 2. Agent identity model

Aegis does not invent an identity protocol (see
[MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md) §2.11–2.12). It defines a minimal
internal identity record and accepts external proofs against it:

- Every agent (root or sub-agent) has an **Agent Record**: a stable ID, a reference to
  its principal, a reference to its parent agent (null for root agents), and a
  human-readable **delegated goal** — the natural-language statement of what this agent
  was created to do. The delegated goal is not decorative; it is the input to the
  intent-consistency risk check in §3 of the authorization model below.
- Identity *proof* (that a request really comes from the agent it claims to be) is
  expected to come from an upstream provider — a Skyfire KYA assertion, an Okta/Auth0/
  WorkOS-issued identity token, or a SPIFFE SVID for infrastructure-internal agents.
  For the hackathon MVP, we issue our own lightweight signed identity tokens that mimic
  this shape, explicitly labeled as a stand-in for a real IdP integration.
- Sub-agents are created dynamically at runtime and must be **registered** (an Agent
  Record created, a capability token derived and attenuated from the parent's) before
  their first transaction attempt; there is no implicit trust from "being spawned by a
  trusted agent" — attenuation must be explicit and provable.

## 3. Authorization / capability model

- Authority is expressed as a **capability token** (Biscuit), not a role or a static
  permission list. A token carries **caveats**: spend limit (amount + currency + time
  window), allowed merchant/counterparty categories, allowed rail(s), expiry, and a
  reference to the delegated goal it was issued against.
- **Attenuation happens offline.** A parent agent (or Aegis, on the parent's behalf) can
  narrow a token's caveats to mint a sub-agent's token without contacting the original
  issuer — this is the specific property that makes fast, ephemeral sub-agent creation
  practical (see [MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md) §2.13).
- **Verification happens at every transaction attempt**, not just at issuance. The rail
  adapter and the Aegis policy engine both check the full caveat chain up to the root
  before allowing execution.
- Authorization is necessary but not sufficient: a transaction can be fully within a
  valid, correctly-attenuated capability token's caveats and still be denied or escalated
  by the risk engine (see [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §risk engine)
  if it fails the intent-consistency check. Capability tokens answer "is this agent
  allowed to try this, structurally"; the risk engine answers "does this still make
  sense, given everything else we know."

## 4. Agent-to-agent trust

Two agents belonging to *different* principals transacting with each other (e.g., agent
A pays agent B for a service) introduces a trust boundary Aegis must handle explicitly:

- Aegis does not need to trust a counterparty agent's internal policy — it only needs a
  **verifiable claim about the counterparty's identity and, where available, its own
  Aegis-equivalent (or AP2/TAP) authorization proof** for the specific transaction.
- Agent-to-agent transactions are carried over an existing discovery/transport protocol
  (Google A2A or AGNTCY in a real deployment); Aegis's capability token and risk verdict
  are payload on top of that transport, not a competing transport.
- Because two different organizations' policies are involved, agent-to-agent
  transactions default to a **stricter** risk posture (lower auto-approval thresholds,
  more likely to escalate) than intra-organization agent-to-vendor transactions, since
  Aegis has no behavioral history on the counterparty.
- The unified audit ledger (see [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)) is
  what allows a dispute between two organizations' agents to be resolved after the fact —
  each side's Aegis instance (or a shared one, in the demo) holds a cryptographically
  verifiable record of what was authorized and why.

## 5. Revocation as a first-class trust operation

Revocation is not an administrative afterthought — it's treated as core to the trust
model because "can I turn this off, right now, completely" is the actual test of whether
delegated authority was ever safe to grant. See
[THREAT_MODEL.md](THREAT_MODEL.md) §5 for the mechanics; the trust-model commitment is:
revoking any node in a delegation tree must **provably and immediately** invalidate
every descendant's authority, not just stop new token issuance — an already-issued
sub-agent token must fail verification the instant its ancestor is revoked, which is why
attenuated tokens carry the full caveat/ancestry chain rather than an opaque reference
that would require a live lookup an attacker's captured agent might race against.
