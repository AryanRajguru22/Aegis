# Testing

## Commands

```bash
npm test              # main Aegis suite — 571 tests
npm run test:verifier # the independent verifier's own suite — 58 tests
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
  tests 571
  suites 165
  pass 571
  fail 0

npm run test:verifier:
  tests 58
  suites 7
  pass 58
  fail 0
```

629 tests total, 0 failures, reproduced immediately before this document was written.

## What the suite is organized around

| Area | Files | What it proves |
|---|---|---|
| Capability | `src/capability/__tests__/capability-core.test.ts` | Token minting, attenuation is structurally narrowing-only (an attempt to widen is rejected before it becomes a usable token), signature verification, revocation-ancestry checks |
| State / persistence | `src/state/__tests__/*.test.ts` | The hash-chained ledger's happy path and tamper detection (content-hash mismatch, broken `prevHash` link, forged signature), the revocation store, the mission store's referential integrity and cross-principal isolation |
| Mission | `src/mission/__tests__/*.test.ts` | Mission policy evaluation, and — the one most worth reading — `mission-reservation.test.ts`'s adversarial concurrency cases: the atomic reserve/release SQL under genuinely concurrent calls, not simulated |
| Decision | `src/decision/__tests__/decision-core.test.ts` | `combineRiskSignals()`'s full truth table — every combination of intent-judge verdict and baseline flags maps to the correct allow/deny/escalate, including the cases proving a passing intent judgment can never suppress a behavioral flag or vice versa |
| Risk | `src/risk/__tests__/risk-core.test.ts`, `gemini-judge.test.ts` | The behavioral-baseline heuristics in isolation (rate-window boundaries, the amount-deviation multiplier, transactions outside the rate window correctly not counting), plus `GeminiIntentJudge`'s response-parsing and error-handling logic against a fake, injected client — no network |
| Execution | `src/execution/__tests__/execution-core.test.ts` | Rail-agnostic execution dispatch |
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

- **No load/scale testing.** The concurrency tests prove correctness under real
  concurrent calls at test-scale (tens of requests), not production request volume.
- **No real AI risk evaluation is exercised.** `anthropic-judge.live.test.ts` and
  `gemini-judge.live.test.ts` require a real `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`
  respectively and are both excluded from `npm test` — the standard run never calls a
  real model, for either provider. `gemini-judge.test.ts` proves `GeminiIntentJudge`'s
  own parsing/error-handling logic against a fake client, which is not the same claim.
- **No real payment settlement.** `stripe-rail.live.test.ts` is excluded the same way;
  the standard run never touches Stripe's real network.
- **No penetration testing or external security audit.** The test suite is unit/
  integration coverage of the code as written, not an adversarial red-team exercise.
- **No browser-matrix UI testing in the automated suite.** The dashboard tests run
  `app.js` in a `node:vm` sandbox (fast, deterministic, no real browser), which proves
  its logic but not real-browser rendering — see [DEMO.md](DEMO.md) for the manual
  real-browser verification performed alongside this pass.
- **No long-running/soak testing** of the SQLite-backed persistence layer.
