# Autonomy Model

Status: **design specification only — nothing in this document is implemented.** No
source file in `src/` reflects any concept described here. Do not cite this document as
evidence of a shipped capability.

Assumes [TRUST_MODEL.md](TRUST_MODEL.md), [PRODUCT_VISION.md](PRODUCT_VISION.md),
[DIFFERENTIATION.md](DIFFERENTIATION.md), [THREAT_MODEL.md](THREAT_MODEL.md), and
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md), and the actual V2 implementation as it
stands today (capability tokens in `src/capability`, the ledger in `src/state/ledger.ts`,
the risk engine in `src/risk`, the decision engine in `src/decision/decide.ts`). Every
mechanism below is defined as an addition on top of that implementation, not a
replacement for any part of it.

**Novelty disclaimer, stated up front per the same discipline
[DIFFERENTIATION.md](DIFFERENTIATION.md) applies elsewhere:** this document has **not**
been checked against the competitive landscape the way
[MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md) checked the rest of Aegis.
Reputation/trust-scoring systems that expand or contract an actor's effective authority
based on accumulated behavioral evidence are a well-established general pattern (credit
scoring, fraud-risk engines, IAM step-up authentication, TLS certificate trust chains
with revocation checking). Nothing here should be presented as new to the industry, to
agent infrastructure specifically, or as a differentiated Aegis capability until that
landscape check is actually done. §13 lists this explicitly as an open question.

---

## 0. The one invariant that governs everything below

> **A capability token's statically-attenuated caveats (see
> [TRUST_MODEL.md](TRUST_MODEL.md) §1.3, `src/capability/caveats.ts`) are the absolute
> outer bound of what an agent may ever be authorized to do. The Autonomy Model can only
> ever narrow the *effective*, currently-exercisable authority within that bound — never
> widen it, never issue a decision `verifyTransaction` would not itself have permitted,
> and never bypass or replace the existing capability-token check.**

Every mechanism in this document — Autonomy Health, authority bands, adaptive
attenuation, recovery — is a modulation of the **risk/judgment layer**
([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §3's "judgment layer," sitting
alongside the existing intent-consistency check and behavioral baseline in
`src/risk`), evaluated strictly *after* and strictly *in addition to* the deterministic
policy check (`verifyTransaction` in `src/capability/authorize.ts`). It never touches
token issuance, attenuation, or the Biscuit caveat chain. This is the same reason
[TRUST_MODEL.md](TRUST_MODEL.md) §1.3 exists: attenuation-only is a cryptographic
guarantee proven in `src/capability/__tests__/capability-core.test.ts` (including the
adversarial "even a block that bypasses application-level validation... cannot escape
the parent's cap" test), and nothing in this document is permitted to weaken that
guarantee, add a path around it, or depend on a component that could.

---

## 1. Evidence model

"Evidence" is any fact about an agent's past behavior that the Autonomy Model reads to
compute Autonomy Health and Autonomy Debt (§2, §3). Every piece of evidence must
originate from — and be reconstructible from — the existing hash-chained ledger
(`src/state/ledger.ts`). The Autonomy Model introduces no new source of truth; it is a
read model over ledger history, in the same sense
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §9 already establishes for behavioral
baselines ("derived/materialized from the ledger... not a separate source of truth").

Evidence is split into two kinds that **must remain distinguishable at every layer** —
in the data model, in ledger entries, and in any score computation:

### 1.1 Deterministic, Aegis-derived evidence

Computed entirely by Aegis's own code, with no model call involved. Fully reproducible:
given the same ledger history, the same evidence is always recomputed. Examples, all
traceable to an existing, already-implemented source:

| Evidence | Source |
|---|---|
| Policy verdict outcome (allowed / which caveat failed) | `VerifyResult` from `verifyTransaction`, `src/capability/authorize.ts` |
| Execution outcome (settled / failed / which rail) | `RailExecutionResult`, `src/rails/types.ts` |
| Behavioral baseline flags (rate, amount deviation) | `scoreDeviation`, `src/risk/baseline.ts` |
| Revocation events (including of ancestors) | `revokeAgentToken`, `src/capability/revocation.ts` |
| Idempotency-key conflicts (a client resubmitting a different body under a reused key) | `src/api/routes/transactions.ts`'s 409 path |
| Malformed/rejected request shape (validation failures) | `src/api/validation.ts` |
| Transaction recency, frequency, category/rail/counterparty diversity | Derivable purely from ledger entries, no new instrumentation needed |
| Escalation *frequency*, independent of how each escalation was eventually resolved | Count of `decision` entries with `verdict: "escalate"` per agent |

### 1.2 AI-generated evidence

Produced by a model call — currently only the intent-consistency judge
(`IntentJudge`, `src/risk/anthropicJudge.ts`). Probabilistic, not perfectly
reproducible (a re-run against the same input is not guaranteed to return the same
verdict), and — per [THREAT_MODEL.md](THREAT_MODEL.md) §1 — the more attackable
surface (prompt injection via the agent-supplied `purpose` field). The only example
that exists in the codebase today:

| Evidence | Source |
|---|---|
| Intent-consistency verdict + rationale (`consistent` / `inconsistent` / `ambiguous`) | `IntentJudgment`, `src/risk/anthropicJudge.ts` via `safeJudge` in `src/decision/decide.ts` |

Any future evidence source that involves a model call (e.g., a natural-language
summary of an escalation for a human reviewer, a counterparty-reputation lookup phrased
as a judgment rather than a deterministic API response) belongs in this category. The
test for which bucket a signal belongs in is mechanical, not judgment-based: **if
computing it twice from the same inputs can produce two different answers, it is
AI-generated evidence, regardless of how confident or structured its output looks.**

### 1.3 The governing rule between the two

- Deterministic evidence is the primary input to Autonomy Health and Autonomy Debt.
- AI-generated evidence contributes as a **bounded, weighted signal** — never the sole
  or majority driver of a band change (§4) on its own. A run of "consistent" verdicts
  with no corroborating deterministic evidence (e.g., no actual settled execution
  behind them) must not be sufficient to raise an agent's band. See §9 for why
  (anti-gaming) and §6 for the corroboration requirement on upgrades specifically.
- Every stored evidence record (§11) must be tagged with which of the two kinds it is,
  including, for AI-generated evidence, which judge/model and (if available) a prompt/
  schema version — so a later audit can always answer "how much of this agent's
  current trust rests on a model's opinion versus on things that actually, verifiably
  happened."

---

## 2. Autonomy Health

A per-agent, bounded, decaying, recency-weighted score summarizing accumulated
*positive* deterministic evidence, moderated by a bounded contribution from AI-generated
evidence per §1.3.

- **Bounded**: a fixed range (e.g., 0–100) rather than an unbounded accumulator — avoids
  the "score that only ever grows" failure mode and keeps thresholds (§4) comparable
  across agents regardless of how long they've been active.
- **Derived, not authoritative**: Autonomy Health is never itself the source of truth —
  it is always recomputable from the ledger's evidence entries (§11). A stored/cached
  health value is a materialized view, never a field that could disagree with the
  ledger it was computed from. This mirrors
  [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §9's existing principle for
  behavioral baselines, applied to this new read model too.
- **Recency-weighted / decaying**: older evidence counts for less. An agent that was
  well-behaved for a month and then dormant for a year should not retain a stale "fully
  trusted" score on its next transaction — see §7 for the forced-reauthorization
  consequence of dormancy specifically.
- **Composed of disclosed, configurable sub-scores**, not a single opaque number — at
  minimum: policy-compliance rate, execution-success rate, anomaly frequency (inverse
  of baseline flags), and a capped intent-consistency contribution. Weights are
  configuration, not hardcoded constants, matching the existing principle in
  [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §4 ("Thresholds are configurable per
  organization/agent, not hardcoded") for the risk engine generally. The specific
  weighting formula is an open question — see §13.

## 3. Autonomy Debt

A **separate** accumulator from Autonomy Health, not simply its arithmetic inverse.
Tracks accumulated *negative* evidence: denials, escalations resolved as
`inconsistent`, baseline-flag frequency, revocation history (including past, since-
resolved revocations — a prior revocation should leave a residual mark, not vanish),
idempotency-conflict attempts, and escalation frequency regardless of resolution (§1.1).

- **Asymmetric decay relative to Autonomy Health**: debt should decay *more slowly*
  than health accrues. "Trust is built slowly and lost quickly" is a standard, widely
  used design principle in trust/reputation systems generally (not an Aegis invention —
  see the novelty disclaimer above) and is the correct default here given the
  consequence of getting it wrong is misplaced financial authority.
- **Hard override capability**: debt crossing a configured severe threshold must be able
  to force a band downgrade (§4) regardless of the current Autonomy Health value, and
  should be able to trigger a recommendation for human review or revocation. It should
  **not** trigger automatic revocation silently — revocation is already, by design
  ([THREAT_MODEL.md](THREAT_MODEL.md) §9), a deliberate, attributed action. An
  automatic debt-triggered revocation is not ruled out, but if implemented it must be
  logged with the same attribution discipline as a human-initiated one (e.g.
  `revokedBy: "system:autonomy-model"`, with the specific debt event that triggered it
  referenced) — never a bare, unattributed state change.

## 4. Authority bands

A small number of discrete tiers, each mapping to a modulation of the **decision
engine's escalation threshold** (`combineRiskSignals` in `src/decision/decide.ts`), not
to a different capability token. Illustrative example — the exact count, names, and
per-band rules are an open product decision, not something this document finalizes (see
§13):

| Band (example) | Meaning | Example decision-layer effect |
|---|---|---|
| 0 — Probation | New agent, or recently downgraded | Every transaction escalates, regardless of intent-judgment verdict, up to the token's static cap |
| 1 — Standard | Default steady state | Existing V2 behavior unchanged: `inconsistent`/`ambiguous`/baseline-flagged → escalate, `consistent` + clean baseline → allow |
| 2 — Elevated | Sustained corroborated good history | `ambiguous` verdicts may auto-allow within a *tighter-than-token* effective ceiling; `inconsistent` still always escalates (see the security-invariant note in §10) |

Two properties are load-bearing regardless of how the bands are finally defined:

1. **A band can only ever narrow or hold the decision outcome relative to what
   `verifyTransaction` plus the existing V2 risk engine would already produce** — never
   loosen it below what the current, unmodified V2 pipeline computes. Concretely: for
   any transaction, `finalVerdict(withAutonomyModel) ` must never be `allow` where
   `finalVerdict(V2 today)` would have been `deny` or `escalate` on the *policy* check.
   The autonomy layer may only affect the *risk-layer* escalate/allow line, and only
   within what the token's own caveats already permit.
2. **Revocation, at any level of the delegation chain, overrides every band
   unconditionally.** The band check happens only after both the capability-token check
   and the revocation check already pass — never instead of them, never before them.

## 5. Adaptive attenuation

The term describes how a band's narrowing is actually enforced, and there are two
architecturally distinct ways to build it. This document recommends one as the default
and names the other as a possible future path — the choice is itself an open question
(§13) because the two have real, different cost/complexity/security profiles.

**Recommended default: risk-layer soft modulation, no token re-issuance.** The current
band is computed fresh at decision time from current Autonomy Health/Debt (§7) and
combined into `combineRiskSignals`'s existing escalate/deny/allow logic as one more
signal, exactly the way `baselineFlags` and `intentJudgment` already combine today. No
new Biscuit block is minted, no token the agent holds ever changes. This is consistent
with how every other risk-layer signal in the existing system already works, requires
no new capability-token machinery, and keeps the hard cryptographic guarantee (§0)
trivially true by construction — the band can literally only affect the software branch
inside `combineRiskSignals`, never the caveat-verification code path in
`src/capability/authorize.ts`.

**Possible alternative, not recommended as the starting point: cryptographic
re-attenuation.** Aegis could mint and append an actual new Biscuit block representing
the current band's restrictions (e.g., a tighter `check if transaction_amount_minor_units...`
than the agent's nominal token carries), re-issued whenever the band changes. This would
make the narrowing itself independently, cryptographically verifiable by anything
holding the token, at the cost of requiring the agent to fetch an updated token after
every band change, added issuance/distribution complexity, and a new class of "is this
agent using its latest band token" freshness problem. Named here as a legitimate future
hardening path (the same way [MVP_SCOPE.md](MVP_SCOPE.md) §6 names other MVP→production
upgrades), not something to build first.

Either way, **"adaptive attenuation" never means the reverse of attenuation** — it is
never used to describe granting more authority than a token's static caveats allow. Any
implementation or future document that uses "adaptive attenuation" to mean widening
beyond the static cap is describing amplification, which §0 forbids.

## 6. Recovery

How an agent climbs back from a low band / high debt:

- **Passive recovery**: consistent, corroborated good behavior (deterministic evidence,
  per §1.3) over time raises Autonomy Health and decays Autonomy Debt per their
  respective (asymmetric, §3) decay functions.
- **Upgrade requires deterministic corroboration, not AI-evidence alone.** A run of
  `consistent` intent-judgments with no actual settled, deterministically-verified
  transactions behind them must not be sufficient to raise a band — see §9 for the
  gaming scenario this specifically prevents.
- **Bands are climbed one step at a time with a minimum dwell period at each**, not
  jumped directly to whatever a computed score would nominally justify — this is a
  hysteresis-adjacent control (§8) that prevents a single burst of good activity from
  producing a large, possibly premature, authority increase.
- **Recovery events are ledger entries** (§11), attributed and reasoned, exactly like
  every other decision already is.
- **Manual recovery/override must exist and must be distinguishable from automatic
  recovery.** A principal or authorized reviewer should be able to explicitly adjust an
  agent's health/debt (e.g., after investigating and confirming a run of escalations
  were false positives) — but this must be its own attributed ledger-entry kind
  (§11), never indistinguishable from an automatic recomputation. This directly answers
  [THREAT_MODEL.md](THREAT_MODEL.md) §9's insider/over-permissioning concern as applied
  to this new subsystem: a manual override is exactly the kind of policy-widening
  action that must be visible and attributable after the fact, not silent.

## 7. State-change reauthorization

Extends [TRUST_MODEL.md](TRUST_MODEL.md) §1.2's existing "no standing trust" principle
("every transaction is re-evaluated... regardless of how the token was issued or how
many prior transactions succeeded") to this subsystem: **the current band is recomputed
fresh at every decision, from current Autonomy Health/Debt, and never cached or assumed
to still hold from a prior transaction.** A currently-good score is exactly as
non-binding on the next transaction as a currently-valid token is — both are
re-verified every time, not trusted because they were fine last time.

Beyond that baseline re-evaluation, certain **changes in context** — not just in the
score — should force a mandatory step-down to a stricter band (or outright escalation)
for that one transaction, regardless of the agent's accumulated band. This is a common
pattern in fraud/identity systems generally (new device, new location triggering
step-up authentication) applied to agent transactions; it is not claimed as novel.
Candidate triggers:

- First transaction on a rail this agent has not used before.
- First transaction to a counterparty this agent has not used before.
- First transaction in a category this agent has not used before (even if the category
  is within the token's static allowlist).
- Resumption after a dormancy period longer than a configured threshold — a stale agent
  suddenly active again is itself a risk signal (possible compromise, possible stale/
  drifted delegated goal) and should not benefit from a score computed against
  old, possibly-no-longer-relevant history.

## 8. Hysteresis

Prevents band-flapping — an agent whose score oscillates around a threshold boundary
transaction-to-transaction, causing repeated up/down band changes that would themselves
be confusing to audit and easy to reason incorrectly about. Standard control-systems
technique, not novel:

- **Separate up- and down-thresholds per band boundary**, with the up-threshold set
  strictly above the down-threshold — an agent must cross meaningfully higher to go up
  than it must fall to go back down, so a score sitting near the boundary does not
  toggle the band on small fluctuations.
- **Minimum dwell time in a band** before another transition is evaluated at all.
- **Consecutive-evidence requirement**: a transition should require a minimum number of
  qualifying recent transactions consistent with the new band, not a single observation
  crossing a line.

## 9. Anti-gaming rules

Enumerated attack patterns against the Autonomy Model itself, and the corresponding
design response. This section exists because a trust-scoring layer is, by construction,
an attacker's most attractive target — it is the one part of the system explicitly
designed to grant *more* room over time, which makes gaming it more valuable to an
attacker than gaming a static system.

| Attack | Mechanism | Mitigation |
|---|---|---|
| **Wash-transaction farming** | Many small, cheap, trivially-"consistent" transactions purely to inflate health quickly before one abuse transaction | Health accrual has diminishing returns (rate-limited qualifying-transaction count per window, or weighted by transaction diversity/value rather than raw count); and regardless, §0's invariant means even a maximally-trusted agent can never exceed its token's static cap |
| **Judge-gaming via purpose-text engineering** | Agent (or its principal, or an injected prompt) phrases every transaction to read as "consistent" to the LLM judge even while actually drifting | AI-generated evidence is capped/weighted low relative to deterministic evidence (§1.3); band upgrades require deterministic corroboration (§6); periodic re-sampling of past "consistent" verdicts for review is a plausible production hardening, not required for a first design |
| **Dormancy exploitation** | Build health, go dormant, transact once scrutiny has plausibly relaxed | Decay (§2, §3) + mandatory dormancy-resumption step-down (§7) |
| **Sub-agent laundering** | Spin up many cheap sub-agents to each accrue a little health independently | Bounded by the *existing* attenuation invariant already: each sub-agent's own static ceiling is a subset of its parent's, so this vector's blast radius is already capped by V2's proven security property, not something the Autonomy Model needs to separately defend against |
| **Debt evasion via agent recreation** | Principal revokes a heavily-indebted agent and creates a new `agentId` with a clean slate | **Not fully solved by this design** — flagged as an open question (§13), since per-agentId-only tracking is trivially gameable but a principal-level reputation floor has real fairness tradeoffs |
| **Escalation-fatigue laundering** | An agent generates frequent escalations that are eventually all approved (reviewer fatigue), so outcome-only tracking shows no debt | Escalation *frequency itself* is tracked as deterministic evidence (§1.1), independent of resolution outcome |

## 10. Security invariants

Consolidated, restating and extending existing invariants for this subsystem's specific
context. Every one of these must hold before this design is considered implementable,
and each should map to at least one adversarial test in §12.

1. **§0, restated as the primary invariant**: the Autonomy Model can only narrow,
   never widen, relative to what the existing capability-token check and V2 risk engine
   already compute. No decision this subsystem contributes to can be more permissive
   than plain `verifyTransaction` plus today's `combineRiskSignals`.
2. **Fail closed on computation failure**: if Autonomy Health/Debt/band cannot be
   computed (ledger unavailable, computation error, missing evidence), the agent is
   treated as the lowest, most restrictive band — never the highest, never "skip the
   check." Directly extends [TRUST_MODEL.md](TRUST_MODEL.md) §1.5.
3. **No standing trust** (§7): band is recomputed fresh per transaction, never cached
   across transactions.
4. **AI-generated evidence never solely determines a band upgrade** (§1.3, §6, §9).
5. **Every band change, health/debt update, and manual override is an attributed,
   hash-chained ledger entry** (§11) — no silent state mutation, matching the existing
   ledger design principle throughout [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)
   §5.
6. **Revocation always overrides the Autonomy Model entirely and unconditionally**
   (§4).
7. **An `inconsistent` intent-judgment verdict should always escalate, regardless of
   band** — recommended as a hard rule rather than something even the most-trusted band
   can auto-allow through, since it is the specific signal
   [DIFFERENTIATION.md](DIFFERENTIATION.md) §3.3 identifies as the core differentiated
   catch; letting a high band suppress it would quietly undo the product's central
   claim. (Whether `ambiguous` may ever be auto-allowed at high bands is left open —
   §13.)

## 11. Ledger requirements

No change to `src/state/ledger.ts` is required or proposed — `LedgerEntryInput.kind` is
already a free-form string by design (its own doc comment: "The ledger itself is
deliberately agnostic to what kinds exist"), so this subsystem is buildable entirely as
a new *consumer* of the existing ledger primitive. New entry `kind`s this design would
need:

| Kind | Contents |
|---|---|
| `autonomy_health_computed` | Computed health/debt/band snapshot, with the deterministic-vs-AI-evidence contribution breakdown, and references (by ledger `seq`/`contentHash`) to the underlying evidence entries it was derived from |
| `autonomy_band_change` | Old band, new band, triggering evidence references, hysteresis state at the time of transition |
| `autonomy_manual_override` | Attributed to a specific authenticated principal/reviewer, with a required reason field — never anonymous, never indistinguishable from an automatic entry |
| `autonomy_forced_reauthorization` | The specific §7 trigger that fired (new rail / new counterparty / new category / dormancy), and the transaction it applied to |

Every one of these must be independently re-derivable from raw evidence entries alone —
an auditor should be able to recompute "why is this agent at band 2 right now" purely
from ledger history, the same property
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §9 already requires of behavioral
baselines. This is directly testable (§12) the same way the existing ledger's
hash-chain is tested by recomputing and comparing in
`src/state/__tests__/state-core.test.ts`.

## 12. Adversarial test requirements

Specified at the same rigor as the existing suites (e.g.
`src/capability/__tests__/capability-core.test.ts`,
`src/decision/__tests__/decision-core.test.ts`) — none of these exist yet; this is the
list a future implementation would need to satisfy before this subsystem could be
considered proven, not just built:

1. **Never-more-permissive-than-baseline property test**: for a wide range of
   token caveats, transaction shapes, and Autonomy Health/band states, the
   Autonomy-Model-augmented decision must never be `allow` where plain
   `verifyTransaction` (today's code, unmodified) would return `allowed: false`, and
   never `allow` where today's `combineRiskSignals` (unmodified) would return `deny`/
   `escalate` on `inconsistent`.
2. **Fail-closed on computation error**: inject a broken/throwing health computation
   and assert the resulting band is the lowest defined band, not the highest, and that
   the transaction path still resolves to a defined verdict (never an uncaught
   exception reaching the caller).
3. **Hysteresis / anti-flapping**: construct a synthetic evidence trace that oscillates
   a raw score around a boundary and assert the number of realized band transitions is
   strictly fewer than naive per-transaction threshold-crossing would produce.
4. **Revocation overrides band unconditionally**: an agent at the highest band, revoked,
   must deny — same property already proven for the base system in
   `capability-core.test.ts`'s cascading-revocation tests, re-asserted with a
   non-default (elevated) band active.
5. **Wash-transaction farming does not achieve unbounded health gain**: a synthetic
   flood of minimal qualifying transactions must not raise health past what the
   diminishing-returns/rate-limit design permits within a fixed window.
6. **AI-only evidence cannot drive an upgrade**: a judge stubbed to always return
   `consistent` with no corresponding real deterministic evidence (e.g., no actual
   settled executions) must not be sufficient, alone, to cross an upgrade threshold —
   directly mirrors the discipline already used in
   `src/decision/__tests__/decision-core.test.ts`'s `ScriptedIntentJudge` pattern for
   testing decision-layer behavior against controlled, adversarial judge outputs.
7. **Dormancy forces reauthorization**: an agent with high accumulated health, dormant
   past the configured threshold, must have its next transaction step down / force
   escalate regardless of its pre-dormancy band.
8. **Manual override attribution**: a manual health/debt adjustment must appear in the
   ledger tagged distinctly from automatic entries, with the acting principal and
   reason present and non-empty; an attempt to record one without an authenticated
   principal must be rejected.
9. **Ledger re-derivation consistency**: recomputing an agent's health/debt/band purely
   from raw evidence ledger entries must reproduce exactly the value the live decision
   path used at the time — the same "recompute and compare" discipline already used to
   prove the base ledger's hash-chain integrity in
   `src/state/__tests__/state-core.test.ts`.
10. **Evidence-kind tagging**: every stored evidence/score record correctly and
    unambiguously identifies which contributions were deterministic versus
    AI-generated, and a query that strips AI-generated evidence still produces a
    well-defined (more conservative) score rather than an error or an unbounded value.

## 13. Design questions to resolve before implementation

These are open — this document intentionally does not resolve them, because each is a
product/security tradeoff decision, not an engineering detail:

1. **Exact band count and definition.** §4's three-band table is illustrative. How many
   bands, what each unlocks, and the exact effective-ceiling percentages per band are
   unresolved.
2. **Exact evidence-weighting formula** for Autonomy Health/Debt (§2, §3) — needs
   empirical tuning against real transaction data, not derivable from first principles
   alone.
3. **Soft risk-layer modulation vs. cryptographic re-attenuation** (§5) — the
   recommended default is soft modulation; whether re-attenuation is ever worth its
   added complexity is unresolved.
4. **Debt evasion via agent recreation** (§9) — per-agent-only tracking is gameable;
   principal-level reputation floors have fairness implications for principals with one
   bad agent among many good ones. Unresolved.
5. **Whether `ambiguous` intent-judgments may ever auto-allow at high bands**, or
   should always escalate like `inconsistent` (§10 item 7 only resolves `inconsistent`,
   deliberately leaving `ambiguous` open).
6. **Scope of scoring: per-agent only, or also per-delegation-tree / per-principal** —
   relevant both to the agent-to-agent trust scenario in
   [TRUST_MODEL.md](TRUST_MODEL.md) §4 and to the debt-evasion question above.
7. **Performance/materialization strategy** — recomputing health from full ledger
   history on every decision does not scale indefinitely; a checkpointing or
   incremental-recomputation strategy (analogous to
   [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §9's "recomputed incrementally"
   note for baselines) needs to be designed before implementation, not discovered
   under load.
8. **Opt-in vs. mandatory.** Whether the Autonomy Model applies to every agent by
   default, or is an explicit opt-in per principal/agent — some organizations,
   especially in regulated contexts, may want strictly static, non-adaptive authority.
   Given the rest of this system's conservative, explicit-by-default posture, defaulting
   to off/static and requiring opt-in is the more consistent choice, but this is a
   product decision this document does not make.
9. **Human-touchpoint requirement on first entry to a new band.** Whether an agent's
   *first* transition into a materially wider band should require an explicit one-time
   human acknowledgment (separate from ongoing automatic operation thereafter) — relates
   to §7's reauthorization concept and to general expectations around authorizing
   increases in financial authority without a human re-confirming.
10. **Competitive/novelty verification**, restated from the top of this document: this
    design has not been checked against existing reputation/trust-scoring systems for
    agents or otherwise. Before any of this is described as differentiated (as opposed
    to merely useful), that check needs to happen with the same rigor
    [MARKET_AND_COMPETITION.md](MARKET_AND_COMPETITION.md) applied to the rest of Aegis.
