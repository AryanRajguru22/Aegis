# Architecture

This document describes **what is actually implemented and running**, grounded in the
current source tree. For the broader design vision and long-term roadmap (some of which
is intentionally not built yet), see [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md),
[TRUST_MODEL.md](TRUST_MODEL.md), and [MVP_SCOPE.md](MVP_SCOPE.md). Where the two
disagree in specifics, this document — describing the code as it exists today — is the
one to trust.

## 1. System overview

Aegis is a single long-running Node.js/Express process plus a static, framework-free
dashboard. There is no separate frontend build, no separate API gateway, and no
microservices — everything below runs in one process, backed by one SQLite database.

```
Browser (public/index.html + public/app.js)
      │  fetch() + one SSE stream, no framework, no build step
      ▼
Express app (src/api/server.ts)
   ├── express.static(public/)         — serves the dashboard itself
   ├── GET  /demo-mode                 — unauthenticated: is this instance in demo mode
   ├── /principals, /agents, /missions,
   │   /transactions, /ledger, /stream — the real API, principal-API-key authenticated
   └── errorHandler                    — uniform JSON error shape
      │
      ▼
src/capability   Biscuit token minting, attenuation, revocation-aware verification
src/mission      mission policy + atomic budget reservation
src/decision     composite allow/deny/escalate verdict
src/risk         intent-consistency judge (pluggable) + behavioral baseline heuristics
src/execution    rail-agnostic transaction execution
src/rails        stripe_test adapter, mock_x402 adapter + its own tiny demo-merchant server
src/state        SQLite (node:sqlite), the hash-chained/signed ledger, crypto primitives
      │
      ▼
verifier/        a SEPARATE, standalone tool — imports nothing from src/ — that
                 independently re-derives ledger and mission-budget integrity
```

## 2. Frontend

`public/index.html` + `public/app.js` — vanilla HTML/CSS/JS, no framework, no build
step, no bundler. Served directly by `express.static`. It is a single-page shell with
six workspaces (`Overview`, `Authority`, `Missions`, `Transactions`, `Security`,
`Evidence`), switched client-side with no page reload; every workspace calls the same
real API a script would.

Each workspace has its own full-bleed background photograph
(`public/assets/{overview,authority,missions,transactions,security,evidence}.png`),
crossfaded on navigation, with mouse/scroll parallax and idle drift layered on top and
paused under `prefers-reduced-motion`. A transaction's verdict (allow/deny/escalate)
drives a short color-coded signal on this same environment layer — green/red/gold,
matching the verdict colors used everywhere else in the UI. None of this touches
application state; it is a rendering layer only, and the environment element is
`pointer-events: none` so it never intercepts a click.

## 3. Backend request flow

Every route in `src/api/routes/` is a thin translation layer: it validates the request
shape, calls straight into `src/capability` / `src/mission` / `src/decision` /
`src/execution` / `src/state`, and serializes the result. No business logic is
duplicated in the route layer — this is enforced by convention and checked by the
dashboard XSS/regression tests, which assert on the exact shapes those modules return.

**Actual registered endpoints** (`src/api/routes/*.ts`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/principals` | create a principal, returns an API key (shown once) |
| `POST` | `/agents` | register a root agent, returns a capability token |
| `POST` | `/agents/:parentId/attenuate` | mint a narrower sub-agent token from a parent's |
| `POST` | `/agents/:id/revoke` | revoke a node — cascades to every descendant |
| `GET` | `/agents`, `/agents/:id`, `/agents/:id/graph` | read agents / delegation lineage |
| `POST` | `/missions` | create a bounded, budgeted mission for an agent |
| `GET` | `/missions`, `/agents/:agentId/missions`, `/missions/:id` | read missions |
| `POST` | `/missions/:id/cancel` | cancel a mission |
| `POST` | `/simulate` | dry-run a transaction through the full decision pipeline, no execution |
| `POST` | `/transactions` | submit a transaction for real evaluation + (if allowed) execution |
| `GET` | `/ledger` | query the hash-chained audit ledger |
| `GET` | `/stream` | Server-Sent Events stream of live decisions, feeding the dashboard's live feed |
| `GET` | `/demo-mode` | unauthenticated — is this instance running with `AEGIS_DEMO_MODE=true` |

## 4. The transaction pipeline

This is the actual sequence a `POST /transactions` call runs through
(`src/decision/decide.ts`, `src/mission/reservation.ts`,
`src/execution`), in order — a denial or escalation stops exactly here, nothing later
ever runs:

1. **Mission gate + atomic budget reservation** (if a mission is attached) — one SQL
   `UPDATE` computes `budget − reserved − settled ≥ requested` and reserves in the same
   write. This is what makes concurrent requests against one budget safe; see the
   Security workspace's live concurrent-budget-race demo for this running under real
   contention, not a single-threaded test.
2. **Capability / policy check** — verifies the presented token's full Biscuit chain
   (amount, currency, category, rail, expiry) and, live, whether the token or any
   ancestor has been revoked.
3. **Risk check** — two independent signals, combined by
   `combineRiskSignals()` (`src/decision/decide.ts`):
   - **Intent-consistency judge** (`src/risk/types.ts`'s `IntentJudge` interface) —
     pluggable. In demo mode it is `createDemoIntentJudge()`
     (`src/api/demoMode.ts`) — a fixed function that always returns `"consistent"` and
     says so explicitly in its own rationale text. Outside demo mode it is one of two
     real implementations — `AnthropicIntentJudge` (`src/risk/anthropicJudge.ts`) or
     `GeminiIntentJudge` (`src/risk/geminiJudge.ts`) — chosen by `AEGIS_RISK_PROVIDER`
     (or automatically if only one provider's key is set); see `src/api/demoMode.ts`'s
     `createServerIntentJudge()`.
   - **Behavioral baseline** (`src/risk/baseline.ts`) — two simple, disclosed
     heuristics: a rolling-window transaction-rate check (5+ transactions by the same
     agent within 60s), and an amount-deviation check (a transaction more than 3× an
     agent's own historical mean, once it has at least 3 prior transactions). Either
     one alone is enough to force `escalate`, regardless of what the intent judge said.
4. **Composite verdict** — `allow`, `deny`, or `escalate`. An `escalate` verdict is
   returned to the caller; nothing executes.
5. **Execution** (allow only) — `src/execution` calls the registered rail adapter
   (`src/rails/mockX402` in demo mode; `src/rails/stripeTestRail.ts` outside it, never
   both at once — see [SECURITY_MODEL.md](SECURITY_MODEL.md)).
6. **Ledger write** — every stage above writes its own signed, hash-chained entry
   (`src/state`), regardless of outcome — a deny or escalate is recorded exactly as
   durably as an allow.

## 5. Persistence

SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), opened once at startup
(`src/state/db.ts`). One file holds everything: principals, agents, ledger entries,
revocations, idempotency records, missions, and mission-reservation tickets — see that
file's own `CREATE TABLE` statements for the exact schema and the comments on each table
explaining why it exists. `AEGIS_DB_PATH` (default `./aegis.db`) controls the path; see
[render.yaml](../render.yaml) for how a persistent-disk deployment wires this to durable
storage across restarts.

## 6. Evidence and the independent verifier

Every ledger entry is Ed25519-signed and hash-chained to the entry before it
(`src/state`'s ledger module). `verifier/` is a genuinely separate tool: it imports
nothing from `src/`, and given only an exported ledger file plus Aegis's *public* key,
it independently re-derives whether the hash chain is intact and whether any mission's
settled spend ever exceeded its budget. See [`verifier/README.md`](../verifier/README.md)
for the full walkthrough, its exact guarantees, and its honestly-disclosed limitations
(in particular: tail truncation of the most recent entries is not detectable from a
single snapshot).

## 7. Deployment

The application is a normal long-running Node process — not serverless, not converted
to any other architecture for deployment. [`render.yaml`](../render.yaml) is a Render
Blueprint that runs `npm ci && npm run build`, starts
`node --experimental-wasm-modules dist/api/main.js`, mounts a 1GB persistent disk at
`/var/data` for `AEGIS_DB_PATH`, and health-checks `GET /demo-mode`. It has been
verified locally (see the deployment-prep conversation history) but **has not yet been
deployed to a live public URL** — do not read its presence as a claim that a hosted
instance currently exists.
