import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Step 13: dashboard-side tests for the Attack Theatre.
 *
 * Two concerns, matching the approved design's explicit test requirements:
 *  1. Scenario A's final counters/verification text must be DERIVED from whatever the
 *     real fetch responses actually said, never a hardcoded expectation — proven by
 *     feeding a deliberately unusual allow/deny split (not the "naturally expected"
 *     13/7 one) and confirming the rendered UI reflects exactly that.
 *  2. Scenario B/D's new rendering functions (renderDelegationChain,
 *     renderRevocationResult) must never turn dynamic text into DOM markup — the same
 *     XSS-safety discipline and node:vm differential-testing technique already
 *     established in dashboard-xss-regression.test.ts, applied to these two new
 *     functions specifically.
 */

const APP_JS_PATH = path.join(import.meta.dirname, "../../../public/app.js");

interface FakeTextNode {
  nodeType: 3;
  data: string;
}
interface FakeElement {
  tagName: string;
  childNodes: Array<FakeElement | FakeTextNode>;
  className: string;
  style: Record<string, string>;
  _text: string;
  textContent: string;
  innerHTML: string;
  value: string;
  setAttribute(name: string, value: string): void;
  appendChild<T extends FakeElement | FakeTextNode>(child: T): T;
  append(...children: Array<FakeElement | FakeTextNode>): void;
  addEventListener(type: string, fn: (...args: unknown[]) => unknown): void;
  click(): Promise<unknown>;
}

function makeFakeElement(tag: string): FakeElement {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const elem: FakeElement = {
    tagName: tag,
    childNodes: [],
    className: "",
    style: {},
    _text: "",
    value: "",
    get textContent() {
      if (this.childNodes.length === 0) return this._text;
      let out = "";
      const walk = (n: FakeElement | FakeTextNode): void => {
        if ("nodeType" in n) {
          out += n.data;
        } else {
          if (n.childNodes.length === 0) out += n._text;
          for (const c of n.childNodes) walk(c);
        }
      };
      walk(this);
      return out;
    },
    set textContent(v: string) {
      this._text = String(v);
      this.childNodes = [];
    },
    get innerHTML() {
      return this.textContent;
    },
    set innerHTML(v: string) {
      if (v !== "") throw new Error(`Unexpected non-empty innerHTML assignment: ${JSON.stringify(v)}`);
      this._text = "";
      this.childNodes = [];
    },
    setAttribute() {
      /* not needed */
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    append(...children) {
      for (const c of children) this.childNodes.push(c);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    click() {
      const fns = listeners.get("click") ?? [];
      return Promise.all(fns.map((fn) => fn()));
    },
  } as FakeElement;
  return elem;
}

/** Recursively collects every element tag name and every literal text value reachable under `node` — same helper as dashboard-xss-regression.test.ts. */
function walk(node: FakeElement | FakeTextNode, tags: string[], texts: string[]): void {
  if ("nodeType" in node) {
    texts.push(node.data);
    return;
  }
  tags.push(node.tagName);
  if (node.childNodes.length === 0 && node._text) texts.push(node._text);
  for (const child of node.childNodes) walk(child, tags, texts);
}

const DANGEROUS_TAGS = ["script", "img", "svg", "iframe", "object", "embed", "style", "link"];

function loadContext() {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFakeElement("div"));
      return elementsById.get(id)!;
    },
  };
  const context = vm.createContext({
    document: fakeDocument,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.reject(new Error("not stubbed in this context")),
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  vm.runInContext(src, context, { filename: "app.js" });
  return { context, elementsById } as unknown as {
    context: {
      renderDelegationChain: (container: FakeElement, chain: unknown[]) => void;
      renderRevocationResult: (label: string, result: unknown, railCalls?: number) => FakeElement;
      el: (tag: string, attrs?: Record<string, unknown>, children?: unknown[]) => FakeElement;
      buildAttackTraceStages: (record: unknown, txInput: unknown) => Array<FakeElement | FakeTextNode>;
      pickRepresentativeAttempt: (records: unknown[]) => unknown;
      renderAttackTrace: (records: unknown[], txInput: unknown) => void;
    };
    elementsById: Map<string, FakeElement>;
  };
}

describe("renderDelegationChain() — script-shaped agent IDs and caveat fields never become DOM markup", () => {
  test("a script-shaped agentId and category render as inert text only", () => {
    const { context } = loadContext();
    const container = context.el("div");
    const idPayload = "<script>window.__xss_fired=20</script>";
    const categoryPayload = "<img src=x onerror=alert(1)>";

    context.renderDelegationChain(container, [
      {
        role: "PARENT",
        agentId: idPayload,
        caveats: { maxAmountMinorUnits: 200_000, currency: "USD", categories: [categoryPayload], rails: ["mock_x402"] },
        revoked: false,
      },
    ]);

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);
    for (const dangerous of DANGEROUS_TAGS) assert.ok(!tags.includes(dangerous), `no <${dangerous}> from a delegation-chain field`);
    assert.ok(texts.some((t) => t.includes(idPayload)));
    assert.ok(texts.some((t) => t.includes(categoryPayload)));
  });

  test("the AUTHORITY CAN NARROW / CANNOT WIDEN tagline is always present and always plain text", () => {
    const { context } = loadContext();
    const container = context.el("div");
    context.renderDelegationChain(container, [
      { role: "CHILD", agentId: "agent-1", caveats: { maxAmountMinorUnits: 1, currency: "USD", categories: ["x"], rails: ["mock_x402"] }, revoked: true },
    ]);
    const texts: string[] = [];
    walk(container, [], texts);
    assert.ok(texts.some((t) => t.includes("AUTHORITY CAN NARROW")));
    assert.ok(texts.some((t) => t.includes("AUTHORITY CANNOT WIDEN")));
  });
});

describe("renderRevocationResult() — real server-echoed decision reasons never become DOM markup", () => {
  test("a script-shaped decision.reason (as a real risk-judge rationale could plausibly contain) renders as inert text only", () => {
    const { context } = loadContext();
    const payload = "<script>window.__xss_fired=21</script>";
    const card = context.renderRevocationResult("BEFORE REVOCATION", { decision: { verdict: "allow", reason: payload } });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);
    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });

  test("a script-shaped error message renders as inert text only", () => {
    const { context } = loadContext();
    const payload = '"><img src=x onerror=alert(2)>';
    const card = context.renderRevocationResult("AFTER REVOCATION", { __error: payload });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);
    assert.ok(!tags.includes("img"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });
});

// ---------- Scenario A: final counters must be derived from real responses ----------

interface DeferredCall {
  url: string;
  init: { method?: string; body?: string };
  resolve: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
}

function fakeJsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function loadAttackTheatreContext() {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  const formIds = ["txCategory", "txRail", "txCounterparty"];
  for (const id of formIds) elementsById.set(id, makeFakeElement("input"));
  elementsById.get("txCategory")!.value = "flights";
  elementsById.get("txRail")!.value = "mock_x402";
  elementsById.get("txCounterparty")!.value = "acme-airlines";
  for (const id of ["attackMissionInfo", "attackVerified", "attackSummary", "attackAttempts", "attackStatAttempts", "attackStatAllowed", "attackStatBlocked", "attackStatSpend", "attackLaunchBtn"]) {
    elementsById.set(id, makeFakeElement(id === "attackLaunchBtn" ? "button" : "div"));
  }

  const calls: DeferredCall[] = [];
  const fakeFetch = (url: string, init: { method?: string; body?: string } = {}) => {
    return new Promise((resolve) => {
      calls.push({ url, init, resolve: resolve as DeferredCall["resolve"] });
    });
  };

  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFakeElement("div"));
      return elementsById.get(id)!;
    },
  };

  const context = vm.createContext({
    document: fakeDocument,
    localStorage: {
      getItem: (key: string) => (key === "aegis_agent_tokens" ? JSON.stringify({ "agent-x": "fake-token" }) : null),
      setItem() {},
      removeItem() {},
    },
    fetch: fakeFetch,
    console,
    crypto: { randomUUID: () => `uuid-${Math.random()}` },
    confirm: () => false,
  });
  // attackMissionId/attackAgentId, like `state`, are top-level `let` bindings — only
  // reachable, from outside the sandbox, by appending to the SAME source evaluation
  // (see dashboard-request-race.test.ts's identical technique and its doc comment on
  // why). In real use these are set exclusively by attackCreateMission(); this test is
  // specifically about launchBudgetAttack()'s own counter-rendering logic, so they're
  // set directly here. state.lab is seeded too — launchBudgetAttack()'s final
  // verification GET goes through labApi(), which calls ensureLabIdentity() first;
  // without a pre-seeded lab identity it would issue an extra, unexpected
  // POST /lab/principals bootstrap call that this test's deferred-fetch harness never
  // resolves, hanging the test indefinitely (found via a real, reproduced hang).
  vm.runInContext(
    `${src}\nstate.activeAgentId = "agent-x";\nattackMissionId = "attack-test-1";\nattackAgentId = "agent-x";\nstate.lab = { principalId: "lab-x", apiKey: "lab-key-x" };`,
    context,
    { filename: "app.js" }
  );

  return {
    elementsById,
    calls,
    launchBudgetAttack: (context as unknown as { launchBudgetAttack: () => Promise<void> }).launchBudgetAttack,
  };
}

/**
 * attackCreateMission() itself (as opposed to launchBudgetAttack() above, which
 * assumes a mission/agent already exist) mints a lab agent token, then registers a
 * mission under it — both via separate, real `await`-ed POST calls. Each call
 * independently computes its own `expiresAt` from `Date.now()` at the moment it
 * builds its request body, so any real wall-clock time elapsed between the two calls
 * (a slow network round-trip, a busy event loop, anything) changes the gap between
 * them. `validateMissionAgainstToken` (src/mission/policy.ts) rejects a mission whose
 * expiresAt is later than its token's — so the two durations must be chosen far
 * enough apart that no realistic delay between the two calls can invert that
 * ordering. This deliberately introduces a real (not simulated) delay between the two
 * calls — via a genuine setTimeout, not a synchronously-resolved promise — to prove
 * the fix holds under actual elapsed time, the exact condition that broke the
 * previous 24h/24h version of this function.
 */
function loadAttackCreateMissionContext() {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  for (const id of ["attackMissionInfo", "attackVerified"]) {
    elementsById.set(id, makeFakeElement("div"));
  }

  const calls: DeferredCall[] = [];
  const fakeFetch = (url: string, init: { method?: string; body?: string } = {}) => {
    return new Promise((resolve) => {
      calls.push({ url, init, resolve: resolve as DeferredCall["resolve"] });
    });
  };

  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFakeElement("div"));
      return elementsById.get(id)!;
    },
  };

  const context = vm.createContext({
    document: fakeDocument,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fakeFetch,
    console,
    crypto: { randomUUID: () => `uuid-${Math.random()}` },
    confirm: () => false,
  });
  // Pre-seed state.lab so labApi()'s ensureLabIdentity() skips its own
  // POST /lab/principals bootstrap call — same technique loadAttackTheatreContext()
  // above uses, isolating this test to exactly the two calls attackCreateMission()
  // itself makes (/lab/agents, then /lab/missions).
  vm.runInContext(`${src}\nstate.lab = { principalId: "lab-x", apiKey: "lab-key-x" };`, context, { filename: "app.js" });

  return {
    elementsById,
    calls,
    attackCreateMission: (context as unknown as { attackCreateMission: () => Promise<void> }).attackCreateMission,
  };
}

describe("attackCreateMission() — the agent token must always outlive the mission, even under a real delay between the two setup calls", () => {
  test("a real ~50ms delay between minting the agent token and registering the mission still leaves mission.expiresAt <= token.expiresAt, and the mission is created successfully", async () => {
    const { elementsById, calls, attackCreateMission } = loadAttackCreateMissionContext();

    const run = attackCreateMission();

    // labApi() awaits ensureLabIdentity() first — an async function whose early
    // return (state.lab.apiKey is already seeded above) still defers by one
    // microtask tick, so the actual fetch() for /lab/agents isn't registered until
    // after that tick flushes, not synchronously within this same call.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The /lab/agents POST must be the first call made.
    assert.equal(calls.length, 1, "attackCreateMission must issue exactly one call before awaiting the agent response");
    assert.match(calls[0]!.url, /^\/lab\/agents$/);
    const agentBody = JSON.parse(calls[0]!.init.body!);
    const tokenExpiresAt = agentBody.caveats.expiresAt;

    // A genuine, real delay — not a synchronously-resolved promise — so real
    // wall-clock time actually elapses between the two Date.now() calls in
    // attackCreateMission(), exactly like a real network round-trip would.
    await new Promise((resolve) => setTimeout(resolve, 50));

    calls[0]!.resolve(fakeJsonResponse({ agentId: "lab-agent-test", token: "fake-token" }));

    // Let the resolved promise's continuation (the mission POST) actually run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 2, "the /lab/missions POST must follow, after the real delay above");
    assert.match(calls[1]!.url, /^\/lab\/missions$/);
    const missionBody = JSON.parse(calls[1]!.init.body!);
    const missionExpiresAt = missionBody.expiresAt;

    calls[1]!.resolve(fakeJsonResponse({ missionId: missionBody.missionId }));
    await run;

    assert.ok(
      new Date(missionExpiresAt).getTime() <= new Date(tokenExpiresAt).getTime(),
      `mission.expiresAt (${missionExpiresAt}) must not be later than the token's expiresAt (${tokenExpiresAt}), ` +
        `even after a real delay between the two calls that produced them`
    );

    // The UI must reflect success, not the "Failed to create attack mission: Mission
    // error: mission expiresAt (...) is later than the agent token's expiresAt (...)"
    // regression this test exists to catch.
    const infoText = elementsById.get("attackMissionInfo")!.textContent;
    assert.match(infoText, /ready/i);
    assert.doesNotMatch(infoText, /Failed to create attack mission/);
    assert.doesNotMatch(infoText, /Mission error/);
  });

  test("the token's expiresAt is far longer than the mission's — the same 365-day-token/24-hour-mission convention already used by loadDemoScenario() and the revocation scenario elsewhere in this file", async () => {
    const { calls, attackCreateMission } = loadAttackCreateMissionContext();

    const run = attackCreateMission();
    await new Promise((resolve) => setTimeout(resolve, 0)); // see the timing note in the test above
    const agentBody = JSON.parse(calls[0]!.init.body!);
    calls[0]!.resolve(fakeJsonResponse({ agentId: "lab-agent-test", token: "fake-token" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const missionBody = JSON.parse(calls[1]!.init.body!);
    calls[1]!.resolve(fakeJsonResponse({ missionId: missionBody.missionId }));
    await run;

    const tokenDurationMs = new Date(agentBody.caveats.expiresAt).getTime() - Date.now();
    const missionDurationMs = new Date(missionBody.expiresAt).getTime() - Date.now();

    // Generous bounds (not exact-millisecond equality, since Date.now() is read
    // independently at each call site) proving the token's duration is on the order
    // of a year and the mission's is on the order of a day — not the same duration
    // the original bug used for both.
    assert.ok(tokenDurationMs > 300 * 24 * 60 * 60 * 1000, "token expiry should be on the order of a year");
    assert.ok(missionDurationMs < 2 * 24 * 60 * 60 * 1000, "mission expiry should be on the order of a day");
    assert.ok(tokenDurationMs > missionDurationMs, "the token must outlive the mission");
  });
});

describe("Scenario A — launchBudgetAttack()'s final counters and verification text are derived from real responses, never hardcoded", () => {
  test("an UNUSUAL allow/deny split (3 allowed, 17 blocked — NOT the naturally-expected 13/7) is reflected exactly in the rendered counters, and the final verification text comes from the real /missions/:id response, not client math", async () => {
    const { elementsById, calls, launchBudgetAttack } = loadAttackTheatreContext();

    const run = launchBudgetAttack();

    // All 20 attempts must have reached their fetch call synchronously (Array.from's
    // mapping callback invokes each async fireOne() immediately, and each runs up to
    // its own `await fetch(...)` before Array.from finishes) — see
    // dashboard-request-race.test.ts for the same, already-proven synchronous-
    // registration property this relies on.
    assert.equal(calls.length, 20, "all 20 attempts must reach the fetch call before any of them resolves");
    for (const call of calls) assert.match(call.url, /^\/lab\/transactions$/);

    // Resolve with a DELIBERATELY unusual split — 3 allowed, 17 denied — chosen
    // specifically because it is NOT what a naive "budget / amount" calculation would
    // predict (that would be 13/7), so a rendering implementation that hardcoded an
    // expected split rather than reading each real response could not pass this.
    for (let i = 0; i < calls.length; i++) {
      const allow = i < 3;
      calls[i]!.resolve(
        fakeJsonResponse({
          agentId: "agent-x",
          decision: { verdict: allow ? "allow" : "deny", reason: allow ? "ok" : "would exceed budget" },
          execution: allow ? { success: true, rail: "mock_x402", reference: `ref-${i}` } : undefined,
        })
      );
    }

    // The one remaining call is the final GET /missions/:id verification — resolve it
    // with a server-reported state matching the 3 allowed attempts (3 x $380 = $1140,
    // matching the fixed catalog price launchBudgetAttack() now hardcodes), and confirm
    // the rendered "server-confirmed" text uses THIS value, not a client-computed one.
    await new Promise((r) => setTimeout(r, 0)); // let the Promise.all settle and the next fetch register
    assert.equal(calls.length, 21, "exactly one more call — the mission verification GET — must follow the 20 attempts");
    assert.match(calls[20]!.url, /^\/lab\/missions\/attack-test-1$/);
    calls[20]!.resolve(
      fakeJsonResponse({
        missionId: "attack-test-1",
        budgetMinorUnits: 200_000,
        spentMinorUnits: 114_000,
        remainingMinorUnits: 86_000,
        currency: "USD",
      })
    );

    await run;

    assert.equal(elementsById.get("attackStatAttempts")!.textContent, "20");
    assert.equal(elementsById.get("attackStatAllowed")!.textContent, "3", "must reflect the actual 3-allowed responses, not a hardcoded 13");
    assert.equal(elementsById.get("attackStatBlocked")!.textContent, "17", "must reflect the actual 17-denied responses, not a hardcoded 7");
    assert.equal(elementsById.get("attackStatSpend")!.textContent, "1140.00 USD");
    const verifiedText = elementsById.get("attackVerified")!.textContent;
    assert.match(verifiedText, /1140\.00 USD/, "the server-confirmed spend must come from the real /missions/:id response body");
    assert.match(verifiedText, /overspend 0\.00 USD/i, "no overspend, confirmed against the real server-reported state");
  });

  test("a call that errors (network failure) counts as blocked, never silently as allowed", async () => {
    const { elementsById, calls, launchBudgetAttack } = loadAttackTheatreContext();
    const run = launchBudgetAttack();
    assert.equal(calls.length, 20);

    calls[0]!.resolve(fakeJsonResponse({ error: "simulated failure" }, false, 500));
    for (let i = 1; i < 20; i++) {
      calls[i]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "no" } }));
    }
    await new Promise((r) => setTimeout(r, 0));
    calls[20]!.resolve(fakeJsonResponse({ missionId: "attack-test-1", budgetMinorUnits: 200_000, spentMinorUnits: 0, remainingMinorUnits: 200_000, currency: "USD" }));

    await run;
    assert.equal(elementsById.get("attackStatAllowed")!.textContent, "0");
    assert.equal(elementsById.get("attackStatBlocked")!.textContent, "20", "the errored attempt must count as blocked, not silently dropped or counted as allowed");
  });

  test("a decision-layer allow whose rail execution then fails counts toward 'allowed' but NOT toward 'spend' — matching computeMissionSpent's own settlement-only accounting", async () => {
    const { elementsById, calls, launchBudgetAttack } = loadAttackTheatreContext();
    const run = launchBudgetAttack();
    assert.equal(calls.length, 20);

    // Every attempt is authorized by the decision layer (verdict: allow), but the rail
    // itself fails on 5 of them (execution.success: false) — this is exactly the shape
    // a wrong-rail or price-mismatch bug would have produced. computeMissionSpent only
    // ever counts a genuine settlement, so the rendered "spend" stat must match that,
    // not the raw allow count.
    for (let i = 0; i < calls.length; i++) {
      const settles = i < 15;
      calls[i]!.resolve(
        fakeJsonResponse({
          agentId: "agent-x",
          decision: { verdict: "allow", reason: "ok" },
          execution: settles ? { success: true, rail: "mock_x402", reference: `ref-${i}` } : { success: false, rail: "mock_x402", error: "quote mismatch" },
        })
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    calls[20]!.resolve(
      fakeJsonResponse({ missionId: "attack-test-1", budgetMinorUnits: 200_000, spentMinorUnits: 15 * 38_000, remainingMinorUnits: 200_000 - 15 * 38_000, currency: "USD" })
    );

    await run;
    assert.equal(elementsById.get("attackStatAllowed")!.textContent, "20", "every response was decision-layer 'allow'");
    assert.equal(elementsById.get("attackStatSpend")!.textContent, "5700.00 USD", "spend must reflect only the 15 that genuinely settled (15 x $380), not all 20 allows");
  });
});

// ---------- Block 3A: attack theatre pipeline trace ----------

const TX_INPUT = { amountMinorUnits: 38_000, currency: "USD", category: "flights", counterparty: "acme-airlines" };

function stageCount(stages: unknown[]): number {
  // Stages and arrows alternate; every real stage is at an even index (0, 2, 4, ...).
  return Math.ceil(stages.length / 2);
}

describe("buildAttackTraceStages() — stops exactly at the real failing stage, never fabricates a later one", () => {
  test("no record at all (nothing to trace) renders only the attack-attempt stage", () => {
    const { context } = loadContext();
    const stages = context.buildAttackTraceStages(null, TX_INPUT);
    assert.equal(stageCount(stages), 1);
  });

  test("a request-level error (network/500 failure) stops after the request stage", () => {
    const { context } = loadContext();
    const record = { ok: false, error: "HTTP 500" };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    assert.equal(stageCount(stages), 2);
    assert.match((stages[2] as FakeElement).className, /stage-deny/);
  });

  test("a mission-gate denial (decision.source === 'mission') stops after ONE stage — capability, risk, decision, and execution genuinely never ran", () => {
    const { context } = loadContext();
    const record = { ok: true, response: { decision: { verdict: "deny", reason: "Transaction would exceed this mission's budget", source: "mission" } } };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    assert.equal(stageCount(stages), 2, "attack-attempt stage + mission-gate stage only");
    assert.match((stages[2] as FakeElement).className, /stage-deny/);
    const texts: string[] = [];
    walk(stages[2] as FakeElement, [], texts);
    assert.ok(texts.some((t) => t.includes("exceed this mission's budget")));
  });

  test("a capability/policy denial (mission gate passed, policy.allowed === false) stops after THREE stages — risk, decision, and execution genuinely never ran", () => {
    const { context } = loadContext();
    const record = {
      ok: true,
      response: { decision: { verdict: "deny", reason: "Failed capability check", policy: { allowed: false, reason: "Failed capability check" } } },
    };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    assert.equal(stageCount(stages), 3, "attack + mission-gate(allow) + capability(deny)");
    assert.match((stages[4] as FakeElement).className, /stage-deny/);
  });

  test("a risk-driven decision denial (policy allowed, but the composite decision is deny) stops after DECISION — execution genuinely never ran", () => {
    const { context } = loadContext();
    const record = {
      ok: true,
      response: {
        decision: {
          verdict: "deny",
          reason: "Inconsistent with delegated goal",
          policy: { allowed: true },
          risk: { intentJudgment: { verdict: "inconsistent" }, baselineFlags: [] },
        },
      },
    };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    // attack + mission-gate(allow) + capability(allow) + risk(escalate-colored) + decision(deny) = 5 stages
    assert.equal(stageCount(stages), 5);
    assert.match((stages[8] as FakeElement).className, /stage-deny/);
  });

  test("an escalate verdict stops after DECISION — execution genuinely never ran (escalate is not allow)", () => {
    const { context } = loadContext();
    const record = {
      ok: true,
      response: {
        decision: {
          verdict: "escalate",
          reason: "Behavioral anomaly detected",
          policy: { allowed: true },
          risk: { intentJudgment: { verdict: "consistent" }, baselineFlags: [{ code: "high_rate", detail: "5 in 60s" }] },
        },
      },
    };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    assert.equal(stageCount(stages), 5);
    assert.match((stages[8] as FakeElement).className, /stage-escalate/);
  });

  test("an allow verdict whose rail execution then FAILS stops after EXECUTION — ledger-settlement stage is not shown as if it happened", () => {
    const { context } = loadContext();
    const record = {
      ok: true,
      response: {
        decision: { verdict: "allow", reason: "ok", policy: { allowed: true }, risk: { intentJudgment: { verdict: "consistent" }, baselineFlags: [] } },
        execution: { success: false, rail: "mock_x402", error: "quoted amount mismatch" },
      },
    };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    // attack + mission-gate + capability + risk + decision + execution(deny) = 6
    assert.equal(stageCount(stages), 6);
    assert.match((stages[10] as FakeElement).className, /stage-deny/);
  });

  test("a full success (allow + settled execution) reaches all the way to LEDGER", () => {
    const { context } = loadContext();
    const record = {
      ok: true,
      response: {
        decision: { verdict: "allow", reason: "ok", policy: { allowed: true }, risk: { intentJudgment: { verdict: "consistent" }, baselineFlags: [] } },
        execution: { success: true, rail: "mock_x402", reference: "ref-123" },
      },
    };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    // attack + mission-gate + capability + risk + decision + execution + ledger = 7
    assert.equal(stageCount(stages), 7);
    assert.match((stages[12] as FakeElement).className, /stage-allow/);
    const texts: string[] = [];
    walk(stages[12] as FakeElement, [], texts);
    assert.ok(texts.some((t) => t.toLowerCase().includes("recorded")));
  });
});

describe("pickRepresentativeAttempt() — prefers a genuinely blocked attempt, never fabricates one", () => {
  test("when both allowed and blocked records exist, a blocked one is preferred", () => {
    const { context } = loadContext();
    const allowed = { ok: true, response: { decision: { verdict: "allow", reason: "ok" } } };
    const blocked = { ok: true, response: { decision: { verdict: "deny", reason: "no", source: "mission" } } };
    const picked = context.pickRepresentativeAttempt([allowed, null, blocked, allowed]);
    assert.equal(picked, blocked);
  });

  test("a request-level error counts as a genuine stop and is preferred over an allowed record", () => {
    const { context } = loadContext();
    const allowed = { ok: true, response: { decision: { verdict: "allow", reason: "ok" } } };
    const errored = { ok: false, error: "network failure" };
    const picked = context.pickRepresentativeAttempt([allowed, errored]);
    assert.equal(picked, errored);
  });

  test("when nothing was blocked, falls back to a real allowed record rather than returning nothing", () => {
    const { context } = loadContext();
    const allowed = { ok: true, response: { decision: { verdict: "allow", reason: "ok" } } };
    const picked = context.pickRepresentativeAttempt([allowed]);
    assert.equal(picked, allowed);
  });

  test("an all-null/empty attempt list picks nothing, rather than crashing or fabricating a record", () => {
    const { context } = loadContext();
    assert.equal(context.pickRepresentativeAttempt([null, null]), null);
  });
});

describe("attack-theatre trace — script-shaped real response fields never become DOM markup", () => {
  test("a script-shaped mission-gate denial reason renders as inert text only", () => {
    const { context } = loadContext();
    const payload = "<script>window.__xss_fired=30</script>";
    const record = { ok: true, response: { decision: { verdict: "deny", reason: payload, source: "mission" } } };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    const tags: string[] = [];
    const texts: string[] = [];
    for (const s of stages) walk(s as FakeElement, tags, texts);
    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });

  test("a script-shaped execution.error and execution.reference render as inert text only", () => {
    const { context } = loadContext();
    const errorPayload = "<img src=x onerror=alert(31)>";
    const refPayload = "<svg onload=alert(32)>";
    const record = {
      ok: true,
      response: {
        decision: { verdict: "allow", reason: "ok", policy: { allowed: true }, risk: { intentJudgment: { verdict: "consistent" }, baselineFlags: [] } },
        execution: { success: false, rail: "mock_x402", error: errorPayload },
      },
    };
    const stages = context.buildAttackTraceStages(record, TX_INPUT);
    const tags: string[] = [];
    const texts: string[] = [];
    for (const s of stages) walk(s as FakeElement, tags, texts);
    assert.ok(!tags.includes("img"));
    assert.ok(texts.some((t) => t.includes(errorPayload)));

    const settledRecord = {
      ok: true,
      response: {
        decision: { verdict: "allow", reason: "ok", policy: { allowed: true }, risk: { intentJudgment: { verdict: "consistent" }, baselineFlags: [] } },
        execution: { success: true, rail: "mock_x402", reference: refPayload },
      },
    };
    const settledStages = context.buildAttackTraceStages(settledRecord, TX_INPUT);
    const tags2: string[] = [];
    const texts2: string[] = [];
    for (const s of settledStages) walk(s as FakeElement, tags2, texts2);
    assert.ok(!tags2.includes("svg"));
    assert.ok(texts2.some((t) => t.includes(refPayload)));
  });

  test("a script-shaped counterparty/category in the attack-attempt stage's own input renders as inert text only", () => {
    const { context } = loadContext();
    const payload = "<script>window.__xss_fired=33</script>";
    const stages = context.buildAttackTraceStages(null, { amountMinorUnits: 1000, currency: "USD", category: payload, counterparty: "acme" });
    const tags: string[] = [];
    const texts: string[] = [];
    for (const s of stages) walk(s as FakeElement, tags, texts);
    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });
});

describe("renderAttackTrace() wired into a real launchBudgetAttack() run — reflects the actual representative attempt, never a hardcoded one", () => {
  test("an unusual split with a specific mission-gate denial among the responses is exactly what appears in #attackTrace, not a different/generic denial", async () => {
    const { elementsById, calls, launchBudgetAttack } = loadAttackTheatreContext();
    const run = launchBudgetAttack();
    assert.equal(calls.length, 20);

    const distinctiveReason = "UNUSUAL-TEST-REASON: exceeds mission cap by exactly this much";
    for (let i = 0; i < calls.length; i++) {
      if (i === 0) {
        calls[i]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: distinctiveReason, source: "mission" } }));
      } else if (i < 5) {
        calls[i]!.resolve(
          fakeJsonResponse({
            agentId: "agent-x",
            decision: { verdict: "allow", reason: "ok", policy: { allowed: true }, risk: { intentJudgment: { verdict: "consistent" }, baselineFlags: [] } },
            execution: { success: true, rail: "mock_x402", reference: `ref-${i}` },
          })
        );
      } else {
        calls[i]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "budget exceeded", source: "mission" } }));
      }
    }
    await new Promise((r) => setTimeout(r, 0));
    calls[20]!.resolve(fakeJsonResponse({ missionId: "attack-test-1", budgetMinorUnits: 200_000, spentMinorUnits: 4 * 38_000, remainingMinorUnits: 200_000 - 4 * 38_000, currency: "USD" }));
    await run;

    // pickRepresentativeAttempt() finds the FIRST blocked record in array order — that's
    // attempt #1 (index 0), which carries the distinctive reason text, not the generic
    // "budget exceeded" text every later denial shares. If the trace were hardcoded or
    // picked the wrong attempt, this exact string would not appear.
    const traceText = elementsById.get("attackTrace")!.textContent;
    assert.ok(traceText.includes(distinctiveReason), "the trace must reflect the actual first-blocked attempt's own real reason text");
  });
});
