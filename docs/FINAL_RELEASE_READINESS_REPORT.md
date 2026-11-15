# Final release-readiness report

Scope: the final hardening pass on branch `release/production-readiness`, ahead of merging to
`main`. Environment: Windows 11, Node 24.13.1, Git Bash/PowerShell, Chrome via the browser
extension. Each section says whether a claim is **implemented**, **tested** (automated, in the
repo), **measured/observed manually**, or **not verified**. Nothing here is externally validated.

## 1. Starting Git state

| Ref | Commit |
|---|---|
| `release/production-readiness` (local = origin) | `e29ae92` |
| `origin/main` | `c32b26e` |
| local `main` | `f3dbf21` (one commit *ahead* of `origin/main`, never pushed; an ancestor of the release branch) |

The release branch was 7 commits ahead of `origin/main` and 0 behind, so a fast-forward was
possible. Working tree clean, no stashes, no tags. Baseline at `e29ae92`: 668/668 main tests.

## 2. Engineering issues discovered in this pass

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | Flaky `extractRootFacts` test = a real defect: authorizer queries ran under the engine's ~1 ms default limit | medium (spurious failure of token-identity recovery under CPU load) | fixed, §3 |
| 2 | An `escalate` verdict was a dead end: no way for an operator to approve or reject | product gap | implemented, §5 |
| 3 | Full-chain verification blocked the whole event loop (~2.1 s at ~10.8k entries); any authenticated principal could amplify it, and it stalled in-flight payments | medium (availability) | mitigated, §8/§9 |
| 4 | The operator-review UI showed a server refusal then wiped it on reload; the message sat below the card list | low | fixed (found in the real browser) |
| 5 | The README's "Verified locally: Docker image builds…" could not be reproduced | documentation honesty | reworded, §10 |

No new correctness bug was found in budget reservation, revocation, cancellation or idempotency under load (§7).

## 3. Flaky-test investigation — resolved with evidence

- **Symptom:** `recovers principalId and delegatedGoal from a root token` (and, once,
  `round-trips a delegated goal…`) failed with `{ RunLimit: 'Timeout' }` after ~10 ms.
- **Reproduction:** running the capability suite with 8 parallel workers failed 5 of 160 runs. A
  direct probe (8 processes × 400 `issueRootToken` + `extractRootFacts`) showed ~11 timeouts in
  3,200 calls, all inside `extractRootFacts`.
- **Cause:** `extractRootFacts` called `authorizer.query()`, which has no limits argument and so
  uses Biscuit's built-in defaults (a ~1 ms wall-clock budget). Every other call passes
  `AUTHORIZE_LIMITS` (5 s). Contention pushed the query past 1 ms. (The swallowed `authorizeWithLimits`
  was not the culprit: a 1 µs `max_time_micro` was confirmed to time out, so that option is honoured.)
- **Fix:** `queryWithAuthorizeLimits()` → `queryWithLimits(AUTHORIZE_LIMITS)` (commit `39a5edc`).
- **Result:** 0 failures in 400 suite runs; 0 timeouts in 3,200 probe calls.
- **Residual uncertainty:** the failure is timing-dependent, so no unit test can reproduce it
  deterministically; `capability-query-limits.test.ts` pins the mechanism (queries use the explicit
  limits), and the stress evidence above is the proof. `ensureWarm()` still calls
  `authorize()` with default limits, but swallows the result by design.

## 4. Evidence workspace — real-browser verification (Chrome, manual)

Server: demo mode, scratch DB, ~1,850 ledger entries (5 settled transactions, 3 escalations, 600
simulations of padding). Window 1400×1000. Checks, each performed in the live DOM:

| # | Check | Result |
|---|---|---|
| 1 | Evidence loads | pass — "Verified — 1848 entries, hash-chain intact" |
| 2 | Newest first | pass — first rows #1849, #1848, #1847, strictly descending, no duplicates |
| 3 | Pagination | pass — 50 → 100 → 150 … → 500; "Show older entries" hides at the end of the loaded window |
| 4 | **Previous/next navigation** | **N/A by design** — the UI is *load more* (accumulating list), not prev/next pages; the text states "Loaded the newest 500 of N total entries" |
| 5 | Event-type filter | pass — options carry counts; choosing `escalation_opened` shows exactly 3; "All" restores 50 |
| 6 | Expand an entry | pass — shows the recorded JSON, text only; hides again |
| 7 | Verifier command | pass — embeds the server's public key (matches `/ledger`); **I ran the displayed commands against the live DB: "ALL INVARIANTS VERIFIED — TRUSTED", exit 0** |
| 8 | Empty state | pass — a fresh principal shows "Showing 0 of 0 entries" and "Verified — 0 entries" (no explanatory sentence; judged adequate) |
| 9 | API failure | pass — a rejected `fetch` shows "Could not reach the server to verify…" and "Ledger status unknown" (not "tampered"); recovers on the next check |
| 10 | Large response | pass — refreshing the 500-entry window took 58 ms; the longest main-thread gap was 30 ms |
| 11 | Console errors | none on load or during interaction (reloaded to capture load-time errors) |
| 12 | Other workspaces | Overview, Authority, Missions, Transactions, Security, Evidence all render with content; mission list and agents present; no uncaught errors or rejections |

Also exercised in the browser: the Operator review panel (§5). Limits: Chrome only, one window
size; native `confirm()` was stubbed because dialogs block the automation (the confirmation text
was captured and checked); mouse clicks were used for the approve path and DOM clicks for the rest;
no responsive/mobile re-check and no screenshots were regenerated. Not part of `npm test`.

## 5. Escalation resolution — design and implementation (implemented, tested, browser-verified)

An ESCALATE verdict can only come from the risk stage (policy only denies). Design in
[SECURITY_MODEL.md §4a](SECURITY_MODEL.md); summary:

- **Open:** a real `/transactions` request that escalates creates a row in a new additive
  `escalations` table (`CREATE TABLE IF NOT EXISTS`; no existing table altered), a
  `escalation_opened` ledger entry, and returns `escalation: {escalationId, status:"pending"}`.
  `/simulate` never opens one; a retry with the same Idempotency-Key replays the same escalation.
  Nothing is reserved or executed while pending.
- **Resolve:** `GET /escalations[/:id]`, `POST /escalations/:id/approve|reject` (body `{reason}`,
  required, ≤500 chars), principal API key only; `GET /transactions/escalations/:id` lets the agent
  poll its own outcome. Decisions are ledgered (`escalation_resolved`) with the operator principal id,
  timestamp and reason.
- **Approval re-runs every safeguard except the risk stage:** capability re-verification against the
  agent's stored token (revocation of agent/ancestors, expiry, caveats) → mission still active (or
  agent still not mission-bound) → atomic budget reservation *at approval* → single conditional
  `UPDATE … WHERE status='pending'` → `executeApprovedEscalation`, which re-checks capability + mission
  guard once more with no `await` before the rail. A failure before the decision leaves the escalation
  pending (the operator can still reject); a change after it is withdrawn and ledgered as
  `pre_execution_recheck`. `executeApprovedEscalation` lives in `executeTransaction.ts`, so rail calls
  still happen only inside that module.
- **Exactly one decision:** same decision repeated = idempotent 200 (`replayed`), opposite = 409,
  concurrent approve/approve/reject = one winner. Rejected transactions never reach a rail; a retry
  replays the cached escalate or is a fresh evaluation.
- **Crash safety:** the rail receives key `escalation:<id>`. An approved row with no recorded outcome
  becomes `indeterminate` at startup, is never re-executed, and its reservation stays held (fail
  closed); a reservation for a still-pending escalation is returned.
- **Dashboard:** an "Operator review — escalations" panel in the Transactions workspace (reason
  required, confirmation before approving, server refusals shown verbatim, outcome in plain words).
- **Verifier:** needed no change — an approved settlement attributes through the same pipeline-outcome +
  link entries; four tests prove it (including that approval is not a bypass of the mission-binding rule).
- **Tests:** 31 API + 9 dashboard + 4 verifier. Mutation checks: removing the capability re-verification
  (both places) fails 4 tests; removing the status check and the conditional `UPDATE` fails 7.

## 6. Separation-of-duties status

- **Enforced:** an agent (or anyone holding only a capability token) **cannot** approve or reject —
  those routes use principal-key auth and return 401 for a capability token (tested with the agent's
  real token). Another principal gets 404. The deciding principal id is recorded.
- **NOT enforced, and not faked:** a human *developer* who runs the agent and a human *operator* who
  reviews it are separate people only by convention. The identity model has one human credential per
  principal and the principal owns the agent, so "the initiator cannot approve their own transaction"
  cannot be enforced; the ledger records the principal, not an individual.
- **Smallest change needed:** a reviewer role (a `reviewers` table or role column + a second API-key
  class) with the rule `reviewer ≠ agent owner/initiator` checked in `requireOwnedEscalation`. Not
  built: it needs a product decision about reviewer provisioning.

## 7. Load testing — methodology and results

Full detail, tables and caveats: [LOAD_TESTING.md](LOAD_TESTING.md). `scripts/loadtest.mjs` drives the
real `createApp` over file-backed SQLite from a separate process at concurrency 1/10/50.

- **All 104 invariant checks held** (final run): budget never exceeded (200 requests racing for a
  budget that fits exactly 20 → exactly 20 settled and 180 denied, at every concurrency; rail called
  exactly 20 times); 40 keys × 5 concurrent duplicates → exactly 40 rail calls; **zero rail calls
  began after a revocation or a mission cancellation was ledgered** while workers were submitting
  continuously; 20 concurrent escalation approvals against a budget for 10 → exactly 10 settled.
- **Measured throughput (one run, this machine):** settled `/transactions` ~20 req/s at c=1 and
  ~85–90 req/s at c=10–50 (single Node event loop saturated; p95 0.18 s at c=10, 0.76 s at c=50);
  `/simulate` up to ~263 req/s at c=50. No 5xx, no network errors, no timeouts. Server RSS 90–350 MB.
- Estimated vs. unverified items are listed explicitly in LOAD_TESTING.md.

## 8. Ledger integrity under concurrent writes

- `chainValid:true` over the whole chain after every scenario (via `/ledger`), **and** the
  independent verifier (separate code reading the DB file) returned `TRUSTED` (exit 0) on every
  run's database.
- **Measured limitation:** at ~10.8k entries a full verification costs ~1.1–2.1 s; every write
  invalidates the memo. Synchronous, it stalled the whole server (writers 9.6 req/s, p95 2.5 s while 10
  writers and 1 reader ran).
- **Fix (commit `4821953`):** `verifyChainAsync()` — the same verification via a shared per-row check,
  yielding every 200 rows, one shared pass for concurrent callers, same memo token. Writers 98.7 req/s,
  p95 0.17 s under the same load; the read itself became slower (~4.8 s). 13 tests, including every
  tamper mode, a late-batch tamper and an out-of-band second-connection tamper.
- **Not implemented:** incremental/checkpointed verification (it would delay detection of old-row
  tampering unless paired with a scheduled full pass). The measurements justified un-blocking the
  event loop, not weakening the check.

## 9. Evidence pagination

Covered in §4 (browser) and by `api-ledger-pagination.test.ts`, `dashboard-evidence-paging.test.ts`
and the load test's cursor walk (a `limit=500` walk of 10,823 entries visited each exactly once,
newest first, in ~0.75 s).

## 10. Docker verification — NOT performed

- **What happened:** Docker Desktop was started but its Linux engine never came up
  (`dockerDesktopLinuxEngine` pipe missing; the `docker-desktop` WSL distro stayed stopped), and I did
  not loop on it. **No image was built, no container run, `docker stop` / SIGTERM exit code not
  checked, container user not inspected.**
- **What I did instead (a substitute, not equivalent):**
  - Recreated the image's runtime layer in a scratch directory — `npm ci --omit=dev` + `dist/` +
    `public/` (typescript absent) — and ran `node --experimental-wasm-modules dist/api/main.js` the way
    the Dockerfile's `CMD` does, with `NODE_ENV=production`:
    - without signing keys: exits 1 and names both variables (no key material printed);
    - with throwaway keys (generated in the scratch dir, never in the repo): `/readyz` and `/healthz`
      return `{"status":"ok"}`; the CSP header is present; a principal created before a hard kill
      still authenticates after restart on the same DB + keys, with the same ledger public key and
      `chainValid:true`; neither the root key, the ledger key nor an API key appears in 46 log lines.
  - `docker compose config` validates `docker-compose.yml` and refuses to render without the key
    variables. The Dockerfile was reviewed statically: multi-stage, `USER node`, `/data` volume,
    exec-form `CMD` so SIGTERM reaches Node, `HEALTHCHECK` on `/healthz`; compose adds `read_only`,
    `cap_drop: ALL`, `no-new-privileges`.
- **Not verified by me locally:** the image build, running as non-root at runtime, graceful shutdown/exit code
  (the Windows `e2e` skips it; WSL Ubuntu has no Node), persistence across a container restart, tests
  inside a container.
- **Independent evidence from CI (after the merge, §11):** the workflow's `docker` job — build the image on
  Linux, refuse to start without signing keys, start with ephemeral keys, `/readyz` + `/healthz` + CSP
  header, `docker stop` exit code 0 — passed on `f884e34`. That covers build, startup, health and graceful
  stop; it does **not** cover persistence across restart, non-root inspection, or running the test suite in
  the container. No hosted deployment has occurred. No Stripe credentials were used.

## 11. CI verification

`.github/workflows/ci.yml` was read in full: a `test` job (`npm ci`, lint, typecheck, build, tests,
verifier tests, audits) and a `docker` job (build; refuses to start without keys; start → `/readyz`,
`/healthz`, CSP header → `docker stop` exit 0). It was **not executed or YAML-linted locally** (no YAML
parser available offline). Locally I ran the `test` job's steps (lint, typecheck, build, tests,
verifier tests, `npm audit`) and the e2e script. The workflow triggers on pushes to `main` and on pull
requests, so the first real run happened after the merge. **Result: run
[43715624396](https://github.com/AryanRajguru22/Aegis/actions/runs/43715624396) on `f884e34` (main) —
`test` job success and `docker` job success** (read from the public GitHub API after the run completed).
The workflow's `e2e` is not a CI step; only the Windows e2e run above covers it.

## 12. Final test results

Measured at the final tree before the report/docs commit (Windows, Node 24.13.1):

| Check | Result |
|---|---|
| `npm test` | **723 tests / 208 suites, 723 pass, 0 fail, 0 skipped** |
| `npm run test:verifier` | **92 tests / 14 suites, 92 pass, 0 fail** |
| Total | **815 pass** (baseline `e29ae92`: 756; +59) |
| `npm run e2e` | PASS (graceful-shutdown step skipped on Windows) |
| `npm run typecheck` | clean (main + verifier) |
| `npm run lint` | clean (188 files, includes the secret scan) |
| `npm audit` | 0 vulnerabilities |
| `npm run loadtest` | 104 checks, 0 failures |

## 13. Security limitations (what remains)

- Separation of duties between developer and operator is not enforceable (§6).
- Tail truncation of the ledger is undetectable from a single snapshot; one ledger signing key;
  no HSM/threshold signing.
- `/ledger` verification is O(entries) CPU on a shared event loop; the chain is global across tenants,
  so a busy ledger makes verification slow for everyone (§8). Sign-ups are open (rate-limited per IP).
- A revocation that lands after a rail request has begun cannot recall that request.
- Escalations never expire on a timer.
- `POST /lab/reset` is open to any signed-up principal (low-severity demo-lab DoS).
- Single instance, single SQLite file; the rate limiter is in memory per process.
- No external penetration test or security audit. The demo risk judge is deterministic, not AI.

## 14. Remaining deployment requirements

Before real money: run the Docker image and CI on Linux and read the results; deploy to a staging
URL behind TLS with `AEGIS_TRUST_PROXY` set; generate and store the two signing keys in a secret
manager and back up the DB *and* keys; decide the reviewer/identity model (§6); run a soak and a
production-shaped load test (real judge latency, real network, real rail); external security review;
exercise the Stripe test rail and a real AI judge with real credentials; monitoring/alerting on
`/readyz`, ledger `chainValid` and indeterminate escalations. **This product should not move real
money on the strength of this report.**

## 15. Final Git commit information

Commits in this pass (on top of `e29ae92`), oldest first:

| Commit | Change |
|---|---|
| `39a5edc` | fix(capability): explicit run limits on authorizer queries (flaky test root cause) |
| `e3b2f7a` | feat(escalation): operator approve/reject workflow |
| `4821953` | perf(ledger): cooperative single-flight verification; load-test harness |
| (next) | UI error placement, final docs, this report |

The final release-branch and `main` hashes, and whether `origin/main` equals local `main`, are stated
in the hand-off message after the merge was performed and verified (a commit cannot contain its own
hash).
