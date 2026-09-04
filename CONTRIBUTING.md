# Contributing

## Setup

```bash
git clone https://github.com/AryanRajguru22/aegis.git
cd aegis
npm install
AEGIS_DEMO_MODE=true npm start
```

Open http://localhost:8787. No external accounts or API keys are needed for local
development — see [`.env.example`](.env.example) for every environment variable the
app reads and when each one actually matters.

## Development workflow

- `npm run build` — compile TypeScript (`tsc`) to `dist/`.
- `npm start` — build, then run the compiled server.
- The dashboard (`public/`) is plain HTML/CSS/JS, served statically — no build step,
  no bundler. Edit `public/index.html` / `public/app.js` and reload the browser.
- Source lives in `src/`, one directory per concern (`capability`, `mission`,
  `decision`, `risk`, `execution`, `rails`, `state`, `api`) — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what each owns. Business,
  security, and ledger logic in these directories is the trust-critical core of the
  project — treat changes there with more scrutiny than UI changes.

## Tests

```bash
npm test              # main suite — 434 tests
npm run test:verifier # independent verifier's own suite — 58 tests
```

Every behavioral change needs a passing test suite before it's proposed — see
[`docs/TESTING.md`](docs/TESTING.md) for what each test category proves and what it
doesn't. Narrower slices (`npm run test:capability`, `test:mission`, `test:api`, etc.
— see `package.json`) are useful while iterating on one area.

Two test files require real external credentials and are excluded from `npm test`:
`test:risk:live` (needs `ANTHROPIC_API_KEY`) and `test:rails:live` (needs
`STRIPE_SECRET_KEY`). Don't add new tests to the default `npm test` run that require
credentials — the standard suite must stay runnable with zero external accounts.

## Branch / PR expectations

- One logical change per PR — a UI change and a decision-pipeline change are different
  PRs, even if related.
- Never commit secrets, real API keys, or real signing key values — `.env`,
  `*.db`, and log files are already gitignored; double-check before pushing anything
  outside that.
- Never fabricate a claim in code comments, docs, or a PR description — this project's
  documentation is held to "every technical statement is supported by the actual
  implementation." A limitation is more useful than an inflated claim.
- Preserve the honesty boundary between demo mode and credentialed operation
  (`src/api/demoMode.ts`) — anything that blurs which risk judge or rail actually ran
  is a regression, not a feature.
