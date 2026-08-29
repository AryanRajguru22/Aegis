import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Adversarial regression tests for the Step 7 fix to the display-layer race condition
 * found during Step 6's real-browser verification: if Simulate/Execute request A is
 * started, then request B is started before A resolves, whichever response arrives
 * LAST used to win the #result panel regardless of which request the user's most
 * recent click actually corresponded to. The fix is a single, shared, monotonically
 * increasing request counter (see public/app.js's `latestResultRequestId`) — every
 * test here exercises the REAL, UNMODIFIED public/app.js source via node:vm against a
 * purpose-built fake DOM capable of actually invoking click handlers and a
 * fetch stub whose responses this test resolves/rejects in an explicitly chosen order
 * — not the lighter-weight fake used by dashboard-xss-regression.test.ts, which never
 * needed to simulate a click or control response ordering.
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
      // Concatenates this node's own text plus every descendant's, matching real DOM
      // textContent semantics closely enough for assertions in these tests.
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
      // Only ever assigned "" (clearing) by app.js's real code — see the static
      // regression guard in dashboard-xss-regression.test.ts. Any non-empty
      // assignment here would indicate a real regression; fail loudly rather than
      // silently approximating parsing.
      if (v !== "") throw new Error(`Unexpected non-empty innerHTML assignment in a race test: ${JSON.stringify(v)}`);
      this._text = "";
      this.childNodes = [];
    },
    setAttribute() {
      /* not needed for these tests */
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
      // Invokes every registered "click" listener. Each listener is app.js's real
      // `async () => {...}` handler — calling it runs synchronously up to its first
      // `await` (the fetch call inside api()) before this method returns, exactly
      // matching real browser event-dispatch semantics for an async handler. The
      // returned Promise resolves once the handler(s) fully complete, including
      // their eventual render — tests choose whether/when to await it.
      const fns = listeners.get("click") ?? [];
      return Promise.all(fns.map((fn) => fn()));
    },
  } as FakeElement;
  return elem;
}

interface DeferredFetchCall {
  url: string;
  resolve: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
}

function fakeJsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function loadRaceTestContext() {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");

  const elementsById = new Map<string, FakeElement>();
  const formFieldIds = ["txAmount", "txCurrency", "txCategory", "txRail", "txCounterparty", "txPurpose", "txMission"];
  for (const id of formFieldIds) elementsById.set(id, makeFakeElement("input"));
  elementsById.get("txAmount")!.value = "380";
  elementsById.get("txCurrency")!.value = "USD";
  elementsById.get("txCategory")!.value = "flights";
  elementsById.get("txRail")!.value = "mock_x402";
  elementsById.get("txCounterparty")!.value = "acme-airlines";
  elementsById.get("txPurpose")!.value = "Round-trip flight for the Q3 vendor conference";
  elementsById.get("txMission")!.value = ""; // no mission selected by default — keeps executeBtn's loadMissions() branch inert for these tests
  elementsById.set("simulateBtn", makeFakeElement("button"));
  elementsById.set("executeBtn", makeFakeElement("button"));
  elementsById.set("result", makeFakeElement("div"));

  const fetchCalls: DeferredFetchCall[] = [];
  const fakeFetch = (url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    return new Promise((resolve) => {
      fetchCalls.push({ url, resolve });
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
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  // `state` is declared with `let`, not `function` — top-level `let`/`const` bindings
  // in a vm context live in the script's lexical global-environment record, which is
  // NOT exposed as a property of the context object to code outside the sandbox (only
  // `var`/function declarations attach to the context object itself). Appending this
  // one-line mutation to the SAME source string, evaluated in the SAME
  // vm.runInContext call, runs it in that same lexical scope, where `state` (and
  // every other top-level `let`/`const`/function) is directly reachable — the
  // supported way to reach in and set it, not a workaround for a bug in app.js.
  vm.runInContext(`${src}\nstate.activeAgentId = "agent-x";`, context, { filename: "app.js" });

  return { elementsById, fetchCalls, resultEl: elementsById.get("result")! };
}

describe("dashboard request race — Step 7 regression: only the LATEST Simulate/Execute request may update #result", () => {
  test("B started after A, B resolves first, A resolves later: only B's result remains visible", async () => {
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const simulateBtn = elementsById.get("simulateBtn")!;
    const counterparty = elementsById.get("txCounterparty")!;

    counterparty.value = "acme-airlines";
    const clickA = simulateBtn.click(); // request A starts
    assert.equal(fetchCalls.length, 1, "request A must have reached the fetch call synchronously");

    counterparty.value = "shady-marketplace";
    const clickB = simulateBtn.click(); // request B starts before A resolves
    assert.equal(fetchCalls.length, 2, "request B must have reached the fetch call synchronously");

    // B resolves first.
    fetchCalls[1]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "B: not approved", source: "mission" } }));
    await clickB;
    assert.match(resultEl.textContent, /B: not approved/, "B's result must render");

    // A resolves later — must NOT overwrite B's already-rendered, more-recent result.
    fetchCalls[0]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "allow", reason: "A: should never be shown" } }));
    await clickA;

    assert.doesNotMatch(resultEl.textContent, /A: should never be shown/, "A's stale result must never overwrite B's");
    assert.match(resultEl.textContent, /B: not approved/, "B's result must still be the one visible after A's stale response arrives");
  });

  test("opposite ordering — A resolves first, B resolves later: B must still be the final displayed result", async () => {
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const simulateBtn = elementsById.get("simulateBtn")!;
    const counterparty = elementsById.get("txCounterparty")!;

    counterparty.value = "acme-airlines";
    const clickA = simulateBtn.click();
    counterparty.value = "shady-marketplace";
    const clickB = simulateBtn.click();
    assert.equal(fetchCalls.length, 2);

    // A resolves first this time — but B's CLICK (not just B's response) already
    // superseded A the moment it started, so A must never render at all, not even
    // transiently, regardless of whether B itself has resolved yet. This is the
    // correct, and stricter, behavior: displaying A's outcome here would show a
    // result that no longer matches the form's current state (which already reflects
    // B's "shady-marketplace" edit).
    fetchCalls[0]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "allow", reason: "A: transient, will be superseded" } }));
    await clickA;
    assert.doesNotMatch(resultEl.textContent, /A: transient, will be superseded/, "A must never render once superseded by B's click, even before B's own response arrives");

    // B resolves later — must become (and remain) the visible result.
    fetchCalls[1]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "B: final correct result", source: "mission" } }));
    await clickB;

    assert.match(resultEl.textContent, /B: final correct result/);
    assert.doesNotMatch(resultEl.textContent, /A: transient, will be superseded/);
  });

  test("stale error: A starts, B starts, B succeeds, A later FAILS — A's error must NOT overwrite B's result", async () => {
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const simulateBtn = elementsById.get("simulateBtn")!;
    const counterparty = elementsById.get("txCounterparty")!;

    counterparty.value = "acme-airlines";
    const clickA = simulateBtn.click();
    counterparty.value = "shady-marketplace";
    const clickB = simulateBtn.click();

    fetchCalls[1]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "B succeeded", source: "mission" } }));
    await clickB;
    assert.match(resultEl.textContent, /B succeeded/);

    // A fails AFTER B already succeeded and rendered.
    fetchCalls[0]!.resolve(fakeJsonResponse({ error: "A: simulated failure, must never be shown" }, false, 500));
    await clickA;

    assert.doesNotMatch(resultEl.textContent, /A: simulated failure/, "a stale error from an outdated request must never overwrite a newer, already-rendered result");
    assert.match(resultEl.textContent, /B succeeded/, "B's result must remain visible");
  });

  test("reverse: B FAILS, A later succeeds — A must NOT overwrite B, because B is the newer request", async () => {
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const simulateBtn = elementsById.get("simulateBtn")!;
    const counterparty = elementsById.get("txCounterparty")!;

    counterparty.value = "acme-airlines";
    const clickA = simulateBtn.click();
    counterparty.value = "shady-marketplace";
    const clickB = simulateBtn.click(); // B is the newer request, even though it will fail

    // B (the newer request) fails.
    fetchCalls[1]!.resolve(fakeJsonResponse({ error: "B: this failure is the correct, current state" }, false, 400));
    await clickB;
    assert.match(resultEl.textContent, /B: this failure is the correct, current state/);

    // A (the OLDER request) succeeds afterward — must still be discarded as stale,
    // even though it "succeeded" and even though B "failed": recency, not outcome, is
    // what the sequencing check is about.
    fetchCalls[0]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "allow", reason: "A: stale success, must never be shown" } }));
    await clickA;

    assert.doesNotMatch(resultEl.textContent, /A: stale success/, "an older request's success must not overwrite a newer request's already-rendered outcome, even a failure");
    assert.match(resultEl.textContent, /B: this failure is the correct, current state/);
  });

  test("the SAME sequencing counter covers Execute racing against Simulate, not just repeated clicks of one button", async () => {
    // Simulate and Execute are two separate click handlers (not literally one shared
    // function), but they write into the same #result panel and share ONE counter
    // (see public/app.js's `latestResultRequestId`) — so a race between the TWO
    // DIFFERENT buttons is resolved by the exact same mechanism as a race between two
    // clicks of the same button, with no separate/duplicated logic needed.
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const simulateBtn = elementsById.get("simulateBtn")!;
    const executeBtn = elementsById.get("executeBtn")!;

    const clickSimulate = simulateBtn.click(); // request A: Simulate
    const clickExecute = executeBtn.click(); // request B: Execute, started immediately after
    assert.equal(fetchCalls.length, 2);

    // The later click (Execute) resolves first.
    fetchCalls[1]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "allow", reason: "Execute result (newer)" }, execution: { success: true, rail: "mock_x402", reference: "ref-1" } }));
    await clickExecute;
    assert.match(resultEl.textContent, /Execute result \(newer\)/);

    // The earlier click (Simulate) resolves after — must not overwrite Execute's result.
    fetchCalls[0]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "Simulate result (stale, must never be shown)" } }));
    await clickSimulate;

    assert.doesNotMatch(resultEl.textContent, /Simulate result \(stale/, "a stale Simulate response must not overwrite a newer Execute response");
    assert.match(resultEl.textContent, /Execute result \(newer\)/);
  });

  test("the Execute path alone: two overlapping Execute clicks resolve out of order — only the newer one is shown", async () => {
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const executeBtn = elementsById.get("executeBtn")!;
    const counterparty = elementsById.get("txCounterparty")!;

    counterparty.value = "acme-airlines";
    const clickA = executeBtn.click();
    counterparty.value = "shady-marketplace";
    const clickB = executeBtn.click();
    assert.equal(fetchCalls.length, 2);

    fetchCalls[1]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "deny", reason: "Execute B (newer)" } }));
    await clickB;
    fetchCalls[0]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "allow", reason: "Execute A (stale)" }, execution: { success: true, rail: "mock_x402", reference: "ref-stale" } }));
    await clickA;

    assert.doesNotMatch(resultEl.textContent, /Execute A \(stale\)/);
    assert.match(resultEl.textContent, /Execute B \(newer\)/);
  });

  test("no false positives: a SINGLE request (no overlap) still renders normally", async () => {
    const { elementsById, fetchCalls, resultEl } = loadRaceTestContext();
    const simulateBtn = elementsById.get("simulateBtn")!;

    const click = simulateBtn.click();
    fetchCalls[0]!.resolve(fakeJsonResponse({ agentId: "agent-x", decision: { verdict: "allow", reason: "solo request, no race" } }));
    await click;

    assert.match(resultEl.textContent, /solo request, no race/);
  });
});
