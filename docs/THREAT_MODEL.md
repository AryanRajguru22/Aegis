# Threat Model

Assumes [TRUST_MODEL.md](TRUST_MODEL.md). Threats are grouped by where they enter the
system, each with the primary Aegis mitigation and, where relevant, evidence that this is
a real (not hypothetical) concern in the current ecosystem.

## 1. Prompt injection causing unauthorized transaction attempts

**Threat:** A compromised or manipulated agent (via poisoned tool output, a malicious
webpage it reads, a crafted email) is tricked into attempting a transaction its principal
never intended, while remaining within its raw numeric spend limit. This is not
theoretical — the "Whispers of Wealth" research (arXiv, 2601.22569) specifically
red-teamed Google's AP2 via prompt injection and found the mandate-construction step is
only as trustworthy as the agent assembling it.
**Mitigation:** This is precisely why Aegis's risk engine checks semantic
intent-consistency (does this transaction match the agent's delegated goal) in addition
to numeric caveats — a prompt-injected purchase is often numerically valid but
semantically inconsistent with the stated goal, which is exactly what the intent-
consistency check is designed to catch. See
[DIFFERENTIATION.md](DIFFERENTIATION.md) §3.3.

## 2. Confused-deputy sub-agent exceeding delegated authority

**Threat:** A sub-agent, legitimately spawned, is manipulated or buggy and attempts an
action outside what it should be allowed to do, relying on inherited trust from its
parent.
**Mitigation:** Cryptographic attenuation (§3, TRUST_MODEL.md) — a sub-agent's token
cannot express more authority than its parent's by construction, verified at every
transaction, not assumed from provenance.

## 3. Runaway agent / unintended repeated spend

**Threat:** A bug (retry loop, malformed condition) causes an agent to attempt the same
or similar transaction repeatedly, each individually within limits but cumulatively
draining a budget far faster than intended.
**Mitigation:** Capability token spend caveats are cumulative over a time window (not
per-transaction only); the risk engine's behavioral baseline flags a transaction-rate or
transaction-similarity spike even when each individual transaction would pass in
isolation.

## 4. Stolen or replayed capability token

**Threat:** A capability token is exfiltrated (log leak, compromised agent host) and
replayed by an attacker to transact as the agent.
**Mitigation:** Short default expiries (TRUST_MODEL.md §1.4); tokens bound to a specific
agent/session context where the token format supports it; the audit ledger makes replay
detectable after the fact even if not prevented in real time within the hackathon scope
(full replay-proofing — e.g., nonce binding per transaction — is named as a production
hardening item in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md), not claimed as solved
in the MVP).

## 5. Need for emergency shutdown that isn't fully trusted

**Threat:** A principal (or Aegis itself, via risk detection) needs to immediately halt
an agent and everything it spawned, and a partial or delayed revocation leaves exposure.
**Mitigation:** Revocation cascades through the delegation tree by construction (a
descendant's token verification requires its full ancestry chain to still be valid, not
just its own signature) — see TRUST_MODEL.md §5. The MVP demo explicitly exercises this:
revoke a root agent mid-demo and show every in-flight sub-agent transaction fail
verification within the same second.

## 6. Colluding or laundering agent-to-agent transaction chains

**Threat:** Multiple agents (potentially across organizations) execute a chain of
individually-plausible transactions that collectively move value somewhere none of the
individual principals intended.
**Mitigation:** Named as a real, hard, **not fully solved in the MVP** problem — see
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) "long-term architecture" for the
graph-analysis approach a production system would need (pattern detection across the
unified ledger, not just per-transaction evaluation). We are honest that the hackathon
risk engine evaluates transactions with recent-history context, not full multi-hop graph
analysis.

## 7. Social engineering of the human escalation path

**Threat:** An agent (compromised or manipulated) crafts an escalation request designed
to make a human approver rubber-stamp something they wouldn't approve with full context.
**Mitigation:** Escalation UI always shows the actual delegated goal, the specific policy
or risk rule that triggered escalation, and the plain-language reason — never just an
"approve/deny" button with agent-generated framing as the only context.

## 8. Malicious or fraudulent counterparty (merchant or agent)

**Threat:** A convincing-looking merchant or counterparty agent exists purely to harvest
payment credentials or extract value from agents that don't scrutinize the way a human
shopper would.
**Mitigation:** Explicitly deferred to rail-level protections (Visa TAP's
merchant-authenticity signals, Stripe's fraud tooling) — Aegis is not building
merchant-fraud detection; it's noted as an assumption/dependency, not solved by us. See
[PRODUCT_VISION.md](PRODUCT_VISION.md) §6, "not a generic fraud-detection product."

## 9. Insider / policy-admin over-permissioning

**Threat:** Someone with legitimate access to Aegis's policy configuration widens an
agent's authority improperly (mistake or malice).
**Mitigation:** Every policy change is itself an append-only, attributed ledger entry
(same hash-chained ledger as transaction decisions) — a widened policy is visible and
attributable after the fact, not silently applied.

## 10. Aegis itself as a single point of failure / attractive target

**Threat:** Because Aegis is the decision point for financial authority, it is a
high-value target — compromise Aegis and you may be able to approve anything.
**Mitigation named honestly:** This is a real architectural tension inherent to being a
policy decision point, not something the MVP fully resolves. The design commitment is:
(a) fail-closed (TRUST_MODEL.md §1.5) so a degraded/unreachable Aegis blocks transactions
rather than approving them by default, (b) Aegis never holds funds or private keys for
rails itself, so compromising the decision point does not directly grant custody of
money — it can at most falsely approve transactions that still have to clear a real
rail's own checks, and (c) the audit ledger's hash-chaining makes tampering with
historical decisions detectable even if a live compromise briefly succeeds. Full
production hardening (e.g., threshold signing so no single Aegis instance can
unilaterally approve, real HSM-backed keys) is scoped as long-term architecture, not MVP.

## 11. Denial of service via required-but-unavailable risk evaluation

**Threat:** If every transaction requires an LLM-judge call, an outage or latency spike
in that dependency could block all legitimate agent spend.
**Mitigation named honestly:** Numeric/caveat policy checks (fast, no external
dependency) always run first and independently; the LLM-judge intent-consistency check
is a second layer that can be configured to escalate-to-human rather than hard-block on
timeout, so a judge-service outage degrades to "more things need human review," not "the
whole system stops." This tradeoff (availability vs. strictness) is a real design
decision, stated explicitly rather than assumed away.
