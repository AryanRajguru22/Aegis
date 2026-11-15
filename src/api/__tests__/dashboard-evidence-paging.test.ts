import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * The Evidence workspace used to render every ledger entry into the DOM at once. It now
 * pages (newest first), filters by event type, expands any entry to its full recorded
 * data, and fetches a bounded window while still reporting the TRUE total and the
 * whole-chain integrity result. These tests run public/app.js in a node:vm sandbox with
 * a minimal fake DOM, like the other dashboard suites.
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
  fire(type: string): void;
}

function makeFakeElement(tag: string): FakeElement {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
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
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  } as FakeElement;
}

function load(fetchImpl: (url: string) => Promise<unknown>) {
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
    fetch: fetchImpl,
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  vm.runInContext(`${src}\nstate.apiKey = "real-principal-key";`, context, { filename: "app.js" });
  return {
    elementsById,
    verifyProductionLedger: (context as unknown as { verifyProductionLedger: () => Promise<unknown> }).verifyProductionLedger,
  };
}

const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

function makeEntries(n: number, kindOf: (i: number) => string = (i) => (i % 3 === 0 ? "decision" : "policy_verdict")) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return { seq: i, kind: kindOf(i), agentId: "a", principalId: "p", data: { i }, createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), prevHash: `p${i}`, contentHash: `h${i}`, signature: `s${i}` };
  });
}

function rowKinds(listEl: FakeElement): string[] {
  return listEl.childNodes.map((row) => {
    const top = (row as FakeElement).childNodes[0] as FakeElement;
    return (top.childNodes[0] as FakeElement).textContent; // "#seq kind"
  });
}

function findByTag(node: FakeElement, tag: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const c of node.childNodes) {
    if ("nodeType" in c) continue;
    if (c.tagName === tag) out.push(c);
    out.push(...findByTag(c, tag));
  }
  return out;
}

describe("Evidence workspace — paging", () => {
  test("renders newest-first, 50 at a time, and 'Show older entries' reveals the rest until none remain", async () => {
    const entries = makeEntries(120);
    const { elementsById, verifyProductionLedger } = load(() => json({ entries, chainValid: true, brokenAtSeq: null, reason: null }));
    await verifyProductionLedger();

    const list = elementsById.get("ledgerEntries")!;
    const more = elementsById.get("ledgerMoreBtn")!;
    assert.equal(list.childNodes.length, 50);
    assert.match(rowKinds(list)[0]!, /^#120 /, "newest first");
    assert.match(elementsById.get("ledgerCount")!.textContent, /Showing 50 of 120/);
    assert.notEqual(more.style.display, "none");

    more.fire("click");
    assert.equal(list.childNodes.length, 100);
    assert.notEqual(more.style.display, "none");

    more.fire("click");
    assert.equal(list.childNodes.length, 120, "every entry is reachable — nothing is hidden, only deferred");
    assert.match(rowKinds(list).at(-1)!, /^#1 /);
    assert.equal(more.style.display, "none");
  });

  test("the fetch is bounded, and the header/status report the TRUE total (page.total) and the whole-chain verdict", async () => {
    let requestedUrl = "";
    const { elementsById, verifyProductionLedger } = load((url) => {
      requestedUrl = url;
      return json({ entries: makeEntries(500), chainValid: true, brokenAtSeq: null, reason: null, page: { limit: 500, total: 1234, hasMore: true, nextBeforeSeq: 1 } });
    });
    await verifyProductionLedger();
    assert.match(requestedUrl, /^\/ledger\?limit=500$/);
    assert.match(elementsById.get("shellStatusText")!.textContent, /Ledger verified · 1234/);
    assert.match(elementsById.get("chainStatus")!.textContent, /1234 entries/);
    assert.match(elementsById.get("ledgerCount")!.textContent, /Loaded the newest 500 of 1234 total entries; integrity covers all 1234/);
  });

  test("without a page object (older server / fixtures) the entry count falls back to entries.length", async () => {
    const { elementsById, verifyProductionLedger } = load(() => json({ entries: makeEntries(7), chainValid: true, brokenAtSeq: null, reason: null }));
    await verifyProductionLedger();
    assert.match(elementsById.get("shellStatusText")!.textContent, /Ledger verified · 7/);
  });
});

describe("Evidence workspace — filtering", () => {
  test("choosing an event type shows only that type, resets paging, and 'All' restores everything", async () => {
    const entries = makeEntries(200); // every 3rd is "decision"
    const { elementsById, verifyProductionLedger } = load(() => json({ entries, chainValid: true, brokenAtSeq: null, reason: null }));
    await verifyProductionLedger();
    const list = elementsById.get("ledgerEntries")!;
    const select = elementsById.get("ledgerKindFilter")!;
    const more = elementsById.get("ledgerMoreBtn")!;

    more.fire("click"); // page forward first, so we can prove the filter resets it
    assert.equal(list.childNodes.length, 100);

    select.value = "decision";
    select.fire("change");
    const decisions = entries.filter((e) => e.kind === "decision").length;
    assert.equal(list.childNodes.length, Math.min(50, decisions));
    assert.ok(rowKinds(list).every((r) => r.endsWith(" decision")));
    assert.match(elementsById.get("ledgerCount")!.textContent, new RegExp(`of ${decisions} "decision" entries`));

    select.value = "";
    select.fire("change");
    assert.equal(list.childNodes.length, 50);
  });

  test("a filter whose kind disappears after a refresh falls back to All instead of showing an empty, misleading list", async () => {
    let entries = makeEntries(10, () => "decision");
    const { elementsById, verifyProductionLedger } = load(() => json({ entries, chainValid: true, brokenAtSeq: null, reason: null }));
    await verifyProductionLedger();
    const select = elementsById.get("ledgerKindFilter")!;
    select.value = "decision";
    select.fire("change");

    entries = makeEntries(4, () => "revocation");
    await verifyProductionLedger();
    assert.equal(elementsById.get("ledgerEntries")!.childNodes.length, 4);
  });
});

describe("Evidence workspace — entry detail and the verifier command", () => {
  test("each entry can be expanded to its recorded data, rendered as text (never markup)", async () => {
    const entries = makeEntries(1);
    (entries[0] as { data: unknown }).data = { note: "<img src=x onerror=alert(1)>", amountMinorUnits: 38000 };
    const { elementsById, verifyProductionLedger } = load(() => json({ entries, chainValid: true, brokenAtSeq: null, reason: null }));
    await verifyProductionLedger();

    const row = elementsById.get("ledgerEntries")!.childNodes[0] as FakeElement;
    const [btn] = findByTag(row, "button");
    const [pre] = findByTag(row, "pre");
    assert.ok(btn && pre);
    assert.equal(pre.style.display, "none");
    assert.equal(btn.textContent, "Show recorded data");

    btn.fire("click");
    assert.equal(pre.style.display, "");
    assert.match(pre.textContent, /"amountMinorUnits": 38000/);
    assert.ok(pre.textContent.includes("<img src=x onerror=alert(1)>"), "shown verbatim as text");
    assert.equal(btn.textContent, "Hide recorded data");

    btn.fire("click");
    assert.equal(pre.style.display, "none");
  });

  test("the independent-verifier panel shows a ready-to-run command embedding the server's PUBLIC key", async () => {
    const pub = "302a300506032b6570032100" + "ab".repeat(32);
    const { elementsById, verifyProductionLedger } = load(() => json({ entries: makeEntries(2), chainValid: true, brokenAtSeq: null, reason: null, ledgerPublicKey: pub }));
    await verifyProductionLedger();
    const text = elementsById.get("verifierCommands")!.textContent;
    assert.ok(text.includes(`exportLedger.js <path-to-aegis.db> ${pub} ledger-export.json`));
    assert.ok(text.includes("node verifier/dist/cli.js ledger-export.json"));
  });
});
