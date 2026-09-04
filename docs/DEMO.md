# Demo Guide

A practical script for presenting AEGIS live, rehearsed against the actual running
application — every click target, every number, and every displayed message below was
verified against the real app in this pass, not written from memory of the design.

Start the server before the room fills:

```bash
AEGIS_DEMO_MODE=true npm start
```

Open **http://localhost:8787**, sign in with a fresh principal ID (anything — e.g.
`demo-<yourname>`), and you land on **Overview** with nothing selected yet. That empty
state is the right starting point for Act 1.

---

## 7-minute full demo

### Act 1 — The problem (Overview) · ~45s

**Say:** "AI agents are becoming capable of acting autonomously. The problem begins
when those agents receive authority to spend. The question isn't just whether an agent
is authenticated — it's exactly what it's allowed to do, right now, within what
boundaries, granted by whom, revocable how fast, and provable afterward how."

**Show:** the Overview hero — *Bounded. Revocable. Verifiable.* — and the fact grid
(Authority / Mission / Budget / Decision / Ledger), all showing empty/neutral state.
**Judge should notice:** the five-word thesis is the whole product, stated before a
single click.

### Act 2 — Authority (Authority tab) · ~90s

**Say:** "Authority isn't binary. It flows through a trust chain — root, delegated,
attenuated, mission-bound — and it can only ever narrow going down that chain, never
widen."

**Do:**
1. Click **Authority**. Point at the chain diagram: `Root → Delegated → Attenuated →
   Mission bound`.
2. Fill in **New agent**: Agent ID `travel-agent`, goal `Book flights and hotels for
   Q3 conferences`, Max amount `2000`, categories `flights,hotels,software`. Click
   **Create**.
3. Click **Select** on `travel-agent`, then **Attenuate**. Fill: Agent ID
   `flights-only`, goal `Book only flights, under a narrower budget`, Max amount
   `800`, categories `flights`. Click **Create**.

**Show:** the sub-agent renders as **"Delegated (attenuated)"** under its parent, with
a visibly smaller cap.

**Key line:** "Authority can become narrower downstream — never broader. That's not a
convention, it's enforced by the token's own cryptographic structure."

### Act 3 — Mission (Missions tab) · ~60s

**Say:** "Even valid authority isn't enough. The agent must also operate inside a
specific, bounded mission."

**Do:** Click **Missions**. Create: Mission ID `mission-flights`, Agent
`flights-only`, Goal `Book a round-trip flight under $800`, Budget `800`, Categories
`flights`, Counterparties `acme-airlines`. Click **Create mission**.

**Key line:** "The agent doesn't get money. It gets permission to accomplish one
bounded objective, inside limits narrower than even its own token allows."

### Act 4 — Transaction pipeline: ALLOW → DENY → ESCALATE (Transactions tab) · ~2 min

**Say:** "Every execution goes through a real decision pipeline — mission gate, capability
check, risk evaluation, then a composite verdict. The agent never directly converts
intent into execution."

**Do — ALLOW:** Select `flights-only` (Authority tab → Select), go to **Transactions**,
pick mission `mission-flights`, Amount `380`, Category `flights`, Rail `mock_x402`,
Counterparty `acme-airlines`. Click **Execute**.
**Show:** green `ALLOW`, the pipeline stages all lit green, the mission budget bar
moving, and the environment's green signal flash.

**Do — DENY:** Same form, Amount `5000`. Click **Execute**.
**Show:** red `DENY` — *"Transaction would exceed this mission's budget"* — and note
which pipeline stage it stopped at (the mission gate, before capability/risk ever run).

**Do — ESCALATE** *(genuinely reproducible, not scripted)*: This needs an agent with
transaction history, so create one first: Authority tab → cancel any pending
attenuation → new root agent `subscriptions-agent`, max amount `5000`, categories
`software`. Select it. Go to Transactions, mission = *None*, category `software`, rail
`mock_x402`, counterparty `cloudco`. Submit **three** transactions at Amount `50` (any
purpose text, Execute each). Then submit **one** at Amount `600`.
**Show:** gold `ESCALATE` — *"Behavioral anomaly detected: Amount (60000) is 12.0x this
agent's historical average (5000), over the 3x threshold"* — the environment's gold
signal, and the Decision Inspector showing the intent judge said `consistent` while
the **behavioral** layer alone forced the escalation.

**Key line:** "That escalation is real — it's a disclosed, deterministic
behavioral-anomaly heuristic, not a scripted outcome and not AI judgment. See Part 10
below for exactly what is and isn't AI here."

### Act 5 — Security: attack + revocation (Security tab) · ~90s

**Do:** Click **Security**. Select an agent with enough headroom (e.g. `travel-agent`,
cap $2,000) on the Authority tab first. Back on Security: **New attack mission
($2,000)**, then **Launch attack (20 × $380)**.
**Show:** 20 real, concurrent requests resolve to **5 allowed / 15 blocked**, spend
**$1,900.00 of $2,000.00**, and a green **"ZERO OVERSPEND — BUDGET HELD"** banner.

**Do:** **Delegation & revocation → Run scenario.**
**Show:** the same transaction that succeeds *before* revocation is denied
*immediately after*, with the real reason: *"Token (or an ancestor) was revoked."*

**Key line:** "Even delegated authority isn't permanent. Revocation cuts off trust
downstream, instantly, with no separate cleanup step — and 20 concurrent attackers
still can't push spend past the bounded budget."

### Act 6 — Evidence: verify, tamper, verify (Evidence tab) · ~75s

**Do:**
1. Click **Evidence** → **Refresh** → **Verify chain**.
   **Show:** green **"✓ HASH CHAIN VERIFIED"**.
2. Click **Tamper latest entry**.
   **Show:** the status flips to red **"✗ INTEGRITY VIOLATION DETECTED"**, with the
   exact corrupted entry named in the explanation below it, and the header badge
   changes to "Ledger tampered."

**Final line:** "AEGIS doesn't just control what an agent can do — it preserves
evidence of what happened, and that evidence can't be silently edited. This same
check can be run by a completely separate, offline tool that never trusts Aegis's own
code — see `verifier/README.md` if a judge wants to go one level deeper."

---

## 2-minute compressed demo

For a strict time limit, cut straight to the four moments that carry the whole story:

1. **Overview** (10s) — say the thesis: *Bounded. Revocable. Verifiable.*
2. **Authority** (20s) — create one agent, attenuate one sub-agent. Point at "narrows,
   never widens."
3. **Transactions** (40s) — one ALLOW, one DENY. Skip ESCALATE unless asked (it needs
   3 setup transactions you may not have time for).
4. **Security → Evidence** (50s) — launch the concurrent attack, show zero overspend;
   then Verify → Tamper → Verify again on Evidence. This one sequence (safe budget under
   attack + provable tamper detection) is the single strongest thing to leave a judge
   with if nothing else lands.

---

## Backup paths

- **State already populated from a previous run/rehearsal:** don't recreate agents —
  just select an existing one (Authority tab) and continue the script from Act 3
  onward. The pipeline behaves identically regardless of when the agent was created.
- **ESCALATE not reproducing:** the amount-deviation check needs at least 3 *prior*
  transactions **and** the 4th to be >3× their mean. If it didn't trigger, the mean was
  probably higher than expected — check the Decision Inspector's `Behavioral` line for
  the actual computed average and increase the final amount accordingly (it must be at
  least 3× that number).
- **Concurrent attack shows a different allowed/blocked split:** the exact split
  depends only on the mission budget and the amount-per-attempt shown on the button
  label — it is still correct as long as `allowed × amount ≤ budget` and
  `allowed + blocked = 20`. Say so directly if asked; the number is server-verified
  live, not fixed.
- **Server was restarted since agents were created:** if `AEGIS_ROOT_PRIVATE_KEY_HEX` /
  `AEGIS_LEDGER_PRIVATE_KEY_HEX` were not set, every previously-issued token is now
  invalid — the dashboard will show agents as gone or actions as failing. This is
  expected, disclosed behavior (see the README's Demo Mode section), not a bug — just
  start Act 2 fresh.
- **A judge asks about real AI or real payments:** answer directly from
  [SECURITY_MODEL.md](SECURITY_MODEL.md) §6 — demo mode's risk judge is a disclosed
  deterministic stand-in, and `mock_x402` is a self-built mock rail. Both are
  architecturally live-swappable (the code paths exist), but neither is exercised
  without external credentials. Never imply otherwise.
