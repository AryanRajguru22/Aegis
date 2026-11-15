# Testing

## Commands

```bash
npm test              # main Aegis suite — 723 tests
npm run test:verifier # the independent verifier's own suite — 92 tests
npm run e2e           # production-mode boot, restart persistence, verifier on the live DB
npm run loadtest      # load + concurrency invariants (see LOAD_TESTING.md); not part of `npm test`
```

Both compile from TypeScript first (`npm run build` / `npm run build:verifier`), then
run against the compiled output with Node's built-in test runner
(`node --test --test-reporter=spec`) — no external test framework, no mocking library.

Narrower slices exist for iteration (`npm run test:capability`, `test:state`,
`test:risk`, `test:decision`, `test:rails`, `test:execution`, `test:api`,
`test:mission` — see `package.json`). `npm test` is the complete main suite and is
what CI or a judge should run.

Three files are **deliberately excluded** from `npm test`:
`src/risk/__tests__/anthropic-judge.live.test.ts`,
`src/risk/__tests__/gemini-judge.live.test.ts`, and
`src/rails/__tests__/stripe-rail.live.test.ts` — reachable only via
`test:risk:live` / `test:risk:live:gemini` / `test:rails:live`, and only if a real
`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `STRIPE_SECRET_KEY` is present respectively.
They are not part of the standard, credential-free run.

## Results as of this pass

```
npm test:
  tests 723
  suites 208
  pass 723
  fail 0
  skipped 0

npm run test:verifier:
  tests 92
  suites 14
  pass 92
  fail 0
```

815 tests total (723 + 92), 0 failures, 0 skipped, plus `npm run e2e` (production-mode boot, restart persistence, tampered-ledger detection by the independent verifier; its graceful-shutdown step is skipped on Windows), `npm run typecheck`, `npm run lint` and `npm audit` (0 vulnerabilities) all clean, and `npm run loadtest` (104 invariant checks) all holding — measured on Windows 11 / Node 24.13.1.

**Formerly flaky test — root-caused and fixed.** `extractRootFacts … recovers principalId and delegatedGoal` failed intermittently under load with `{ RunLimit: 'Timeout' }`. Cause: `Authorizer.query()` (no limits argument) runs under the Biscuit engine's built-in ~1 ms run limit, unlike every authorization call here, which passes explicit 5 s limits; any CPU contention could exceed 1 ms. Reproduced on demand (8 parallel workers running the capability suite: 5 failures in 160 runs; 10 timeouts in 3,200 direct `extractRootFacts` calls); after routing the query through `queryWithLimits(AUTHORIZE_LIMITS)`: 0 failures in 400 suite runs and 0 in 3,200 calls. Regression coverage: `capability-query-limits.test.ts` pins that queries use the explicit limits (the timing failure itself is not deterministic, so the stress loop above is the evidence).

## What the suite is organized around

| Area | Files | What it proves |
|---|---|---|
| Capability | `src/capability/__tests__/capability-core.test.ts` | Token minting, attenuation is structurally narrowing-only (an attempt to widen is rejected before it becomes a usable token), signature verification, revocation-ancestry checks |
| State / persistence | `src/state/__tests__/*.test.ts` | The hash-chained ledger's happy path and tamper detection (content-hash mismatch, broken `prevHash` link, forged signature), the revocation store, the mission store's referential integrity and cross-principal isolation |
| Mission | `src/mission/__tests__/*.test.ts` | Mission policy evaluation, and — the one most worth reading — `mission-reservation.test.ts`'s adversarial concurrency cases: the atomic reserve/release SQL under genuinely concurrent calls, not simulated |
| Decision | `src/decision/__tests__/decision-core.test.ts` | `combineRiskSignals()`'s full truth table — every combination of intent-judge verdict and baseline flags maps to the correct allow/deny/escalate, including the cases proving a passing intent judgment can never suppress a behavioral flag or vice versa |
| Risk | `src/risk/__tests__/risk-core.test.ts`, `gemini-judge.test.ts` | The behavioral-baseline heuristics in isolation (rate-window boundaries, the amount-deviation multiplier, transactions outside the rate window correctly not counting), plus `GeminiIntentJudge`'s response-parsing and error-handling logic against a fake, injected client — no network |
| Execution | `src/execution/__tests__/execution-core.test.ts` | Rail-agnostic execution dispatch |
| Pre-rail recheck | `src/api/__tests__/api-pre-rail-recheck.test.ts` | Holds the intent judge open on a test-controlled promise, then revokes the agent / cancels or expires the mission / creates the agent's first mission while the request is provably in flight; asserts the rail is never called, the reservation returns, and a `pre_execution_recheck` entry is ledgered. 6 of its 7 tests fail if the re-check is removed (verified) |
| Ledger paging & memo | `src/api/__tests__/api-ledger-pagination.test.ts`, `src/state/__tests__/ledger-verification-memo.test.ts`, `src/api/__tests__/dashboard-evidence-paging.test.ts` | Cursor paging reassembles the full history without gaps; `chainValid` covers the whole chain not the page; the `verifyChain` memo never hides tampering (in-process UPDATE/DELETE and an out-of-band write from a separate connection are all detected); Evidence UI paging/filter/detail |
| Escalation resolution | `src/api/__tests__/api-escalation-resolution.test.ts` (31), `dashboard-escalation-review.test.ts` (9), `verifier/__tests__/settlementAttribution.test.ts` (+4) | An escalation opens only from `/transactions` (never `/simulate`), holds no budget while pending; approve/reject by the owning principal only — the agent's own capability token, no credential and another principal are all refused; approval re-verifies the capability and mission and reserves budget at approval time (two escalations that fit separately but not together cannot both be approved, also under concurrency); revoked / revoked-ancestor / cancelled / expired / newly-mission-bound agents are refused with the escalation left pending; exactly one decision wins (duplicate = idempotent replay, conflicting = 409, concurrent approve+approve+reject); a rejected transaction never reaches the rail; an approval followed by a last-moment revocation is withdrawn inside `executeApprovedEscalation` and ledgered; crash recovery marks an approved-without-outcome escalation `indeterminate`, never re-executes it, and keeps its reservation. Mutation-checked: removing the capability re-verification, or the status check and the conditional `UPDATE`, makes tests fail |
| Async ledger verification | `src/state/__tests__/ledger-verify-async.test.ts` (13) | `verifyChainAsync()` returns exactly `verifyChain()`'s verdict for a valid chain and for content/link/signature/deletion tampering (also deep in a later batch), really yields to the event loop, shares one pass between concurrent callers, and the memo never hides a later UPDATE or an out-of-band write from a second connection |
| Capability query limits | `src/capability/__tests__/capability-query-limits.test.ts` | Authorizer queries always use the explicit run limits (root cause of the formerly flaky test) |
| Rails | `src/rails/__tests__/mock-x402-rail.test.ts`, `stripe-rail.test.ts` | Both rail adapters' non-credentialed behavior (fixed price-catalog matching for mock_x402; request shaping for the Stripe adapter without ever calling the real network) |
| API | `src/api/__tests__/api-*.test.ts` | End-to-end route behavior: auth, idempotency under real concurrency, restart/crash-recovery of in-flight claims, mission integration, rail integration |
| Dashboard | `src/api/__tests__/dashboard-*.test.ts` | `public/app.js` loaded via `node:vm` and exercised directly — the Authority Flow rendering, the Attack Theatre's real concurrent-request counting, the attenuation-expiry edge case, and (`dashboard-xss-regression.test.ts`) that every value the dashboard renders from a server response is escaped, never injected as raw HTML |
| Demo mode | `src/api/__tests__/demo-mode.test.ts`, `demo-tamper.test.ts` | `AEGIS_DEMO_MODE`'s exact, narrow surface (which judge, which rails), the `AEGIS_RISK_PROVIDER` precedence rules for choosing between the Anthropic and Gemini judges outside demo mode (explicit choice, single-key inference, both-keys-ambiguous, neither-key, invalid value), `AEGIS_JUDGE_TIMEOUT_MS` validation and the provider-aware default (8s non-Gemini / 45s Gemini) proven distinct, and the demo-only tamper route used by the Evidence workspace |
| Verifier | `verifier/__tests__/*.test.ts` | The independent tool's own correctness, run against fixtures it builds itself — including that it correctly *refuses* to certify a tampered or incomplete export rather than guessing |

## What these tests prove

- The pipeline stages compose correctly for every verdict combination, not just the
  allow path.
- Attenuation cannot widen — this is asserted directly, not inferred from absence of a
  counterexample.
- Mission budget reservation is safe under real concurrent requests (the test fires
  genuinely concurrent calls and asserts on final server state, not on call order).
- Revocation cascades to descendants without a separate propagation step.
- The ledger's tamper detection catches every category of tampering the implementation
  claims to catch: content mutation, chain-link breakage, and signature forgery.
- Idempotency survives a simulated hard restart, not just a normal retry.
- The dashboard never renders unescaped server data (the specific regression class most
  relevant to a UI that renders live decision data from an API).
- The independent verifier reaches the same conclusions as Aegis's own check, from a
  completely separate code path.

## What these tests do NOT prove

- **No production-scale or soak testing.** `npm test`'s concurrency tests prove correctness under
  real concurrent calls at test scale (tens of requests). `npm run loadtest` extends that to a
  few thousand requests per scenario at concurrency 1/10/50 on one developer machine
  ([LOAD_TESTING.md](LOAD_TESTING.md)) — not production volume, not hours-long, not a real network.
- **No real AI risk evaluation is exercised.** `anthropic-judge.live.test.ts` and
  `gemini-judge.live.test.ts` require a real `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`
  respectively and are both excluded from `npm test` — the standard run never calls a
  real model, for either provider. `gemini-judge.test.ts` proves `GeminiIntentJudge`'s
  own parsing/error-handling logic against a fake client, which is not the same claim.
- **No real payment settlement.** `stripe-rail.live.test.ts` is excluded the same way;
  the standard run never touches Stripe's real network.
- **No penetration testing or external security audit.** The test suite is unit/
  integration coverage of the code as written, not an adversarial red-team exercise.
- **Real-browser verification was performed once, manually, not automated** (Chrome via the browser extension, against a demo-mode server with ~1,850 ledger entries): Evidence paging/filter/expand/verifier-command, error and empty states, a 500-entry refresh with no main-thread stall over 30 ms, no console errors, all six workspaces rendering, and the Operator review flow (reject, approve → settled, approval refused after revocation). It is not part of `npm test`, and only Chrome at one window size was used; the native `confirm()` dialogs were stubbed because they block browser automation.
- **Docker and Linux graceful shutdown were not run in the final pass** (the Docker Desktop engine would not start). The production runtime layer (prod-only dependencies + compiled output) was started natively, and CI's `docker` job covers the image.
- **No browser-matrix UI testing in the automated suite.** The dashboard tests run
  `app.js` in a `node:vm` sandbox (fast, deterministic, no real browser), which proves
  its logic but not real-browser rendering — see [DEMO.md](DEMO.md) for the manual
  real-browser verification performed alongside this pass.
- **No long-running/soak testing** of the SQLite-backed persistence layer.
