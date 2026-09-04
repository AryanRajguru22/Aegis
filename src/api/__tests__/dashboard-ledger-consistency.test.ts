import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Root-cause regression coverage for the real, observed bug: header claiming "Ledger
 * tampered" while Evidence simultaneously claimed "HASH CHAIN VERIFIED", with "Verify
 * chain" surfacing a raw "Invalid API key" error. See public/app.js's "ledger — single
 * source of truth" section (verifyProductionLedger/renderProductionLedgerStatus) for
 * the fix this proves: exactly one fetch, exactly one state object
 * (state.prodLedger), exactly one render pass that paints every display consistently.
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

// Mirrors dashboard-attack-theatre.test.ts's own makeFakeElement exactly — every
// dashboard test file in this project builds its own self-contained fake DOM, sized
// to load the WHOLE of app.js (which registers many addEventListener/value/append
// calls at the top level, for elements unrelated to what a given test actually
// exercises) without throwing.
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
      this._text = "";
      this.childNodes = [];
    },
    setAttribute() {},
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

const TRACKED_IDS = [
  "shellStatus",
  "shellStatusText",
  "ovLedger",
  "chainStatus",
  "integrityStatus",
  "integrityExplain",
  "ledgerEntries",
  "attackMissionInfo",
];

function loadLedgerContext(fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  for (const id of TRACKED_IDS) elementsById.set(id, makeFakeElement("div"));

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
    fetch: fetchImpl,
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  // state.apiKey is a top-level `let state` binding — set here, appended to the same
  // source evaluation, the same technique dashboard-attack-theatre.test.ts already
  // uses for attackMissionId/attackAgentId.
  vm.runInContext(`${src}\nstate.apiKey = "real-principal-key";`, context, { filename: "app.js" });

  return {
    elementsById,
    verifyProductionLedger: (context as unknown as { verifyProductionLedger: () => Promise<unknown> }).verifyProductionLedger,
    renderOverview: (context as unknown as { renderOverview: () => void }).renderOverview,
  };
}

function fakeJsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => body });
}

function allRenderedText(elementsById: Map<string, FakeElement>): string {
  return TRACKED_IDS.map((id) => elementsById.get(id)!.textContent).join(" | ");
}

describe("production ledger integrity — a single verified result appears consistently everywhere", () => {
  test("header, Overview, and Evidence all show VERIFIED language after one successful check — never a mix", async () => {
    const { elementsById, verifyProductionLedger } = loadLedgerContext(() =>
      fakeJsonResponse({ entries: [{ seq: 1, kind: "agent_registered", createdAt: new Date().toISOString(), contentHash: "a", prevHash: "b" }], chainValid: true, brokenAtSeq: null, reason: null })
    );

    await verifyProductionLedger();

    assert.match(elementsById.get("shellStatusText")!.textContent, /Ledger verified/);
    assert.equal(elementsById.get("shellStatus")!.className, "shellStatus verified");
    assert.equal(elementsById.get("ovLedger")!.textContent, "Verified");
    assert.match(elementsById.get("chainStatus")!.textContent, /Verified/);
    assert.match(elementsById.get("integrityStatus")!.textContent, /HASH CHAIN VERIFIED/);
    assert.ok(!allRenderedText(elementsById).match(/tamper/i), "no display may say 'tampered' when the ledger is genuinely verified");
  });
});

describe("production ledger integrity — a single tampered result appears consistently everywhere", () => {
  test("header, Overview, and Evidence all show TAMPERED language after one failed check — never a mix, and the failing entry is named", async () => {
    const { elementsById, verifyProductionLedger } = loadLedgerContext(() =>
      fakeJsonResponse({ entries: [{ seq: 3, kind: "decision", createdAt: new Date().toISOString(), contentHash: "a", prevHash: "b" }], chainValid: false, brokenAtSeq: 3, reason: "content hash mismatch" })
    );

    await verifyProductionLedger();

    assert.match(elementsById.get("shellStatusText")!.textContent, /integrity violation/i);
    assert.equal(elementsById.get("shellStatus")!.className, "shellStatus tampered");
    assert.equal(elementsById.get("ovLedger")!.textContent, "Tampered");
    assert.match(elementsById.get("chainStatus")!.textContent, /TAMPERED/);
    assert.match(elementsById.get("chainStatus")!.textContent, /#3/, "the specific failing entry must be named, not just a bare failure");
    assert.match(elementsById.get("integrityStatus")!.textContent, /INTEGRITY VIOLATION DETECTED/);
    assert.match(elementsById.get("integrityExplain")!.textContent, /content hash mismatch/);
    assert.ok(!allRenderedText(elementsById).match(/HASH CHAIN VERIFIED|✓ Verified/), "no display may claim verified when the ledger is genuinely tampered");
  });
});

describe("an auth/network failure is NEVER displayed as 'tampered', and never leaks the raw server error", () => {
  test("a 401 'Invalid API key' response renders as a neutral error state everywhere — never red/tampered, and the raw string never appears in the DOM", async () => {
    const { elementsById, verifyProductionLedger } = loadLedgerContext(() => fakeJsonResponse({ error: "Invalid API key" }, false, 401));

    await verifyProductionLedger();

    assert.equal(elementsById.get("shellStatus")!.className, "shellStatus error");
    assert.notEqual(elementsById.get("shellStatus")!.className, "shellStatus tampered");
    assert.equal(elementsById.get("ovLedger")!.textContent, "Unknown");
    assert.notEqual(elementsById.get("ovLedger")!.className, "factValue deny", "an error must not paint the same red/deny color a genuine tamper detection uses");
    assert.match(elementsById.get("integrityStatus")!.textContent, /sign.?in/i);
    assert.equal(elementsById.get("integrityStatus")!.className, "integrityBig checking");

    const allText = allRenderedText(elementsById);
    assert.ok(!allText.includes("Invalid API key"), "the raw server error string must never reach the rendered DOM");
    assert.ok(!allText.match(/tamper/i), "an error state must never render as if it were a tamper finding");
  });

  test("a network-level failure (fetch rejects) also renders as error, never tampered", async () => {
    const { elementsById, verifyProductionLedger } = loadLedgerContext(() => Promise.reject(new Error("ECONNREFUSED — internal network detail")));

    await verifyProductionLedger();

    assert.equal(elementsById.get("shellStatus")!.className, "shellStatus error");
    const allText = allRenderedText(elementsById);
    assert.ok(!allText.includes("ECONNREFUSED"), "no internal network error detail may leak into the UI");
    assert.ok(!allText.match(/tamper/i));
  });
});

describe("Overview no longer has its own, independent source for ledger status — it only reflects what verifyProductionLedger() already established", () => {
  test("calling renderOverview() after a verified check does not change or contradict #ovLedger", async () => {
    const { elementsById, verifyProductionLedger, renderOverview } = loadLedgerContext(() =>
      fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null })
    );
    await verifyProductionLedger();
    assert.equal(elementsById.get("ovLedger")!.textContent, "Verified");

    renderOverview();

    assert.equal(elementsById.get("ovLedger")!.textContent, "Verified", "renderOverview() must never overwrite ledger status with a second, independently-derived value");
  });

  test("calling renderOverview() BEFORE any ledger check leaves #ovLedger at its neutral default — never a guessed verified/tampered claim", async () => {
    const { elementsById, renderOverview } = loadLedgerContext(() => fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null }));
    renderOverview();
    const text = elementsById.get("ovLedger")!.textContent;
    assert.ok(text === "" || text === "—", `expected a neutral default, got ${JSON.stringify(text)}`);
  });
});

describe("a fresh re-check after a tampered result correctly flips back to verified if the underlying ledger genuinely changes — no stale success/failure sticks around", () => {
  test("two consecutive verifyProductionLedger() calls with different server responses produce different, correctly-updated displays each time", async () => {
    let call = 0;
    const responses = [
      () => fakeJsonResponse({ entries: [], chainValid: false, brokenAtSeq: 1, reason: "signature mismatch" }),
      () => fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null }),
    ];
    const { elementsById, verifyProductionLedger } = loadLedgerContext(() => responses[call++]!());

    await verifyProductionLedger();
    assert.equal(elementsById.get("ovLedger")!.textContent, "Tampered");

    await verifyProductionLedger();
    assert.equal(elementsById.get("ovLedger")!.textContent, "Verified", "a later, genuinely different result must fully replace the earlier one everywhere, not linger");
  });
});
