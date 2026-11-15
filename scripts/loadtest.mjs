#!/usr/bin/env node
// Repeatable load + concurrency test for the real Aegis HTTP app. No dependencies.
//
//   npm run build && npm run build:verifier && node scripts/loadtest.mjs
//   node scripts/loadtest.mjs --quick                 # short smoke run (~1 min)
//   node scripts/loadtest.mjs --concurrency=1,10,50 --duration=6 --out=loadtest-results.json
//
// It starts scripts/loadtest-server.mjs (the real createApp over a file-backed SQLite DB; see
// that file for exactly what is scripted) as a child process and drives it over HTTP from this
// process. It reports measured throughput/latency AND asserts the safety invariants; the exit
// code is non-zero if any invariant fails. Methodology and the honest limits of the numbers are
// in docs/LOAD_TESTING.md.
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const QUICK = args.quick === "true";
const LEVELS = (args.concurrency ?? "1,10,50").split(",").map(Number);
const DURATION_MS = Number(args.duration ?? (QUICK ? 3 : 6)) * 1000;
const LEDGER_TARGET = Number(args["ledger-entries"] ?? (QUICK ? 3000 : 10000));
const ONLY = args.only ? new Set(args.only.split(",")) : null;
const OUT = args.out;

const AMOUNT = 38_000; // matches the mock merchant's catalog entry for acme-airlines:flights
const failures = [];
const results = { machine: machineSpec(), config: { levels: LEVELS, durationMs: DURATION_MS, ledgerTarget: LEDGER_TARGET, judgeLatencyMs: 20 }, scenarios: {} };

function machineSpec() {
  const cpus = os.cpus();
  return { platform: `${os.platform()} ${os.release()}`, cpu: cpus[0]?.model?.trim(), logicalCores: cpus.length, memoryGb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version };
}
function check(name, ok, detail = "") {
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
const r1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// ---------- server child process ----------
async function startServer(name, { judgeMs = 20 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-load-"));
  const dbPath = path.join(dir, `${name}.db`);
  const child = fork(path.join(ROOT, "scripts/loadtest-server.mjs"), [], {
    env: { ...process.env, LT_DB: dbPath, LT_JUDGE_MS: String(judgeMs) },
    execArgv: ["--experimental-wasm-modules", "--no-warnings"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const waiters = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    child.on("message", (m) => {
      if (m.type === "ready") resolve(m);
      else if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    });
    child.on("exit", (code) => reject(new Error(`load-test server exited early (code ${code}): ${stderr.slice(-500)}`)));
    setTimeout(() => reject(new Error("load-test server did not start in 30s")), 30000).unref();
  });
  const info = await ready;
  const rpc = (type, payload = {}) => new Promise((resolve) => { const id = nextId++; waiters.set(id, resolve); child.send({ type, id, ...payload }); });
  return {
    base: `http://127.0.0.1:${info.port}`,
    dbPath,
    ledgerPublicKeyHex: info.ledgerPublicKeyHex,
    rpc,
    async stop() {
      await Promise.race([rpc("shutdown"), sleep(5000)]);
      await sleep(150);
    },
  };
}

// ---------- HTTP client ----------
async function call(base, method, p, { auth, body, idem } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(idem ? { "idempotency-key": idem } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, ms: performance.now() - t0, startedAt: t0, json };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, startedAt: t0, error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e), json: null };
  }
}

const tx = (purpose = "Round-trip flight for the Q3 vendor conference") => ({ amountMinorUnits: AMOUNT, currency: "USD", category: "flights", rail: "mock_x402", purpose });
const caveats = () => ({ maxAmountMinorUnits: 100_000, currency: "USD", categories: ["flights"], rails: ["mock_x402"], expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
let uid = 0;
const uniq = (p) => `${p}-${Date.now().toString(36)}-${(uid++).toString(36)}`;

async function newPrincipal(base) {
  const id = uniq("p");
  const res = await call(base, "POST", "/principals", { body: { principalId: id } });
  if (res.status !== 201 && res.status !== 200) throw new Error(`principal setup failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { principalId: id, apiKey: res.json.apiKey };
}
async function newAgent(base, apiKey, agentId = uniq("agent")) {
  const res = await call(base, "POST", "/agents", { auth: apiKey, body: { agentId, delegatedGoal: "Book approved flights", caveats: caveats() } });
  if (res.status !== 201) throw new Error(`agent setup failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { agentId, token: res.json.token };
}
async function newMission(base, apiKey, agentId, budgetMinorUnits, missionId = uniq("m")) {
  const res = await call(base, "POST", "/missions", {
    auth: apiKey,
    body: { missionId, agentId, goal: "Purchase approved flights from acme-airlines.", budgetMinorUnits, currency: "USD", allowedCategories: ["flights"], approvedCounterparties: ["acme-airlines"], expiresAt: new Date(Date.now() + 86400_000).toISOString() },
  });
  if (res.status !== 201) throw new Error(`mission setup failed: ${res.status} ${JSON.stringify(res.json)}`);
  return missionId;
}
const submit = (base, token, missionId, purpose) =>
  call(base, "POST", "/transactions", { auth: token, idem: uniq("k"), body: { transaction: tx(purpose), counterparty: "acme-airlines", ...(missionId ? { missionId } : {}) } });
const isSettled = (r) => r.status === 200 && r.json?.decision?.verdict === "allow" && r.json?.execution?.success === true;
const getMission = async (base, apiKey, missionId) => (await call(base, "GET", `/missions/${missionId}`, { auth: apiKey })).json;

// ---------- load phase runner ----------
/** Runs `concurrency` async workers calling `fn(worker, i)` until `durationMs` elapses or `maxRequests` is reached. */
async function runPhase(server, { concurrency, durationMs, maxRequests = Infinity, fn }) {
  const latencies = [];
  const results = [];
  const statuses = {};
  let errors = 0, timeouts = 0, issued = 0;
  const s0 = await server.rpc("stats");
  let peakRss = s0.rssMb;
  const sampler = setInterval(async () => { const s = await server.rpc("stats"); peakRss = Math.max(peakRss, s.rssMb); }, 400);
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const deadline = t0 + durationMs;
  await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
    let i = 0;
    while (performance.now() < deadline && issued < maxRequests) {
      issued++;
      const r = await fn(w, i++);
      latencies.push(r.ms);
      results.push(r);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.error === "timeout") timeouts++; else if (r.status === 0 || r.status >= 500) errors++;
    }
  }));
  const wallMs = performance.now() - t0;
  clearInterval(sampler);
  const s1 = await server.rpc("stats");
  const c1 = process.cpuUsage(c0);
  latencies.sort((a, b) => a - b);
  return {
    results,
    summary: {
      concurrency,
      requests: latencies.length,
      rps: r1((latencies.length / wallMs) * 1000),
      p50Ms: r1(pct(latencies, 50)),
      p95Ms: r1(pct(latencies, 95)),
      p99Ms: r1(pct(latencies, 99)),
      maxMs: r1(latencies.at(-1) ?? null),
      errors5xxOrNetwork: errors,
      timeouts,
      statuses,
      serverCpuPercentOfOneCore: r1(((s1.cpuUserMs + s1.cpuSystemMs - s0.cpuUserMs - s0.cpuSystemMs) / wallMs) * 100),
      loadGeneratorCpuPercentOfOneCore: r1(((c1.user + c1.system) / 1000 / wallMs) * 100),
      serverPeakRssMb: r1(peakRss),
    },
  };
}

async function finalIntegrity(server, apiKey, label) {
  const t0 = performance.now();
  const led = await call(server.base, "GET", "/ledger?limit=1", { auth: apiKey });
  const ms = performance.now() - t0;
  check(`${label}: GET /ledger reports chainValid:true over the whole chain`, led.json?.chainValid === true, `${led.json?.page?.total ?? "?"} entries for this principal, verified in ${r1(ms)}ms`);
  return led.json?.chainValid === true;
}
function independentVerify(server, label) {
  const out = `${server.dbPath}.export.json`;
  const exp = spawnSync("node", [path.join(ROOT, "verifier/dist/export/exportLedger.js"), server.dbPath, server.ledgerPublicKeyHex, out], { encoding: "utf8" });
  if (exp.status !== 0) return check(`${label}: independent verifier export`, false, (exp.stderr || exp.stdout).slice(-300));
  const ver = spawnSync("node", [path.join(ROOT, "verifier/dist/cli.js"), out], { encoding: "utf8" });
  const verdict = /VERDICT: ([A-Z ]+)/.exec(ver.stdout)?.[1]?.trim() ?? `exit ${ver.status}`;
  const entries = /(\d+) entries/.exec(ver.stdout)?.[1];
  return check(`${label}: independent verifier (separate code, reads the DB file) exits 0`, ver.status === 0, `${verdict}${entries ? `, ${entries} entries` : ""}`);
}

const want = (name) => !ONLY || ONLY.has(name);
function header(t) { console.log(`\n=== ${t} ===`); }
function row(s) {
  console.log(`    c=${String(s.concurrency).padEnd(3)} ${String(s.requests).padStart(6)} req  ${String(s.rps).padStart(7)} rps  p50 ${String(s.p50Ms).padStart(7)}ms  p95 ${String(s.p95Ms).padStart(7)}ms  p99 ${String(s.p99Ms).padStart(7)}ms  err ${s.errors5xxOrNetwork}  timeouts ${s.timeouts}  srvCPU ${s.serverCpuPercentOfOneCore}%  rss ${s.serverPeakRssMb}MB`);
}

// ---------- scenarios ----------
async function scenarioSimulate() {
  header("S1  capability verification + policy + risk decision (POST /simulate; no execution)");
  results.scenarios.simulate = [];
  for (const c of LEVELS) {
    const server = await startServer(`simulate-c${c}`);
    const p = await newPrincipal(server.base);
    const agents = await Promise.all(Array.from({ length: c }, () => newAgent(server.base, p.apiKey)));
    const { summary, results: rs } = await runPhase(server, { concurrency: c, durationMs: DURATION_MS, fn: (w) => call(server.base, "POST", "/simulate", { auth: agents[w].token, body: { transaction: tx() } }) });
    row(summary);
    results.scenarios.simulate.push(summary);
    check(`c=${c}: every simulate returned a verdict`, rs.every((r) => r.status === 200 && r.json?.decision?.verdict === "allow"), `${summary.statuses[200] ?? 0}/${summary.requests} ok`);
    await finalIntegrity(server, p.apiKey, `c=${c}`);
    await server.stop();
    independentVerify(server, `c=${c}`);
  }
}

async function scenarioTransactions() {
  header("S2  concurrent transaction execution (POST /transactions: verify → mission gate → reserve → judge → rail → ledger), one agent+mission per worker");
  results.scenarios.transactions = [];
  for (const c of LEVELS) {
    const server = await startServer(`tx-c${c}`);
    const p = await newPrincipal(server.base);
    const ws = [];
    for (let i = 0; i < c; i++) { const a = await newAgent(server.base, p.apiKey); ws.push({ ...a, missionId: await newMission(server.base, p.apiKey, a.agentId, 100_000_000), settled: 0 }); }
    const { summary, results: rs } = await runPhase(server, { concurrency: c, durationMs: DURATION_MS, fn: async (w) => { const r = await submit(server.base, ws[w].token, ws[w].missionId); if (isSettled(r)) ws[w].settled++; return r; } });
    row(summary);
    results.scenarios.transactions.push(summary);
    const totalSettled = ws.reduce((n, w) => n + w.settled, 0);
    check(`c=${c}: every request settled`, rs.every(isSettled), `${totalSettled}/${summary.requests}`);
    let spentOk = true, reservedOk = true;
    for (const w of ws) { const m = await getMission(server.base, p.apiKey, w.missionId); if (m.spentMinorUnits !== w.settled * AMOUNT) spentOk = false; if (m.reservedMinorUnits !== 0) reservedOk = false; }
    check(`c=${c}: each mission's spent == settled × amount (ledger-derived)`, spentOk);
    check(`c=${c}: no reservation left behind`, reservedOk);
    const rail = (await server.rpc("railLog")).calls;
    check(`c=${c}: rail was called exactly once per settled transaction`, rail.length === totalSettled, `${rail.length} calls vs ${totalSettled} settled`);
    await finalIntegrity(server, p.apiKey, `c=${c}`);
    await server.stop();
    independentVerify(server, `c=${c}`);
  }
}

async function scenarioBudget() {
  header("S3  budget contention: many concurrent requests racing for ONE mission budget (K = 20 payments fit)");
  results.scenarios.budgetContention = [];
  const K = 20, REQUESTS = 200;
  for (const c of LEVELS) {
    const server = await startServer(`budget-c${c}`);
    const p = await newPrincipal(server.base);
    const a = await newAgent(server.base, p.apiKey);
    const missionId = await newMission(server.base, p.apiKey, a.agentId, K * AMOUNT);
    const { summary, results: rs } = await runPhase(server, { concurrency: c, durationMs: 120_000, maxRequests: REQUESTS, fn: () => submit(server.base, a.token, missionId) });
    row(summary);
    const settled = rs.filter(isSettled).length;
    const denied = rs.filter((r) => r.json?.decision?.verdict === "deny").length;
    const m = await getMission(server.base, p.apiKey, missionId);
    const rail = (await server.rpc("railLog")).calls;
    results.scenarios.budgetContention.push({ ...summary, settled, denied, budgetPayments: K });
    check(`c=${c}: settled (${settled}) never exceeds what the budget allows (${K})`, settled <= K);
    check(`c=${c}: and the budget was fully usable — exactly ${K} settled, ${REQUESTS - K} denied`, settled === K && denied === REQUESTS - K, `settled ${settled}, denied ${denied}`);
    check(`c=${c}: mission spent == budget, reserved == 0, remaining == 0`, m.spentMinorUnits === K * AMOUNT && m.reservedMinorUnits === 0 && m.remainingMinorUnits === 0, `spent ${m.spentMinorUnits}, reserved ${m.reservedMinorUnits}`);
    check(`c=${c}: the rail was called ${K} times, not once more`, rail.length === K, `${rail.length} calls`);
    await finalIntegrity(server, p.apiKey, `c=${c}`);
    await server.stop();
    independentVerify(server, `c=${c}`);
  }
  // Concurrent duplicates of one Idempotency-Key must collapse to a single execution.
  const server = await startServer("idem");
  const p = await newPrincipal(server.base);
  const a = await newAgent(server.base, p.apiKey);
  const missionId = await newMission(server.base, p.apiKey, a.agentId, 1000 * AMOUNT);
  const KEYS = 40, DUPES = 5;
  const batches = await Promise.all(Array.from({ length: KEYS }, async (_, k) => {
    const key = `dup-${k}`;
    return Promise.all(Array.from({ length: DUPES }, () => call(server.base, "POST", "/transactions", { auth: a.token, idem: key, body: { transaction: tx(), counterparty: "acme-airlines", missionId } })));
  }));
  const rail = (await server.rpc("railLog")).calls;
  const consistent = batches.every((b) => b.every((r) => r.status === 200 && JSON.stringify(r.json) === JSON.stringify(b[0].json)));
  check(`idempotency: ${KEYS} keys × ${DUPES} concurrent duplicates → exactly ${KEYS} rail calls`, rail.length === KEYS, `${rail.length} calls`);
  check("idempotency: every duplicate received the identical response", consistent);
  await finalIntegrity(server, p.apiKey, "idempotency");
  await server.stop();
  independentVerify(server, "idempotency");
}

async function scenarioRevocation(kind) {
  const isRevoke = kind === "revocation";
  header(isRevoke ? "S4  revocation while transactions are in flight" : "S5  mission cancellation while transactions are in flight");
  results.scenarios[kind] = [];
  for (const c of LEVELS) {
    const server = await startServer(`${kind}-c${c}`);
    const p = await newPrincipal(server.base);
    const a = await newAgent(server.base, p.apiKey);
    const missionId = await newMission(server.base, p.apiKey, a.agentId, 100_000_000);
    let actionDoneAt = null;
    let actionResult = null;
    const phase = runPhase(server, { concurrency: c, durationMs: DURATION_MS, fn: () => submit(server.base, a.token, missionId) });
    await sleep(DURATION_MS / 2);
    actionResult = await (isRevoke
      ? call(server.base, "POST", `/agents/${a.agentId}/revoke`, { auth: p.apiKey, body: { reason: "load-test revocation" } })
      : call(server.base, "POST", `/missions/${missionId}/cancel`, { auth: p.apiKey }));
    actionDoneAt = performance.now();
    const { summary, results: rs } = await phase;
    row(summary);
    const ledgerKind = isRevoke ? "revocation" : "mission_cancelled";
    const { seq } = await server.rpc("revokeSeq", { kind: ledgerKind, agentId: a.agentId });
    const rail = (await server.rpc("railLog")).calls.filter((x) => x.agentId === a.agentId);
    const startedAfter = rail.filter((x) => seq !== null && x.startSeq >= seq);
    const settledBefore = rs.filter(isSettled).length;
    // A request whose HTTP call began after the action's response was received must not have settled.
    const lateSettled = rs.filter((r) => r.startedAt > actionDoneAt && isSettled(r)).length;
    const lateRequests = rs.filter((r) => r.startedAt > actionDoneAt).length;
    const lateDenied = rs.filter((r) => r.startedAt > actionDoneAt && r.json?.decision?.verdict === "deny").length;
    results.scenarios[kind].push({ ...summary, actionLatencyMs: r1(actionResult.ms), settledTotal: settledBefore, railCallsStartedAfterAction: startedAfter.length, requestsStartedAfterAction: lateRequests });
    check(`c=${c}: the ${isRevoke ? "revocation" : "cancellation"} succeeded under load`, actionResult.status === 200, `took ${r1(actionResult.ms)}ms`);
    check(`c=${c}: ZERO payment rail calls began after the ${isRevoke ? "revocation" : "cancellation"} was ledgered (seq ${seq})`, seq !== null && startedAfter.length === 0, `${rail.length} rail calls total, ${startedAfter.length} after`);
    check(`c=${c}: every request started after the response was denied — none settled`, lateSettled === 0 && lateDenied === lateRequests, `${lateRequests} late requests, ${lateDenied} denied, ${lateSettled} settled`);
    const m = await getMission(server.base, p.apiKey, missionId);
    check(`c=${c}: mission spent == settled × amount and nothing left reserved`, m.spentMinorUnits === settledBefore * AMOUNT && m.reservedMinorUnits === 0, `spent ${m.spentMinorUnits}, reserved ${m.reservedMinorUnits}`);
    await finalIntegrity(server, p.apiKey, `c=${c}`);
    await server.stop();
    independentVerify(server, `c=${c}`);
  }
}

async function scenarioLedger() {
  header(`S6  ledger reads, evidence pagination and integrity verification (ledger grown to ≥ ${LEDGER_TARGET} entries)`);
  const server = await startServer("ledger");
  const p = await newPrincipal(server.base);
  const agents = await Promise.all(Array.from({ length: 20 }, () => newAgent(server.base, p.apiKey)));
  // Grow the ledger with /simulate (3 signed entries each), 20 concurrent.
  let total = 0;
  const g0 = performance.now();
  while (total < LEDGER_TARGET) {
    for (let i = 0; i < 20; i++) await Promise.all(agents.map((a) => call(server.base, "POST", "/simulate", { auth: a.token, body: { transaction: tx() } })));
    total = (await call(server.base, "GET", "/ledger?limit=1", { auth: p.apiKey })).json?.page?.total ?? total;
  }
  console.log(`    grew the ledger to ${total} entries in ${r1((performance.now() - g0) / 1000)}s`);
  const out = { ledgerEntries: total };

  // One-shot cost of a full-chain verification (a cache miss) vs the memoized hit.
  await call(server.base, "POST", "/simulate", { auth: agents[0].token, body: { transaction: tx() } }); // a write invalidates the memo
  const miss = await call(server.base, "GET", "/ledger?limit=50", { auth: p.apiKey });
  const hit = await call(server.base, "GET", "/ledger?limit=50", { auth: p.apiKey });
  out.firstReadAfterWriteMs = r1(miss.ms);
  out.memoizedReadMs = r1(hit.ms);
  console.log(`    full verification at ${total} entries: first read after a write ${r1(miss.ms)}ms; next read (memoized) ${r1(hit.ms)}ms`);
  check("ledger: reads report chainValid:true", miss.json?.chainValid === true && hit.json?.chainValid === true);

  // Evidence pagination walk: page through the whole ledger newest-first with beforeSeq.
  let cursor = null, pages = 0, seen = 0, ordered = true, lastSeq = Infinity, walkTotal = null;
  const w0 = performance.now();
  while (pages < 400) {
    const r = await call(server.base, "GET", `/ledger?limit=500${cursor ? `&beforeSeq=${cursor}` : ""}`, { auth: p.apiKey });
    if (r.status !== 200) break;
    pages++; seen += r.json.entries.length;
    if (walkTotal === null) walkTotal = r.json.page.total; // the total at the start of the walk (no writers are running)
    for (const e of [...r.json.entries].reverse()) { if (e.seq >= lastSeq) ordered = false; lastSeq = e.seq; }
    if (!r.json.page.hasMore) break;
    cursor = r.json.page.nextBeforeSeq;
  }
  out.paginationWalk = { pages, entries: seen, ms: r1(performance.now() - w0) };
  check("pagination: a limit=500 walk visits every entry exactly once, newest first", seen === walkTotal && ordered, `${seen}/${walkTotal} entries in ${pages} pages, ${out.paginationWalk.ms}ms`);

  out.idleReads = [];
  console.log("  idle reads (no writers; every read after the first is a memo hit):");
  for (const c of [1, 10]) {
    const { summary } = await runPhase(server, { concurrency: c, durationMs: Math.min(DURATION_MS, 4000), fn: () => call(server.base, "GET", "/ledger?limit=50", { auth: p.apiKey }) });
    row(summary); out.idleReads.push(summary);
  }
  out.readsUnderWrites = [];
  console.log("  reads WHILE 10 writers continuously submit simulations (every write invalidates the memo → each read pays a full verification):");
  for (const c of [1, 10]) {
    const writers = runPhase(server, { concurrency: 10, durationMs: Math.min(DURATION_MS, 4000) + 1000, fn: (w) => call(server.base, "POST", "/simulate", { auth: agents[w % agents.length].token, body: { transaction: tx() } }) });
    await sleep(300);
    const { summary: reads } = await runPhase(server, { concurrency: c, durationMs: Math.min(DURATION_MS, 4000), fn: () => call(server.base, "GET", "/ledger?limit=50", { auth: p.apiKey }) });
    const { summary: writes } = await writers;
    console.log(`    readers c=${c}:`); row(reads); console.log("    writers c=10 (same period):"); row(writes);
    out.readsUnderWrites.push({ readers: reads, writers: writes });
  }
  results.scenarios.ledger = out;
  await finalIntegrity(server, p.apiKey, "after concurrent reads+writes");
  await server.stop();
  independentVerify(server, "after concurrent reads+writes");
}

async function scenarioEscalation() {
  header("S7  escalation workflow under load: open N escalations, then approve them ALL concurrently against a budget that fits K = 10");
  results.scenarios.escalation = [];
  const K = 10, N = 20;
  for (const c of LEVELS) {
    const server = await startServer(`esc-c${c}`);
    const p = await newPrincipal(server.base);
    const a = await newAgent(server.base, p.apiKey);
    const missionId = await newMission(server.base, p.apiKey, a.agentId, K * AMOUNT);
    // Opening concurrency is capped at K: every in-flight request holds a budget reservation while it awaits the judge, so more than K at once would be (correctly) denied for budget before it could even escalate.
    const open = await runPhase(server, { concurrency: Math.min(c, K), durationMs: 120_000, maxRequests: N, fn: () => submit(server.base, a.token, missionId, "ESCALATE: ambiguous purchase") });
    const ids = open.results.map((r) => r.json?.escalation?.escalationId).filter(Boolean);
    check(`c=${c}: ${N} escalated transactions opened ${N} pending escalations, nothing executed or reserved`, ids.length === N && (await server.rpc("railLog")).calls.length === 0 && (await getMission(server.base, p.apiKey, missionId)).reservedMinorUnits === 0);
    let next = 0;
    const approve = await runPhase(server, { concurrency: c, durationMs: 120_000, maxRequests: N, fn: () => call(server.base, "POST", `/escalations/${ids[next++]}/approve`, { auth: p.apiKey, body: { reason: "load-test approval" } }) });
    row(approve.summary);
    const ok = approve.results.filter((r) => r.status === 200 && r.json?.escalation?.outcome === "settled").length;
    const refused = approve.results.filter((r) => r.status === 409).length;
    const m = await getMission(server.base, p.apiKey, missionId);
    const rail = (await server.rpc("railLog")).calls;
    results.scenarios.escalation.push({ open: open.summary, approve: approve.summary, approvedSettled: ok, refusedForBudget: refused, budgetPayments: K });
    check(`c=${c}: exactly ${K} approvals settled and ${N - K} were refused (budget), none overspent`, ok === K && refused === N - K, `${ok} settled, ${refused} refused`);
    check(`c=${c}: spent == budget, nothing reserved, rail called ${K} times`, m.spentMinorUnits === K * AMOUNT && m.reservedMinorUnits === 0 && rail.length === K, `spent ${m.spentMinorUnits}, reserved ${m.reservedMinorUnits}, rail ${rail.length}`);
    await finalIntegrity(server, p.apiKey, `c=${c}`);
    await server.stop();
    independentVerify(server, `c=${c}`);
  }
}

// ---------- main ----------
console.log(`Aegis load test — ${results.machine.cpu}, ${results.machine.logicalCores} logical cores, ${results.machine.memoryGb} GB, ${results.machine.platform}, node ${results.machine.node}`);
console.log(`levels ${LEVELS.join("/")} · ${DURATION_MS / 1000}s per throughput phase${QUICK ? " · QUICK" : ""}`);
if (want("simulate")) await scenarioSimulate();
if (want("transactions")) await scenarioTransactions();
if (want("budget")) await scenarioBudget();
if (want("revocation")) await scenarioRevocation("revocation");
if (want("cancellation")) await scenarioRevocation("cancellation");
if (want("ledger")) await scenarioLedger();
if (want("escalation")) await scenarioEscalation();

results.invariantFailures = failures;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\n${failures.length === 0 ? "LOAD TEST: ALL INVARIANTS HELD" : `LOAD TEST: ${failures.length} INVARIANT FAILURE(S)`}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
