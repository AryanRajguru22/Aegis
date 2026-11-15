# Load and concurrency testing

`npm run loadtest` (or `node scripts/loadtest.mjs --quick` for a ~1-minute smoke run) drives the
**real Aegis HTTP app** over HTTP at concurrency 1, 10 and 50 and asserts the safety invariants.
The exit code is non-zero if any invariant fails. This document separates what was **measured**,
what is **estimated**, and what is **unverified**.

## Method

- `scripts/loadtest-server.mjs` is a child process: the real `createApp` over a **file-backed
  SQLite** database, with the same stores, ledger, idempotency cache, reservation store,
  escalation store, and the real mock-x402 rail + local mock merchant that `src/api/main.ts` wires.
- `scripts/loadtest.mjs` (no dependencies) is the load generator. Every scenario gets a fresh
  server and database. Client and server are separate processes on the same machine, so they
  compete for CPU; the client's own CPU is reported next to the server's in the JSON output.
- **What is scripted, and therefore not representative of production:**
  - the intent judge is a stand-in with a fixed 20 ms latency (a real provider's 1–45 s network
    latency is not reproducible; the judge wait is where in-flight requests hold budget
    reservations, so real latency would raise concurrency-per-request, not lower it);
  - the behavioral baseline's rate threshold is raised so one agent can sustain load (the real 5
    per minute would — correctly — escalate almost every request);
  - no sign-up / auth-failure rate limiters (they would throttle the generator);
  - the rail is the in-process mock x402 (HTTP to a local merchant), not Stripe.
- Machine: 13th Gen Intel Core i5-13450HX, 16 logical cores, 15.7 GB RAM, Windows 11, Node 24.13.1.
  Windows timer granularity inflates the 20 ms judge sleep (c=1 simulate p50 is ~32–45 ms).
- Numbers are one run each, not averaged; expect ±20% run to run (compare the two S6 runs below).

## Invariants asserted (all held: 104 checks, 0 failures, in the final run)

| Scenario | Invariant |
|---|---|
| S1 simulate | every request returned a verdict; ledger `chainValid`; **independent verifier** (separate code reading the DB file) exits 0 |
| S2 transactions | every request settled; each mission's ledger-derived `spent == settled × amount`; no reservation left; rail called exactly once per settlement |
| S3 budget contention | 200 concurrent requests racing for a budget that fits exactly **K = 20**: settled **== 20** (never more, never fewer), 180 denied, `spent == budget`, `reserved == 0`, rail called exactly 20 times. Also: 40 idempotency keys × 5 concurrent duplicates → exactly 40 rail calls and identical responses |
| S4 revocation under load | revoke while workers submit continuously: **zero rail calls began after the revocation was ledgered** (each rail call records the ledger position at the moment it *started*); every request that began after the revoke response was denied; no settlement after it |
| S5 cancellation under load | same assertions for a mission cancel |
| S6 ledger | whole-chain `chainValid` after concurrent reads+writes; a `limit=500` cursor walk visits every entry exactly once, newest first |
| S7 escalation | 20 escalations opened (nothing executed, nothing reserved), then all approved concurrently against a budget that fits 10: exactly 10 settle, 10 are refused for budget, `spent == budget`, rail called 10 times |
| every run | `GET /ledger` reports `chainValid:true`, **and** the standalone verifier exits 0 (`TRUSTED`) on that run's database |

## Results (final code, one run, measured)

Throughput phases ran 6 s each. `srvCPU` is the server process's CPU as a percentage of one core;
the server is a single Node process, so ~100% means saturated on the event loop.

| Scenario | c | requests | req/s | p50 ms | p95 ms | p99 ms | 5xx/network errors | timeouts |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| S1 `/simulate` (verify → policy → judge → 3 ledger writes) | 1 | 175 | 29.0 | 31.6 | 47.4 | 57.1 | 0 | 0 |
| | 10 | 988 | 163.7 | 55.8 | 90.5 | 149.1 | 0 | 0 |
| | 50 | 1623 | 263.4 | 175.5 | 272.9 | 375.3 | 0 | 0 |
| S2 `/transactions` allow → settle | 1 | 123 | 20.4 | 47.2 | 64.9 | 72.6 | 0 | 0 |
| | 10 | 506 | 83.3 | 109.9 | 179.4 | 186.8 | 0 | 0 |
| | 50 | 573 | 88.1 | 538.5 | 757.5 | 783.6 | 0 | 0 |
| S3 one-mission budget race (200 req) | 1 | 200 | 113.2 | 3.1 | 56.0 | 63.6 | 0 | 0 |
| | 10 | 200 | 258.4 | 27.8 | 139.8 | 178.4 | 0 | 0 |
| | 50 | 200 | 268.5 | 89.9 | 698.1 | 730.1 | 0 | 0 |
| S4 revocation mid-load | 1 | 428 | 71.3 | 8.2 | 49.0 | 58.6 | 0 | 0 |
| | 10 | 452 | 74.1 | 130.3 | 203.9 | 256.2 | 0 | 0 |
| | 50 | 455 | 67.3 | 672.6 | 979.9 | 1250.2 | 0 | 0 |
| S5 cancellation mid-load | 1 | 655 | 109.1 | 4.6 | 53.3 | 76.6 | 0 | 0 |
| | 10 | 699 | 115.1 | 66.7 | 157.2 | 178.8 | 0 | 0 |
| | 50 | 608 | 95.4 | 409.1 | 990.9 | 1032.6 | 0 | 0 |
| S7 escalation approvals (20, c concurrent) | 1 | 20 | 107.9 | 3.6 | 22.7 | 33.3 | 0 | 0 |
| | 10 | 20 | 148.8 | 44.6 | 120.4 | 123.5 | 0 | 0 |
| | 50 | 20 | 118.0 | 92.2 | 165.1 | 168.6 | 0 | 0 |

Reading the table honestly:
- S3/S4/S5 mix expensive (settled) and cheap (denied) requests: once the budget is exhausted or the
  authority is revoked, requests are denied in ~3 ms, which inflates req/s and deflates p50. Their
  point is the invariants above, not peak throughput. **The settled-payment rate to take away is
  S2: ~20 req/s at c=1, ~85–90 req/s at c=10–50 on this machine** (the single event loop is the
  limit; latency then grows linearly with concurrency).
- Memory: server RSS peaked at ~90–350 MB (350 MB with a 10k-entry ledger being read).
- p99 at c=50 is 0.4–1.3 s. No request timed out (30 s client timeout) and none returned 5xx.

### Ledger reads and integrity verification (S6) — the measured limitation, and the fix

At **~10,800 ledger entries**, one full-chain verification costs **~1.1–2.1 s** of CPU (≈110–200 µs
per entry; the cost varies with machine load). Every write invalidates the memo, so with
continuous writes every `/ledger` read pays a full pass.

| `/ledger?limit=50` while 10 writers submit simulations | writer throughput | writer p95 | read p50 |
|---|--:|--:|--:|
| Before: synchronous `verifyChain()` (measured on the pre-fix build) | 9.6 req/s | 2528 ms | 2406 ms (c=1 reader) |
| After: cooperative `verifyChainAsync()` (final run) | 98.7 req/s | 174 ms | 4755 ms (c=1 reader) |

The synchronous pass blocked the entire event loop (payments included) for its whole duration. The
cooperative pass performs the identical whole-chain verification but yields every 200 rows and shares
one pass between concurrent readers; writers recover ~10× throughput. **The cost moved, it did not
vanish:** the read itself is now slower (~4.8 s) because it shares the CPU. Idle reads (memo hit):
p50 34 ms at c=1, 332 ms at c=10 at this size (that cost is listing and serialising the principal's
~10k entries, not verification). A `limit=500` cursor walk of the whole 10.8k-entry ledger takes ~0.75 s.

Not implemented, deliberately: **incremental / checkpointed verification.** It would make reads
cheap but would re-verify old rows less often, so detection of tampering with old entries would be
delayed unless paired with a scheduled full pass. The measurements justified un-blocking the event
loop (done, no change to what is verified) but not weakening the check. Guidance: do not poll
`/ledger` at high frequency on a large, busy ledger; at 100k entries a single verification would
take ~10–20 s (**estimated** by linear extrapolation, not measured).

## Estimated vs. unverified

**Estimated (extrapolation, not measured):** verification time at ≥ 20k entries; that a real judge's
latency (seconds) lowers settled-payment throughput per connection but not per-event-loop CPU.

**Unverified:** behaviour at production volume or over hours (no soak test); a real network between
client and server; Stripe or a real AI judge on the request path; multiple replicas (the design is
single-instance — one SQLite file, one process-local ledger writer); memory growth beyond a 10–15k
entry ledger; Linux/Docker performance (this ran on Windows); the effect of the production rate
limiters.

## Reproducing

```bash
npm run build && npm run build:verifier
node scripts/loadtest.mjs                       # full run, ~8 minutes
node scripts/loadtest.mjs --quick               # ~1 minute
node scripts/loadtest.mjs --only=budget,revocation --concurrency=1,10,50 --out=results.json
```

Options: `--concurrency=1,10,50`, `--duration=<seconds per throughput phase>`,
`--ledger-entries=<target for S6>`, `--only=simulate,transactions,budget,revocation,cancellation,ledger,escalation`,
`--out=<json file with every summary, the machine spec and any invariant failures>`.
