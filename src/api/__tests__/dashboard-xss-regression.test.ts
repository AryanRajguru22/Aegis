import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression tests for the stored-XSS fix in public/app.js's transaction-result
 * rendering (renderDecisionResult / renderError). No browser or DOM test environment
 * (jsdom, Playwright, etc.) is available in this project — confirmed via ToolSearch
 * during the audit that found this bug — so this exercises the REAL, UNMODIFIED
 * public/app.js source directly with node:vm against a minimal DOM stub, rather than
 * reimplementing or approximating its rendering logic. What this proves and doesn't:
 *
 * PROVES: when the actual shipped renderDecisionResult()/renderError() functions are
 * called with a payload shaped like an HTML/script injection (in the intent-judge
 * rationale, a baseline flag detail, the execution rail/error, or a caught error
 * message — i.e. every field named in the audit finding), no DOM element node for a
 * dangerous tag (script/img/svg/etc.) is ever constructed, and the payload text
 * appears verbatim as inert text-node data, not as parsed markup.
 *
 * DOES NOT PROVE: actual browser rendering, CSP behavior, or anything about the
 * dashboard's other functions (agent tree, live feed, ledger view) — those already
 * used .textContent/createTextNode before this fix and are outside its scope. It also
 * does not prove the *real* Anthropic judge would never be tricked into echoing such a
 * payload — that's a separate, unverified question about model behavior; this test
 * assumes a judge (real or scripted) COULD produce such a rationale and proves the
 * rendering layer is safe regardless of whether it does.
 */

const APP_JS_PATH = path.join(import.meta.dirname, "../../../public/app.js");

interface FakeTextNode {
  nodeType: 3;
  data: string;
}
interface FakeElement {
  tagName: string;
  childNodes: Array<FakeElement | FakeTextNode>;
  attributes: Record<string, string>;
  className: string;
  style: Record<string, string>;
  _text: string;
  textContent: string;
  innerHTML: string;
  setAttribute(name: string, value: string): void;
  appendChild<T extends FakeElement | FakeTextNode>(child: T): T;
  append(...children: Array<FakeElement | FakeTextNode>): void;
  addEventListener(): void;
}

/**
 * innerHTML is deliberately NOT a no-op here: it approximates real browser parsing
 * closely enough to make this a genuine differential test rather than a tautology —
 * for every `<tagname` pattern in an assigned string, it synthesizes a child element
 * with that tag name (the same way a real parser would create a DOM node for it). This
 * is what lets the tests below actually distinguish the fixed code (which never
 * assigns dynamic content to innerHTML, so this setter is only ever hit with a literal
 * "") from the vulnerable code this fix replaced (verified manually against the
 * pre-fix implementation before these tests were trusted — see the test file's
 * top comment).
 */
function makeFakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tagName: tag,
    childNodes: [],
    attributes: {},
    className: "",
    style: {},
    _text: "",
    get textContent() {
      return this._text;
    },
    set textContent(v: string) {
      this._text = String(v);
      this.childNodes = []; // matches real DOM semantics: setting textContent clears children
    },
    get innerHTML() {
      return this._text;
    },
    set innerHTML(v: string) {
      this._text = "";
      this.childNodes = [];
      for (const match of String(v).matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)) {
        const tagName = match[1];
        if (tagName) this.childNodes.push(makeFakeElement(tagName.toLowerCase()));
      }
      // and the raw string is what a real parser would also expose as literal text
      // content wherever it wasn't consumed as a tag — approximate that too so a
      // vulnerable assignment's payload is still discoverable as "text" by the walker,
      // exactly like it would be findable in a real rendered page's accessible text.
      this.childNodes.push({ nodeType: 3, data: String(v) });
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    append(...children) {
      for (const c of children) this.childNodes.push(c);
    },
    addEventListener() {},
  } as FakeElement;
  return el;
}

function loadAppJsContext() {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (_id: string) => makeFakeElement("div"),
  };
  const context = vm.createContext({
    document: fakeDocument,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.reject(new Error("not stubbed — this test never triggers a network call")),
    console,
    crypto: { randomUUID: () => "test-uuid" },
  });
  vm.runInContext(src, context, { filename: "app.js" });
  return context as unknown as {
    renderDecisionResult: (container: FakeElement, body: unknown) => void;
    renderError: (container: FakeElement, message: string) => void;
    el: (tag: string, attrs?: Record<string, unknown>, children?: unknown[]) => FakeElement;
  };
}

/** Recursively collects every element tag name and every literal text value (from both direct .textContent assignments and real text nodes) reachable under `node`. */
function walk(node: FakeElement | FakeTextNode, tags: string[], texts: string[]): void {
  if ("nodeType" in node) {
    texts.push(node.data);
    return;
  }
  tags.push(node.tagName);
  if (node.childNodes.length === 0 && node._text) {
    texts.push(node._text);
  }
  for (const child of node.childNodes) walk(child, tags, texts);
}

const DANGEROUS_TAGS = ["script", "img", "svg", "iframe", "object", "embed", "style", "link"];

describe("public/app.js — no innerHTML template-literal interpolation remains (static regression guard)", () => {
  test("the source file contains no innerHTML assignment built from a template literal", () => {
    const src = fs.readFileSync(APP_JS_PATH, "utf8");
    // Every remaining `innerHTML = ` in the fixed file is a literal-empty-string clear
    // (`innerHTML = "";`), never a template literal that could interpolate dynamic
    // content. This is a cheap, structural guard against the exact regression class
    // found in the audit — it does not replace the behavioral tests below, which
    // prove the actual rendering functions are safe even if this check were absent.
    assert.doesNotMatch(src, /innerHTML\s*=\s*`/, 'no `innerHTML = `...`` template-literal assignment may exist in app.js');
    assert.doesNotMatch(src, /\.innerHTML\s*\+=/, "no innerHTML += concatenation may exist in app.js");
  });
});

describe("renderDecisionResult() — HTML/script payloads in judge rationale and execution fields never become DOM markup", () => {
  test("a script/img-shaped intentJudgment.rationale (as a real judge, prompted with attacker purpose text, could plausibly echo) renders as inert text only", () => {
    const { renderDecisionResult, el } = loadAppJsContext();
    const container = el("div");

    const payload = '<img src=x onerror="window.__xss_fired=1">';
    renderDecisionResult(container, {
      decision: {
        verdict: "escalate",
        reason: "flagged for review",
        risk: {
          intentJudgment: { verdict: "inconsistent", rationale: payload },
          baselineFlags: [],
        },
      },
    });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    for (const dangerous of DANGEROUS_TAGS) {
      assert.ok(!tags.includes(dangerous), `no <${dangerous}> element may ever be constructed from rendering the rationale`);
    }
    assert.ok(
      texts.some((t) => t.includes(payload)),
      "the payload must still appear, verbatim, as inert text content — proving it was neutralized, not silently dropped"
    );
  });

  test("a script-shaped baselineFlags[].detail renders as inert text only", () => {
    const { renderDecisionResult, el } = loadAppJsContext();
    const container = el("div");

    const payload = "<script>window.__xss_fired=2</script>";
    renderDecisionResult(container, {
      decision: {
        verdict: "allow",
        reason: "ok",
        risk: {
          intentJudgment: { verdict: "consistent", rationale: "fine" },
          baselineFlags: [{ code: "high_rate", detail: payload }],
        },
      },
    });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    assert.ok(!tags.includes("script"), "no <script> element may ever be constructed from a baseline flag detail");
    assert.ok(texts.some((t) => t.includes(payload)));
  });

  test("script/svg-shaped execution.rail and execution.error render as inert text only", () => {
    const { renderDecisionResult, el } = loadAppJsContext();
    const container = el("div");

    const railPayload = "<svg onload=alert(document.cookie)>";
    const errorPayload = '"><script>window.__xss_fired=3</script>';
    renderDecisionResult(container, {
      decision: { verdict: "allow", reason: "ok" },
      execution: { success: false, rail: railPayload, error: errorPayload, reference: "" },
    });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    assert.ok(!tags.includes("svg"));
    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(railPayload)), "execution.rail must survive as literal text");
    assert.ok(texts.some((t) => t.includes(errorPayload)), "execution.error must survive as literal text");
  });

  test("a script-shaped execution.reference (on a successful settlement) renders as inert text only", () => {
    const { renderDecisionResult, el } = loadAppJsContext();
    const container = el("div");

    const payload = "<script>window.__xss_fired=4</script>";
    renderDecisionResult(container, {
      decision: { verdict: "allow", reason: "ok" },
      execution: { success: true, rail: "mock_x402", error: undefined, reference: payload },
    });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });
});

describe("renderError() — API-echoed error messages never become DOM markup", () => {
  test("an error message containing markup (e.g. reflecting a rejected agentId) renders as inert text only", () => {
    const { renderError, el } = loadAppJsContext();
    const container = el("div");

    const payload = 'Invalid agentId: "<img src=x onerror=alert(1)>" must match ...';
    renderError(container, payload);

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    assert.ok(!tags.includes("img"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });
});
