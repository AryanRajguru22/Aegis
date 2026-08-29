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
  // set directly here.
  vm.runInContext(
    `${src}\nstate.activeAgentId = "agent-x";\nattackMissionId = "attack-test-1";\nattackAgentId = "agent-x";`,
    context,
    { filename: "app.js" }
  );

  return {
    elementsById,
    calls,
    launchBudgetAttack: (context as unknown as { launchBudgetAttack: () => Promise<void> }).launchBudgetAttack,
  };
}

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
    for (const call of calls) assert.match(call.url, /^\/transactions$/);

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
    assert.match(calls[20]!.url, /^\/missions\/attack-test-1$/);
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
