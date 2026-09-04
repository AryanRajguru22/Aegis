# AEGIS — Final Cinematic Buildathon Demo Script & Recording Plan

Razorpay Buildathon · Master recording document · v1.0

Grounded entirely in this session's live verification of the running application (fresh server, `aegis-recording.db`, `AEGIS_DEMO_MODE=true`, 434/434 + 58/58 tests passing) and the exact source files named throughout. Every quoted UI string below is a real string this application produces — not paraphrased marketing copy.

---

## DELIVERABLE 1 — FINAL MASTER VIDEO SCRIPT

**Target: 7:30. Acceptable range: 7:00–8:00.**

Format per segment: TIME · WHAT I SAY · WHAT IS ON SCREEN · WHAT I DO · WHAT TO POINT OUT · EDITING NOTE.

---

### 00:00 – 00:35 — THE HOOK (no UI yet — black screen or a slow push-in on the AEGIS wordmark)

**WHAT I SAY:**
> "Give an AI agent the ability to spend money, and it can book your flights, pay your vendors, renew your subscriptions — faster than anyone on your team ever could.
>
> Give it the ability to delegate that spending to another agent it spins up on its own, and the picture changes.
>
> Because now the question isn't whether an AI can spend money. It already can.
>
> It's: what, exactly, is it allowed to do — who gave it that authority — and if something goes wrong, can you cut it off, instantly, and prove afterward exactly what happened?"

**WHAT IS ON SCREEN:** Black, or the AEGIS wordmark held on a dark ground. No dashboard yet — this is a cold open, not a UI walkthrough.
**WHAT I DO:** Nothing — this is voice-over. Do not touch the keyboard yet.
**WHAT TO POINT OUT:** Nothing on screen to point at — the tension is entirely spoken.
**EDITING NOTE:** Record this line separately, several times, in a quiet room. This is the single most re-recordable segment — get the pacing right in post rather than nailing it live.

---

### 00:35 – 01:05 — THE REVEAL

**WHAT I SAY:**
> "That's the problem AEGIS was built to solve.
>
> AEGIS doesn't ask you to trust an autonomous agent. It gives that agent authority — with boundaries.
>
> Bounded. Revocable. Verifiable."

**WHAT IS ON SCREEN:** Cut to the live Overview workspace — `http://localhost:8787`, already signed in. The hero statement ("Bounded. Revocable. Verifiable.") is already on screen, timed to land as you say the words.
**WHAT I DO:** Have the browser already open and signed in before recording starts — this cut should feel instant, no loading.
**WHAT TO POINT OUT:** The environment photograph behind the UI — let it register for a beat before you start clicking. This is the first moment the judge sees the product is real, not a slide deck.
**EDITING NOTE:** Hard cut on "Bounded. Revocable. Verifiable." — no fade. The word landing exactly as the UI text appears is the whole effect.

---

### 01:05 – 01:55 — AUTHORITY, DELEGATION, ATTENUATION

**WHAT I SAY:**
> "Authority in AEGIS isn't a permission flag in a database. It's a signed cryptographic token — a maximum amount, allowed categories, allowed payment rails, all baked into the credential itself.
>
> Here's where most permission systems fail: they can grant access, but they can't safely delegate it. AEGIS can.
>
> Watch what happens when I delegate this agent's authority to a narrower sub-agent. [click Attenuate, create the child] The child can only ever get narrower than its parent — never wider. If I try to hand it more than the parent has —"
>
> [attempt to widen — real rejection appears] "— it's refused. Not by a UI validation rule. By the token's own math."

**WHAT IS ON SCREEN:** Authority workspace. Root agent already exists from pre-staging (`$2,000 · flights, hotels, software`). You attenuate live to `$800 · flights only` — the struck-through categories visibly narrower. Then a live attempt to attenuate wider (`$5,000`, plus category `crypto`) produces the real error.
**WHAT I DO:** Click the existing root agent's **Attenuate** button → fill `child-agent` / `$800` / `flights` → **Create**. Then click **Attenuate** again on the child → fill a wider amount (`$5000`) and an added category (`crypto`) → **Create** → the inline error appears: *"Attenuation error: child maxAmountMinorUnits (500000) exceeds parent's (80000)"*.
**WHAT TO POINT OUT:** Zoom/frame on the `.caveats` line of both cards side by side — `cap 2000.00 USD · flights,hotels,software` vs `cap 800.00 USD · flights` — and then the red error text.
**EDITING NOTE:** Pre-type the root agent's fields before recording so the child-creation and the rejection attempt are the only live typing in this segment. Consider a subtle zoom-in on the error text for 1–2 seconds.

---

### 01:55 – 02:35 — THE MISSION

**WHAT I SAY:**
> "Authority answers what this agent could ever do. A mission answers what it's allowed to do right now.
>
> I'm binding this agent to one bounded objective — an $800 budget, flights only, one approved vendor. The agent doesn't get money. It gets permission to complete this one mission, inside boundaries no wider than its own authority allows."

**WHAT IS ON SCREEN:** Missions workspace. Create a mission on the child agent: budget `800`, category `flights`, counterparty `acme-airlines`. Mission Detail panel shows the live arithmetic: `800.00 USD budget − 0.00 USD settled = 800.00 USD remaining`.
**WHAT I DO:** Fill the mission form (pre-typed goal text is fine to have ready) → **Create mission** → click the new mission card to open Detail.
**WHAT TO POINT OUT:** The literal on-screen sentence *"Budget — the boundary this mission cannot exceed"* and the live subtraction shown in Mission Detail.
**EDITING NOTE:** None — this segment is fast and clean as-is.

---

### 02:35 – 03:45 — THE PIPELINE: ALLOW, DENY, ESCALATE

**WHAT I SAY:**
> "Every transaction runs through a real decision pipeline before anything moves — mission budget, capability check, risk evaluation. Let's put three real transactions through it.
>
> First — a valid one. $380, a flight, within every boundary." [Execute] "Allow. Every stage green, real settlement.
>
> Now — the same agent, wildly over its mission's budget." [Execute $5,000] "Deny. Not a warning. Nothing executes. And notice exactly where it stopped — the mission gate, before the pipeline even reaches the capability check.
>
> And here's the one people don't expect. This agent has a small, consistent spending pattern. I'm about to submit something twelve times its normal size." [Execute $600 against a $50 baseline] "Escalate. Not denied — because no hard rule was broken. Flagged, because the behavior doesn't look like this agent anymore."

**WHAT IS ON SCREEN:** Transactions workspace, Decision Inspector. Three consecutive submissions on pre-staged agents/missions:
1. **ALLOW** — $380 / flights / `mock_x402` / `acme-airlines`, mission attached, within budget.
2. **DENY** — $5,000 against the $800 mission → mission-gate stage highlighted, reason: *"Transaction would exceed this mission's budget…"*
3. **ESCALATE** — on a separate, pre-warmed agent (3 prior $50 transactions already submitted before recording), submit $600 → *"Behavioral anomaly detected: Amount (60000) is 12.0x this agent's historical average (5000), over the 3x threshold"*, with the `Intent: consistent` line visible right next to it.
**WHAT I DO:** Switch between two pre-created agents/missions for the three verdicts — do not build any of them live; only the amount field and Execute click happen on camera.
**WHAT TO POINT OUT:** For ESCALATE specifically — the `Intent:` line still says *consistent*. Say this out loud: "the AI judge here isn't even the reason this got flagged — a separate, purely mathematical signal is." This is the single most technically credible line in the whole video.
**EDITING NOTE:** This is the densest segment — consider a quick jump-cut between the three submissions rather than real-time waiting for each pipeline animation. Keep each verdict on screen 2–3 seconds before cutting to the next.

---

### 03:45 – 04:40 — THE ENGINEERING CHALLENGE: CONCURRENT BUDGET RACE

**WHAT I SAY:**
> "Here's a real problem we had to solve building this. A mission has a budget. Fine — check the amount against it before letting a transaction through.
>
> But autonomous agents don't send one request at a time. What happens when twenty requests hit the same $2,000 budget, at the same instant, each asking for $380? That's $7,600 of exposure against a $2,000 limit.
>
> If each request checks the balance, sees it's fine, and only then writes its spend — they can all check at once, all see room, and all proceed. That's a real race condition, and it's exactly the kind of bug that never shows up until you're actually under load.
>
> AEGIS closes that gap with one atomic database write that checks and reserves budget in the same instant — so it's not a matter of ordering, it's a matter of arithmetic. Watch what happens when I fire all twenty at once."
>
> [click Launch attack — real result renders] "Five allowed. Fifteen blocked. Nineteen hundred dollars spent. Zero overspend. The budget held — under real concurrency, not a best case."

**WHAT IS ON SCREEN:** Security workspace, Concurrent Budget Race panel. Live per-attempt grid resolving in real time, then the stat row and the green **"✓ ZERO OVERSPEND — BUDGET HELD"** banner.
**WHAT I DO:** Click **New attack mission ($2,000)** → click **Launch attack (20 × $380)** → let it resolve on camera (roughly 4–5 seconds).
**WHAT TO POINT OUT:** The exact server-confirmed line under the banner (*"Server-confirmed: spent X of 2000.00 USD budget — remaining Y — overspend 0.00 USD"*) — this is the receipts, not just a UI claim.
**EDITING NOTE — IMPORTANT:** The exact split (how many of 20 land as allowed) is **not guaranteed identical every run** — it depends on real timing, not a scripted number. This session's own verified run produced **5 allowed / 15 blocked / $1,900 spent / $0 overspend**; your actual recording may show a different split. **Say whatever number actually appears on your take** — the only claim to make is the invariant: allowed spend never exceeds the budget, and the banner always reads zero overspend. Do not pre-script a specific split into your memorized delivery.

---

### 04:40 – 05:20 — THE EMERGENCY BRAKE: REVOCATION

**WHAT I SAY:**
> "Authority isn't a permanent credential. It's a live relationship, checked fresh on every single transaction. Watch.
>
> This transaction works, right now." [before] "Allow.
>
> Now I revoke it." [Run scenario / Revoke] "And the exact same request —" [after] "Deny.
>
> The transaction didn't change. The authority did."

**WHAT IS ON SCREEN:** Security workspace, Delegation & Revocation panel. Its own before/after display: green `ALLOW … Policy satisfied…` then a large red `✗ DENY` box with *"Token (or an ancestor) was revoked at …: Attack-theatre demo revocation"* and *"Rail calls after revocation: 0."*
**WHAT I DO:** Click **Run scenario** — this single click runs the entire pre-built before/after sequence; do not attempt a manual revoke from the Authority tab (its agent card gives no visible confirmation there — this dedicated scenario is built for exactly this on-camera moment).
**WHAT TO POINT OUT:** *"Rail calls after revocation: 0"* — say it plainly: the denial isn't cosmetic, nothing downstream ever got called.
**EDITING NOTE:** Fastest, cleanest segment in the video — one click, ~2.5 seconds to resolve. Don't over-explain; let the red box do the work.

---

### 05:20 – 06:25 — THE PROOF: EVIDENCE, TAMPER DETECTION, INDEPENDENT VERIFICATION

**WHAT I SAY:**
> "But enforcement only matters if you can prove it happened. A dashboard telling you a decision was made is not evidence — it's a claim.
>
> Every decision AEGIS makes is written to a signed, hash-chained ledger — each entry linked to the one before it. Let's verify it." [Verify chain] "Hash chain verified.
>
> Now watch — I'm going to tamper with a stored entry directly in the database. Bypassing AEGIS entirely, the way someone with raw storage access would." [Tamper latest entry → Verify chain again] "Integrity violation detected. Not a guess — it names the exact entry, because its stored hash no longer matches its content.
>
> And this doesn't require trusting AEGIS's own check. A completely separate tool — that shares zero code with this dashboard — reaches the same conclusion, offline." [terminal, optional] "Same tampered entry. Independently caught."

**WHAT IS ON SCREEN:** Evidence workspace: green `✓ HASH CHAIN VERIFIED` → click **Tamper latest entry** → `✗ INTEGRITY VIOLATION DETECTED`, with the named entry (*"Entry #103 (agent_registered) was altered directly in storage…"*) and the header badge flipping to **"Ledger tampered."** Optional terminal overlay: `node verifier/dist/cli.js ledger-export.json` → `VERDICT: NOT VERIFIED`, exit code 1.
**WHAT I DO:** Refresh → Verify chain → Tamper latest entry → Verify chain again. If including the CLI: have the export already generated and the command pre-typed in a visible terminal window, ready to hit Enter.
**WHAT TO POINT OUT:** The status flip itself — same button, same screen, green to red, live. This is the emotional peak of the video.
**EDITING NOTE:** Do this scenario **last** among all app interactions — once tampered, that server's ledger stays tampered for the rest of the recording session. If time is tight, cut the terminal/CLI beat — the in-dashboard flip alone already proves the point; the CLI is a bonus, not a requirement, for staying inside 8 minutes.

---

### 06:25 – 07:00 — WHY THIS IS REAL (BUILT, NOT MOCKED)

**WHAT I SAY:**
> "None of this is scripted for the camera. It's 434 automated tests on the core pipeline, plus 58 more on that independent verifier — all passing, all reproducible.
>
> Right now, this is running in local demo mode — a disclosed, deterministic risk judge, no external API, no real money, so this recording never depends on network access or a paid credential. The same interface has a real Anthropic-backed judge behind it for a live deployment — but we'd rather show you something honest and reproducible than fake a model call for a demo."

**WHAT IS ON SCREEN:** A quick, fast montage — no dwelling: the Decision Inspector's own honest disclosure line (*"LOCAL DEMO MODE: deterministic stand-in judge… must never be used in production"*), then a terminal flash of `npm test` scrolling to `434 pass, 0 fail` and `58 pass, 0 fail`.
**WHAT I DO:** Pre-run both test commands before recording and have the final summary lines ready to flash on screen (a few seconds each) — don't run them live, that's dead time.
**WHAT TO POINT OUT:** The word "deterministic" and the exact pass counts — precision reads as credibility.
**EDITING NOTE:** This is the one segment built almost entirely from pre-captured footage/screenshots rather than a live click sequence — treat it as a fast insert, ~35 seconds total.

---

### 07:00 – 07:40 — THE CLOSE

**WHAT I SAY:**
> "The future problem was never whether an AI agent can spend money. It already can.
>
> The real question is what it's allowed to do — and whether you can prove it stayed inside those lines.
>
> The answer can't be: trust it.
>
> It has to be authority that's bounded, that's revocable, and that's verifiable.
>
> That's AEGIS."

**WHAT IS ON SCREEN:** Cut back to the Overview workspace, hero statement centered — mirrors the opening reveal shot exactly.
**WHAT I DO:** Nothing — hold on the final frame for a beat before cutting to black.
**WHAT TO POINT OUT:** Nothing — let the words land.
**EDITING NOTE:** Hold the final "Bounded. Revocable. Verifiable." frame for a full 2 seconds before cutting to black — resist the urge to cut early.

**Total spoken runtime at this pacing: ≈ 7:35** — inside the 7:00–8:00 target with margin for on-screen pauses.

---

## DELIVERABLE 2 — FEATURE COVERAGE MATRIX

| Feature | Shown? | Timestamp | How Demonstrated | Key Message |
|---|---|---|---|---|
| Root authority / capability token | ✅ Full | 01:05 | Live agent creation, caveats line read | Authority is a signed credential, not a config value |
| Delegation / attenuation | ✅ Full | 01:05–01:55 | Live attenuate + live rejected-widening attempt | Narrower only — enforced by the token's math |
| Capability constraints (amount/category/rail) | ✅ Explained while visible | 01:05–01:55 | Caveats line on both cards | Every boundary is inside the credential |
| Revocation + ancestor cascade | ✅ Full | 04:40–05:20 | Security scenario, real before/after | A live relationship, not a permanent grant |
| Mission (goal, budget, category/counterparty) | ✅ Full | 01:55–02:35 | Live creation + Detail panel math | Authority vs. mission — two independent boundaries |
| Mission expiry / cancellation | ⚪ Omit from spoken script | — | Not user-facing enough for 8 minutes | Real, but not a headline beat |
| Transaction pipeline (mission gate → capability → risk → decision → execution → ledger) | ✅ Full | 02:35–03:45 | Three live verdicts, stage highlighting | A denial stops exactly where it stopped |
| ALLOW | ✅ Full | 02:35–03:45 | Live | Every boundary satisfied |
| DENY (budget) | ✅ Full | 02:35–03:45 | Live | Hard stop, nothing executes |
| DENY (revoked) | ✅ Full | 04:40–05:20 | Live | Same request, different authority state |
| ESCALATE (behavioral anomaly) | ✅ Full | 02:35–03:45 | Live, pre-staged baseline | Flagged by math, not by the AI judge |
| Behavioral baseline heuristic | ✅ Explained while visible | 02:35–03:45 | `Intent: consistent` shown alongside the flag | Deterministic signal, independent of AI |
| Concurrent budget race / atomic reservation | ✅ Full — hero | 03:45–04:40 | Live 20-request attack, real numbers | A guardrail must survive concurrency, not just the common case |
| Evidence ledger (seq/hash/sig) | ✅ Full | 05:20–06:25 | Live verify | Signed, hash-chained, checkable |
| Tamper detection | ✅ Full — hero | 05:20–06:25 | Live tamper → re-verify | Status flips green to red on real data |
| Independent verifier | 🟡 Optional montage | 05:20–06:25 | Terminal overlay, time-permitting | Doesn't require trusting AEGIS's own code |
| Demo mode / AI honesty | ✅ Explained | 06:25–07:00 | Spoken + on-screen disclosure text | Deterministic on purpose, not a limitation apologized for |
| Test suite (434 + 58) | ✅ Quick montage | 06:25–07:00 | Terminal flash | Not scripted for the camera |
| Six-workspace UI / environment art | ✅ Ambient throughout | Entire video | Never named directly | Product feel, not the technical claim |
| Idempotency / crash safety | ⚪ Omit from spoken script | — | Internal, not visually demonstrable in 8 min | Covered in written docs, not the video |
| Stripe test-mode rail | ⚪ Omit from spoken script | — | Not exercised in demo mode by design | Would require explaining a code path never active in this recording |

---

## DELIVERABLE 3 — PRE-RECORDING CHECKLIST

**Environment**
- [ ] Server started fresh: `AEGIS_DEMO_MODE=true AEGIS_DB_PATH=./aegis-recording.db npm start` (a completely clean DB — nothing tampered, nothing left over from rehearsal)
- [ ] `curl http://localhost:8787/demo-mode` → confirms `{"demoMode":true}`
- [ ] No yellow banner, no console errors on load

**Browser**
- [ ] Fullscreen or a fixed 1920×1080 window, zoom 100%
- [ ] Signed in with a clean, camera-appropriate principal ID (not `audit-` / `test-` prefixed)
- [ ] All six workspace tabs clicked once beforehand to confirm images load

**Pre-staged data (all created BEFORE recording, not live)**
- [ ] Root agent — `$2,000 · flights,hotels,software` — for the delegation segment's "before" state
- [ ] A separate ALLOW-agent + mission (`$800` budget, `flights`, `acme-airlines`) with **zero** transactions yet
- [ ] A separate ESCALATE-agent with **3 prior $50 transactions already submitted**, no mission attached
- [ ] A separate REVOCATION-agent left **untouched** (Security's own scenario creates its own parent/child — no manual pre-staging needed there)
- [ ] Evidence ledger currently **clean** (not yet tampered)

**Terminal (only if including the verifier CLI beat)**
- [ ] `npm run build:verifier` already run once
- [ ] The export command and CLI command pre-typed in a visible terminal, cursor ready, not yet executed
- [ ] Font size large enough to read on camera

**Recovery**
- [ ] Know the exact restart command in case you need a fully clean slate mid-session: kill the process, delete `aegis-recording.db*`, restart with the same command above

---

## DELIVERABLE 4 — RECORDING RUNBOOK

```
Before pressing Record
  └─ Run the full pre-recording checklist above
  └─ Server confirmed healthy, browser positioned, pre-staged agents/missions exist
  └─ Do Not Disturb on, unrelated windows closed

PRESS RECORD
  └─ 00:00 Hook (voice-over, blank/wordmark) ─────────── safe cut point AFTER this line
  └─ 00:35 Reveal → cut to Overview, hero statement visible
  └─ 01:05 Authority tab → attenuate live → attempt-to-widen rejection
                                                          ─────────── safe cut point HERE
  └─ 01:55 Missions tab → create mission → open Detail
  └─ 02:35 Transactions tab → ALLOW → DENY(budget) → switch agent → ESCALATE
                                                          ─────────── safe cut point HERE
  └─ 03:45 Security tab → New attack mission → Launch attack → let it resolve
                                                          ─────────── safe cut point HERE
  └─ 04:40 Security tab → Run scenario (revocation)
  └─ 05:20 Evidence tab → Verify → Tamper → Verify → (optional) terminal verifier
                                                          ─────────── DO THIS LAST — ledger stays tampered after
  └─ 06:25 Architecture montage (pre-captured test-run footage)
  └─ 07:00 Close → cut back to Overview hero shot, hold 2s, fade to black
STOP RECORDING
```

**Cut points that are genuinely safe** (state on both sides is self-contained, nothing downstream depends on mid-scene continuity): after the Hook, after Authority, after the Escalate verdict, after the Concurrent Race resolves. **Not safe to cut/resume around:** mid-way through the Evidence segment — verify→tamper→verify is one continuous proof and should be one take.

---

## DELIVERABLE 5 — WHAT MUST NOT GO WRONG

| Risk | Likely cause | Fastest recovery | Restart scope |
|---|---|---|---|
| ESCALATE returns ALLOW instead | Baseline warm-up transactions weren't actually submitted before recording, or were submitted on the wrong agent | Check you're on the pre-staged escalate-agent; submit 3× $50 again, then retry | Just that segment |
| Concurrent race shows a different split than rehearsed | **Expected** — the split is not deterministic run-to-run | Say the numbers that actually appear on screen; the zero-overspend line is the only fixed claim | None — this is not a failure |
| Attack mission has no budget left for a retake | Reused an already-spent attack mission from rehearsal | Click **New attack mission ($2,000)** — always fresh, every take | Just that segment |
| Evidence tab already shows "tampered" at the start of a take | A rehearsal tamper wasn't reset | Restart the server on a fresh `AEGIS_DB_PATH` before this take | Full server restart, then just re-record from Evidence onward |
| Revoked-agent transaction accidentally shows ALLOW | Used the Authority tab's manual Revoke (which gives no visible confirmation) instead of the Security scenario | Only ever use Security's **Run scenario** button for the on-camera revocation beat | Just that segment |
| Demo-mode confusion ("is this real AI?") | Script drifts from the honest phrasing | Stick to the exact line in the 06:25 segment — "disclosed, deterministic… no external API" | Re-record that line only |
| API/network hiccup mid-take | Something external to AEGIS (OS, browser extension) | AEGIS itself makes zero external calls in demo mode — a real network issue is not this app; check nothing else is interfering, retry | Depends on cause, usually just that segment |
| Accidental secret exposure on screen | A terminal scrollback showing an env var, or an open `.env`-adjacent file | Never open `.env`/`.env.example` on camera; keep terminal history clean before recording | Cut that footage in editing if it happens |
| Loading delay breaks pacing | Cold start / first request after idle | Click through each workspace once right before recording to warm it up | None — just pre-warm |
| UI state mismatch (wrong agent selected) | Switched tabs without re-selecting | Always re-click **Select** on the intended agent before a transaction beat | Just that segment |

---

## DELIVERABLE 6 — JUDGE ATTENTION MOMENTS (ranked)

**#1 — Concurrent Budget Race (03:45–04:40).** Most likely to make judges remember AEGIS specifically. It's the one moment that's viscerally hard to fake — twenty real requests, resolving live, with an exact server-confirmed number. Most hackathon demos never touch concurrency at all; this alone separates a working system from a UI mockup.

**#2 — Tamper Detection (05:20–06:25).** The emotional peak. A status flipping from green to red on the same button, on data the presenter just corrupted in front of them, needs no technical background to land. This is the moment a non-technical judge remembers.

**#3 — Attenuation's live rejection (01:05–01:55).** The single strongest *technical* credibility moment — a real error message from a real constraint engine, not a validation rule. This is what earns respect from a technical judge specifically.

**#4 — Revocation's before/after (04:40–05:20).** Short, clean, conceptually powerful ("the transaction didn't change, the authority did") — high impact for very little screen time, a good pacing anchor right after the denser concurrency segment.

**#5 — The behavioral-vs-AI distinction inside ESCALATE (02:35–03:45).** Easy to under-sell because it's a single line of dialogue, but it's the moment that proves AEGIS didn't outsource its safety boundary to a model — worth the deliberate pause the script calls for ("the AI judge here isn't even the reason this got flagged").

---

## DELIVERABLE 7 — FINAL ONE-PAGE SPEAKER CHEAT SHEET

**Opening line:** "Give an AI agent the ability to spend money… delegate that spending to another agent… what is it allowed to do, who gave it that authority, can you prove it after the fact."

**Reveal:** "AEGIS doesn't ask you to trust an autonomous agent. It gives that agent authority — with boundaries. Bounded. Revocable. Verifiable."

**Transitions (memorize these, they carry the story):**
- Authority → Mission: *"Authority answers what this agent could ever do. A mission answers what it's allowed to do right now."*
- Into concurrency: *"Autonomous agents don't send one request at a time."*
- Into revocation: *"Authority isn't a permanent credential. It's a live relationship."*
- Into evidence: *"Enforcement only matters if you can prove it happened."*

**Critical numbers to have ready (adjust to whatever actually appears live):**
- Attenuation: parent `$2,000 / flights,hotels,software` → child `$800 / flights`
- ALLOW: `$380 / flights / acme-airlines`
- DENY: `$5,000` against an `$800` mission
- ESCALATE: 3×`$50` baseline, then `$600` (12× the mean)
- Concurrent race: 20 attempts × `$380` vs `$2,000` budget → **zero overspend is the only fixed claim**
- Tests: **434/434** main suite, **58/58** verifier suite

**Critical clicks in order:** Authority (Attenuate ×2) → Missions (Create) → Transactions (Execute ×3, switching agents) → Security (New attack mission → Launch attack → Run scenario) → Evidence (Refresh → Verify → Tamper → Verify)

**Do not forget:** Evidence tamper happens **last**. Revocation is the Security scenario's **Run scenario** button, never the Authority tab's manual Revoke. State the concurrent-race numbers you actually see, not memorized ones.

**Closing line:** "The answer can't be: trust it. It has to be authority that's bounded, that's revocable, and that's verifiable. That's AEGIS."

---

## RECORDING ASSET PACK

### A. Final Recording Order
Hook → Reveal → Authority/Attenuation → Mission → Transactions (ALLOW/DENY/ESCALATE) → Concurrent Race → Revocation → Evidence/Tamper → Architecture montage → Close.

### B. Take-by-Take Plan
| Take | Content | Depends on |
|---|---|---|
| 1 | Opening + Reveal (voice-over, can be recorded separately from screen capture) | Nothing — record anytime |
| 2 | Authority + Attenuation | Root agent pre-staged |
| 3 | Mission + Transaction (ALLOW, DENY) | Mission/agent pre-staged, budget untouched |
| 4 | ESCALATE | Separate agent with 3 baseline transactions already submitted |
| 5 | Concurrent Race | Fresh attack mission clicked immediately before |
| 6 | Revocation | Security's own scenario — no pre-staging needed |
| 7 | Evidence + Tamper (+ optional verifier CLI) | **Record this take last of all app footage** — ledger stays tampered afterward |
| 8 | Architecture montage | Pre-captured `npm test` / `npm run test:verifier` output |
| 9 | Closing | Can reuse the same Overview shot framing as the Reveal take |

### C. Pre-Staged State Table
| Scene | DB state required | Agent required | Mission required | Transaction history required | Expected result |
|---|---|---|---|---|---|
| Authority/Attenuation | Fresh or existing | Root agent exists | None | None | Live attenuate + rejected widen |
| Mission | Same session | Child agent from above | None yet | None | Mission created, $800 remaining |
| ALLOW/DENY | Same session | ALLOW-agent + mission | $800 budget, untouched | None | ALLOW then DENY (over budget) |
| ESCALATE | Same session | Separate escalate-agent | None (standing authority) | **3× $50 already submitted** | ESCALATE with 12x reason text |
| Concurrent Race | Same session | Agent with ≥$2,000 cap | **Freshly created**, $2,000, untouched | None | Zero overspend banner |
| Revocation | Same session | N/A — scenario creates its own | N/A | N/A | Before ALLOW, after DENY |
| Evidence/Tamper | Ledger currently clean | Any (already have entries from above) | N/A | N/A | Verified → tampered → violation detected |

### D. Exact Reset Plan
- **ESCALATE:** switch to a fresh agent, submit 3 new baseline transactions, retry. No server restart needed.
- **Concurrent race:** click **New attack mission ($2,000)** again — always resets the budget. No server restart needed.
- **Revocation:** the Security scenario creates a fresh parent/child pair every time **Run scenario** is clicked — no reset needed, it's idempotent by design.
- **Tamper detection:** this is the one true one-way door. To redo it cleanly: stop the server, delete `aegis-recording.db*`, restart with the same start command, re-verify `/demo-mode`, re-stage whatever agents/missions the retake needs.

### E. Recording Failure Recovery
| What failed | Likely cause | Fastest recovery | Scope |
|---|---|---|---|
| Wrong verdict appears | Wrong agent/mission selected, or budget already partly spent from rehearsal | Re-select the correct agent (Authority tab → Select), confirm mission budget in Detail panel | That segment only |
| Server crashed mid-recording | Extremely unlikely — not observed in this session's testing | Restart with the exact same command, re-verify `/demo-mode`, re-stage data | Restart from the last safe cut point |
| Ledger shows tampered before you meant to show it | A leftover from rehearsal | Fresh server restart on a new DB path | Full app-footage re-record from that point forward |
| Browser shows stale UI after a code change | Hard refresh (Ctrl+Shift+R) | Reload | That segment only |

---

## SELF-AUDIT (performed before finalizing this document)

- Every technical claim above was verified live against the running application in this same session (see the readiness audit immediately preceding this task) — attenuation rejection message, mission arithmetic, all three verdict texts, concurrent-race numbers, revocation before/after text, tamper entry naming, verifier exit code, and both test counts (434/434, 58/58) are real strings/numbers this build produced, not invented.
- Spoken word count across all ten segments totals ≈1,040 words at a deliberate ~135 wpm pace ⇒ **≈7:35 runtime**, inside the 7:00–8:00 requirement.
- Opens on tension, not a self-introduction; closes by directly answering the opening question — no "thank you," no generic sign-off.
- No claim of Razorpay integration, no claim of a live Anthropic call during this recording, no claim of production-readiness, no claim of blockchain, no fabricated engineering "war story" — the two engineering-challenge beats (concurrent budget race, tamper detection) are both real, both reproducible, both demonstrated with actual proof on screen rather than asserted.
- Every one of the six workspaces appears in the story, but never as a labeled tab-tour — each surfaces inside a narrative beat with its own tension and payoff.
- The one real caveat disclosed rather than hidden: the concurrent-race split (5/15 in this session's own verified run) is not guaranteed identical on the actual recording take — flagged explicitly in the script, the checklist, and the risk table, with the correct instruction to state whatever number genuinely appears.

---

## FINAL VERDICT

# 🟢 READY TO RECORD

Nothing here is blocked on further engineering work. The only actions remaining are human and logistical: pre-stage the four agents/missions listed in the checklist, rehearse the spoken lines for pacing, and record — with the Evidence/tamper segment last.
