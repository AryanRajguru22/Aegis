import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * The Operator review panel (Transactions workspace): lists the principal's escalations,
 * pending first, and lets the operator approve or reject each with a mandatory reason.
 * Runs public/app.js in a node:vm sandbox with a minimal fake DOM, like the other
 * dashboard suites. These tests cover the panel's own logic; the backend rules it relies
 * on (authorization, budget, revocation, idempotency) are covered in
 * api-escalation-resolution.test.ts.
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
  attrs: Record<string, string>;
  _text: string;
  textContent: string;
  innerHTML: string;
  value: string;
  setAttribute(name: string, value: string): void;
  appendChild<T extends FakeElement | FakeTextNode>(child: T): T;
  append(...children: Array<FakeElement | FakeTextNode>): void;
  addEventListener(type: string, fn: (...args: unknown[]) => unknown): void;
  fire(type: string): Promise<void>;
}

function makeFakeElement(tag: string): FakeElement {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    tagName: tag,
    childNodes: [],
    className: "",
    style: {},
    attrs: {},
    _text: "",
    value: "",
    get textContent() {
      if (this.childNodes.length === 0) return this._text;
      let out = "";
      const walk = (n: FakeElement | FakeTextNode): void => {
        if ("nodeType" in n) out += n.data;
        else {
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
    set innerHTML(_v: string) {
      this._text = "";
      this.childNodes = [];
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
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
    async fire(type) {
      for (const fn of listeners.get(type) ?? []) await fn();
    },
  } as FakeElement;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function load(opts: { confirmAnswer?: boolean; handler: (call: Call) => { status?: number; body: unknown } }) {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  const calls: Call[] = [];
  const confirms: string[] = [];
  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFakeElement("div"));
      return elementsById.get(id)!;
    },
  };
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, body } = opts.handler(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const context = vm.createContext({
    document: fakeDocument,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchImpl,
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: (m: string) => {
      confirms.push(m);
      return opts.confirmAnswer ?? true;
    },
    alert() {},
  });
  vm.runInContext(`${src}\nstate.apiKey = "real-principal-key";`, context, { filename: "app.js" });
  const g = context as unknown as { loadEscalations: () => Promise<void> };
  return { elementsById, calls, confirms, loadEscalations: g.loadEscalations };
}

function findAll(node: FakeElement, pred: (n: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  for (const c of node.childNodes) {
    if ("nodeType" in c) continue;
    if (pred(c)) out.push(c);
    out.push(...findAll(c, pred));
  }
  return out;
}
const byTag = (node: FakeElement, tag: string) => findAll(node, (n) => n.tagName === tag);
const buttonNamed = (node: FakeElement, text: string) => byTag(node, "button").find((b) => b.textContent === text)!;

function esc(overrides: Record<string, unknown> = {}) {
  return {
    escalationId: "esc_1",
    status: "pending",
    agentId: "agent-root",
    missionId: "mission-1",
    counterparty: "acme-airlines",
    transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "stripe_test", purpose: "Round-trip flight" },
    delegatedGoal: "g",
    escalationReason: "Transaction's consistency with the agent's delegated goal is ambiguous.",
    risk: { intentJudgment: { verdict: "ambiguous", rationale: "cannot tell", provider: "demo" }, baselineFlags: [{ detail: "amount is 4x the recent average" }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedBy: null,
    resolvedAt: null,
    resolutionReason: null,
    outcome: null,
    outcomeDetail: null,
    outcomeAt: null,
    ...overrides,
  };
}

describe("Operator review panel — rendering", () => {
  test("pending escalations come first with the evidence behind them and Approve/Reject controls; resolved ones show who decided, why, and how it ended", async () => {
    const list = [
      esc({ escalationId: "esc_done", status: "approved", resolvedBy: "acme-corp", resolvedAt: "2026-01-02T00:00:00.000Z", resolutionReason: "verified by phone", outcome: "settled", outcomeDetail: { reference: "ref-9" } }),
      esc({ escalationId: "esc_pending" }),
    ];
    const { elementsById, loadEscalations } = load({ handler: () => ({ body: { escalations: list } }) });
    await loadEscalations();
    const container = elementsById.get("escalationList")!;
    assert.equal(container.childNodes.length, 2);
    const first = container.childNodes[0] as FakeElement;
    assert.match(first.textContent, /esc_pending/);
    assert.match(first.textContent, /380\.00 USD/);
    assert.match(first.textContent, /Intent judge \(demo\): ambiguous — cannot tell/);
    assert.match(first.textContent, /Behavioral flag: amount is 4x/);
    assert.ok(buttonNamed(first, "Approve & execute") && buttonNamed(first, "Reject"));
    const second = container.childNodes[1] as FakeElement;
    assert.match(second.textContent, /Approved by acme-corp/);
    assert.match(second.textContent, /verified by phone/);
    assert.match(second.textContent, /Approved and settled \(reference ref-9\)/);
    assert.equal(byTag(second, "button").length, 0, "a resolved escalation has no decision buttons");
    assert.match(elementsById.get("escalationCount")!.textContent, /1 awaiting your decision/);
  });

  test("an indeterminate outcome is stated plainly: not retried, check the rail", async () => {
    const { elementsById, loadEscalations } = load({
      handler: () => ({ body: { escalations: [esc({ status: "approved", resolvedBy: "acme-corp", resolvedAt: "2026-01-02T00:00:00.000Z", resolutionReason: "ok", outcome: "indeterminate" })] } }),
    });
    await loadEscalations();
    assert.match(elementsById.get("escalationList")!.textContent, /could not confirm whether the rail was reached.*NOT retried/);
  });

  test("empty state, and a load failure surfaces a readable message instead of failing silently", async () => {
    const empty = load({ handler: () => ({ body: { escalations: [] } }) });
    await empty.loadEscalations();
    assert.match(empty.elementsById.get("escalationList")!.textContent, /No escalations/);
    assert.equal(empty.elementsById.get("escalationCount")!.textContent, "");

    const failing = load({ handler: () => ({ status: 500, body: { error: "boom" } }) });
    await failing.loadEscalations();
    assert.match(failing.elementsById.get("escalationError")!.textContent, /Could not load escalations: boom/);
  });

  test("agent-supplied text (purpose, judge rationale) is rendered as text, never markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { elementsById, loadEscalations } = load({
      handler: () => ({ body: { escalations: [esc({ transaction: { amountMinorUnits: 100, currency: "USD", category: "flights", rail: "stripe_test", purpose: hostile } })] } }),
    });
    await loadEscalations();
    const text = elementsById.get("escalationList")!.textContent;
    assert.ok(text.includes(hostile), "shown verbatim as text");
  });
});

describe("Operator review panel — deciding", () => {
  test("a decision without a reason is refused locally: no request is sent", async () => {
    const { elementsById, calls, confirms, loadEscalations } = load({ handler: () => ({ body: { escalations: [esc()] } }) });
    await loadEscalations();
    const card = elementsById.get("escalationList")!.childNodes[0] as FakeElement;
    await buttonNamed(card, "Approve & execute").fire("click");
    assert.match(elementsById.get("escalationError")!.textContent, /Enter a reason/);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(confirms.length, 0);
  });

  test("approving asks for confirmation first; declining the confirmation sends nothing", async () => {
    const { elementsById, calls, confirms, loadEscalations } = load({ confirmAnswer: false, handler: () => ({ body: { escalations: [esc()] } }) });
    await loadEscalations();
    const card = elementsById.get("escalationList")!.childNodes[0] as FakeElement;
    byTag(card, "input")[0]!.value = "checked with the traveller";
    await buttonNamed(card, "Approve & execute").fire("click");
    assert.equal(confirms.length, 1);
    assert.match(confirms[0]!, /EXECUTE 380\.00 USD to "acme-airlines"/);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  test("a confirmed approval POSTs the reason to the approve endpoint, then reloads the list", async () => {
    let resolved = false;
    const { elementsById, calls, loadEscalations } = load({
      handler: (call) => {
        if (call.method === "POST") {
          resolved = true;
          return { body: { escalation: esc({ status: "approved" }) } };
        }
        if (call.url === "/escalations") return { body: { escalations: [resolved ? esc({ status: "approved", resolvedBy: "acme-corp", resolvedAt: "2026-01-02T00:00:00.000Z", resolutionReason: "checked", outcome: "settled" }) : esc()] } };
        return { body: { missions: [] } };
      },
    });
    await loadEscalations();
    const card = elementsById.get("escalationList")!.childNodes[0] as FakeElement;
    byTag(card, "input")[0]!.value = "  checked with the traveller  ";
    await buttonNamed(card, "Approve & execute").fire("click");
    const post = calls.find((c) => c.method === "POST")!;
    assert.equal(post.url, "/escalations/esc_1/approve");
    assert.deepEqual(post.body, { reason: "checked with the traveller" });
    assert.match(elementsById.get("escalationList")!.textContent, /Approved and settled/);
  });

  test("rejecting POSTs to the reject endpoint", async () => {
    const { elementsById, calls, loadEscalations } = load({ handler: (c) => (c.method === "POST" ? { body: {} } : { body: { escalations: [esc()] } }) });
    await loadEscalations();
    const card = elementsById.get("escalationList")!.childNodes[0] as FakeElement;
    byTag(card, "input")[0]!.value = "not part of the trip";
    await buttonNamed(card, "Reject").fire("click");
    assert.equal(calls.find((c) => c.method === "POST")!.url, "/escalations/esc_1/reject");
  });

  test("when the server refuses (authority revoked, budget exhausted, already decided) its reason is shown verbatim", async () => {
    const { elementsById, loadEscalations } = load({
      handler: (c) => (c.method === "POST" ? { status: 409, body: { error: "Cannot approve: the agent's capability no longer authorizes this transaction — revoked" } } : { body: { escalations: [esc()] } }),
    });
    await loadEscalations();
    const card = elementsById.get("escalationList")!.childNodes[0] as FakeElement;
    byTag(card, "input")[0]!.value = "go";
    await buttonNamed(card, "Approve & execute").fire("click");
    assert.match(elementsById.get("escalationError")!.textContent, /no longer authorizes this transaction — revoked/);
  });
});
