#!/usr/bin/env node
// End-to-end release check (`npm run e2e`): boots the BUILT server with persistent keys on
// a temp database, drives the real HTTP API through a full authority -> mission ->
// transaction flow, exports the ledger, and runs the independent verifier CLI against it.
// Then it restarts on the same database (policy epoch must not be re-recorded, ledger must
// still verify), and finally corrupts one ledger row and requires the verifier to fail.
// Requires `npm run build` and `npm run build:verifier` first (the npm script does both).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "aegis-e2e-"));
const dbPath = join(dir, "aegis.db");
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const nodeArgs = ["--experimental-wasm-modules", "--no-warnings"];

const keys = Object.fromEntries(
  spawnSync("node", [...nodeArgs, "dist/api/keygen.js"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .map((l) => l.split("="))
);
assert.ok(keys.AEGIS_ROOT_PRIVATE_KEY_HEX && keys.AEGIS_LEDGER_PRIVATE_KEY_HEX, "keygen produced both keys");

const env = {
  ...process.env,
  NODE_ENV: "production",
  AEGIS_DEMO_MODE: "true",
  PORT: String(port),
  AEGIS_DB_PATH: dbPath,
  ...keys,
};
delete env.GEMINI_API_KEY;
delete env.ANTHROPIC_API_KEY;
delete env.STRIPE_SECRET_KEY;

let server;
let serverLog = "";
let ledgerPublicKey;

async function start() {
  server = spawn("node", [...nodeArgs, "dist/api/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) {
        ledgerPublicKey ??= /PUBLIC VERIFICATION KEY[^:]*: ([0-9a-f]+)/.exec(serverLog)?.[1];
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready\n${serverLog}`);
}

async function stop() {
  const exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));
  server.kill("SIGTERM");
  return exited;
}

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function verify() {
  const out = join(dir, "export.json");
  const exp = spawnSync("node", [...nodeArgs, "verifier/dist/export/exportLedger.js", dbPath, ledgerPublicKey, out], { encoding: "utf8" });
  assert.equal(exp.status, 0, `export failed: ${exp.stderr}`);
  const res = spawnSync("node", ["verifier/dist/cli.js", out], { encoding: "utf8" });
  return { code: res.status, out: res.stdout };
}

const step = (m) => console.log(`e2e: ${m}`);

try {
  await start();
  assert.ok(ledgerPublicKey, "server printed its ledger public key");
  step("server up (production mode, persistent keys)");
  assert.equal((await api("GET", "/healthz")).status, 200);

  const principal = await api("POST", "/principals", { body: { principalId: "e2e-corp" } });
  assert.equal(principal.status, 201);
  const key = principal.body.apiKey;
  assert.equal((await api("POST", "/principals", { body: { principalId: "e2e-corp" } })).status, 409);
  assert.equal((await api("GET", "/ledger", { token: "wrong" })).status, 401);

  const expiresAt = new Date(Date.now() + 200 * 864e5).toISOString();
  const agent = await api("POST", "/agents", {
    token: key,
    body: {
      agentId: "agent-1",
      delegatedGoal: "Book conference travel",
      caveats: { maxAmountMinorUnits: 200000, currency: "USD", categories: ["flights"], rails: ["mock_x402"], expiresAt },
    },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const mission = await api("POST", "/missions", {
    token: key,
    body: {
      missionId: "m-1",
      agentId: "agent-1",
      goal: "Buy one flight under budget",
      budgetMinorUnits: 100000,
      currency: "USD",
      allowedCategories: ["flights"],
      approvedCounterparties: ["acme-airlines"],
      expiresAt,
    },
  });
  assert.equal(mission.status, 201, JSON.stringify(mission.body));

  const tx = (idem, extra = {}) =>
    api("POST", "/transactions", {
      token: agent.body.token,
      headers: { "idempotency-key": idem },
      body: {
        counterparty: "acme-airlines",
        transaction: {
          amountMinorUnits: 38000,
          currency: "USD",
          category: "flights",
          rail: "mock_x402",
          purpose: "Round-trip flight for the Q3 conference",
        },
        ...extra,
      },
    });

  const allowed = await tx("e2e-1", { missionId: "m-1" });
  assert.equal(allowed.body.decision.verdict, "allow", JSON.stringify(allowed.body));
  const replay = await tx("e2e-1", { missionId: "m-1" });
  assert.equal(replay.body.decision.verdict, "allow", "idempotent replay returns the same outcome");
  const unbound = await tx("e2e-2");
  assert.equal(unbound.body.decision.verdict, "deny", "a mission-bound agent cannot spend without naming a mission");
  step("allow / idempotent replay / mission-required deny behave correctly");

  const ledger = await api("GET", "/ledger", { token: key });
  assert.equal(ledger.body.chainValid, true);
  assert.ok(!ledger.body.entries.some((e) => e.kind === "policy_epoch"), "system marker is not visible to principals");

  let v = verify();
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /ALL INVARIANTS VERIFIED/);
  step("independent verifier: exit 0 (ALL INVARIANTS VERIFIED)");

  const exited = await stop();
  if (process.platform === "win32") {
    // Node cannot deliver SIGTERM on Windows (it hard-terminates the child), so graceful
    // shutdown is only asserted on POSIX hosts — CI and the Docker image both cover it.
    step("graceful shutdown: skipped on Windows (verified on Linux CI / in Docker)");
  } else {
    assert.equal(exited.code, 0, `graceful shutdown should exit 0, got ${JSON.stringify(exited)}`);
    assert.match(serverLog, /Shutdown complete/);
    step("SIGTERM -> graceful shutdown, exit 0");
  }

  serverLog = "";
  await start();
  assert.doesNotMatch(serverLog, /Recorded the mission-binding policy epoch/, "epoch is not re-recorded on restart");
  assert.equal((await api("GET", "/ledger", { token: key })).body.chainValid, true);
  assert.equal((await tx("e2e-3", { missionId: "m-1" })).body.decision.verdict, "allow");
  v = verify();
  assert.equal(v.code, 0, v.out);
  step("restart on same DB + keys: state persisted, no second epoch, verifier exit 0");
  await stop();

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT seq, data_json FROM ledger_entries WHERE kind = 'execution_result' ORDER BY seq LIMIT 1").get();
  assert.ok(row, "an execution_result entry exists to tamper with");
  db.prepare("UPDATE ledger_entries SET data_json = ? WHERE seq = ?").run(row.data_json.replace("true", "false"), row.seq);
  db.close();
  v = verify();
  assert.equal(v.code, 1, `tampered ledger must fail verification:\n${v.out}`);
  step("tampered ledger row: independent verifier exit 1");

  console.log("e2e: PASS");
} catch (error) {
  console.error("e2e: FAIL\n", error);
  console.error("--- server log ---\n" + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  try {
    server?.kill("SIGKILL");
  } catch {
    /* already stopped */
  }
  rmSync(dir, { recursive: true, force: true });
}
