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
  // A stable per-id cache: functions like renderMissionDetail that look up a specific
  // container via document.getElementById("missionDetail") internally (rather than
  // taking it as an argument, matching the rest of app.js's existing style) need the
  // SAME fake element returned on every call for a given id, so a test can retrieve it
  // afterward and inspect what was rendered into it — real DOM getElementById behaves
  // the same way (a stable node per id), so this is a closer approximation, not a
  // behavior change from the real thing.
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
    fetch: () => Promise.reject(new Error("not stubbed — this test never triggers a network call")),
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  vm.runInContext(src, context, { filename: "app.js" });
  return context as unknown as {
    renderDecisionResult: (container: FakeElement, body: unknown, options?: Record<string, unknown>) => void;
    renderError: (container: FakeElement, message: string) => void;
    el: (tag: string, attrs?: Record<string, unknown>, children?: unknown[]) => FakeElement;
    pipelineStage: (label: string, statusWord: string, detailNodes: Array<FakeElement | FakeTextNode>) => FakeElement;
    renderMissionCard: (mission: unknown) => FakeElement;
    renderMissionHistoryEntry: (missionId: string, missionCurrency: string, event: unknown) => FakeElement;
    renderMissionDetail: (mission: unknown, ledgerEntries: unknown[]) => void;
    selectMissionHistoryEvents: (allEntries: unknown[], missionId: string) => unknown[];
    historyEventToDecisionBody: (event: unknown) => unknown;
    document: typeof fakeDocument;
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

describe("renderDecisionResult() — the mission-gate stage (Step 6 addition)", () => {
  test("a script-shaped mission-gate denial reason (decision.source === 'mission') renders as inert text only", () => {
    const { renderDecisionResult, el } = loadAppJsContext();
    const container = el("div");

    const payload = "<script>window.__xss_fired=5</script>";
    renderDecisionResult(container, { decision: { verdict: "deny", reason: payload, source: "mission" } });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    for (const dangerous of DANGEROUS_TAGS) assert.ok(!tags.includes(dangerous));
    assert.ok(texts.some((t) => t.includes(payload)));
  });

  test("a script-shaped missionId (passed via options, e.g. reflecting a URL-adjacent value) never becomes DOM markup in the Mission stage label", () => {
    const { renderDecisionResult, el } = loadAppJsContext();
    const container = el("div");

    const payload = "<img src=x onerror=alert(1)>";
    renderDecisionResult(container, { decision: { verdict: "allow", reason: "ok" } }, { missionUsed: true, missionId: payload });

    const tags: string[] = [];
    const texts: string[] = [];
    walk(container, tags, texts);

    assert.ok(!tags.includes("img"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });
});

describe("renderMissionCard() — a mission's own goal/categories/counterparties never become DOM markup", () => {
  function payloadMission(overrides: Record<string, unknown> = {}) {
    return {
      missionId: "mission-1",
      agentId: "agent-root",
      goal: "fine",
      status: "active",
      budgetMinorUnits: 200_000,
      currency: "USD",
      spentMinorUnits: 0,
      reservedMinorUnits: 0,
      remainingMinorUnits: 200_000,
      allowedCategories: ["flights"],
      approvedCounterparties: ["acme-airlines"],
      expiresAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("a script-shaped mission goal renders as inert text only", () => {
    const { renderMissionCard } = loadAppJsContext();
    const payload = "<script>window.__xss_fired=6</script>";
    const card = renderMissionCard(payloadMission({ goal: payload }));

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);

    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });

  test("script-shaped allowedCategories/approvedCounterparties entries render as inert text only", () => {
    const { renderMissionCard } = loadAppJsContext();
    const categoryPayload = "<img src=x onerror=alert(1)>";
    const counterpartyPayload = "<svg onload=alert(2)>";
    const card = renderMissionCard(payloadMission({ allowedCategories: [categoryPayload], approvedCounterparties: [counterpartyPayload] }));

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);

    assert.ok(!tags.includes("img"));
    assert.ok(!tags.includes("svg"));
    assert.ok(texts.some((t) => t.includes(categoryPayload)));
    assert.ok(texts.some((t) => t.includes(counterpartyPayload)));
  });
});

describe("renderMissionHistoryEntry() — every field in a self-contained mission_pipeline_outcome entry never becomes DOM markup (Step 8)", () => {
  test("a mission_policy_verdict (gate denial) entry with a script-shaped reason renders as inert text only", () => {
    const { renderMissionHistoryEntry } = loadAppJsContext();
    const payload = "<script>window.__xss_fired=7</script>";
    // A real mission_policy_verdict entry's data always carries the full submitted
    // `transaction` and `counterparty` too (see routes/transactions.ts's real write
    // site) — included here so this fixture matches what the server actually writes,
    // not just the one field this test cares about.
    const event = {
      seq: 5,
      createdAt: new Date().toISOString(),
      kind: "mission_policy_verdict",
      data: { missionId: "mission-1", reason: payload, transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "test" }, counterparty: "acme-airlines" },
    };

    const card = renderMissionHistoryEntry("mission-1", "USD", event);

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);

    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(payload)));
  });

  test("a mission_pipeline_outcome entry whose execution FAILED, with script/svg-shaped policy/risk/execution fields all self-contained in its own data, renders every shown one as inert text only", () => {
    const { renderMissionHistoryEntry } = loadAppJsContext();
    const rationalePayload = "<script>window.__xss_fired=8</script>";
    const flagPayload = "<img src=x onerror=alert(3)>";
    const policyReasonPayload = "<svg onload=alert(4)>";
    const errorPayload = '"><script>window.__xss_fired=9</script>';

    const event = {
      seq: 10,
      createdAt: new Date().toISOString(),
      kind: "mission_pipeline_outcome",
      data: {
        missionId: "mission-1",
        amountMinorUnits: 38_000,
        category: "flights",
        counterparty: "acme-airlines",
        verdict: "allow",
        reason: "ok",
        policy: { allowed: true, reason: policyReasonPayload },
        risk: { intentJudgment: { verdict: "consistent", rationale: rationalePayload }, baselineFlags: [{ code: "high_rate", detail: flagPayload }] },
        // execution.success: false — only .error is ever shown in this branch, never
        // .reference (matching renderDecisionResult's existing, unchanged behavior,
        // covered by the pre-existing "script/svg-shaped execution.rail and
        // execution.error" test above) — so this test does not assert on a reference
        // payload here; a SUCCESSFUL settlement's reference is already covered by the
        // pre-existing "execution.reference (on a successful settlement)" test.
        execution: { success: false, rail: "stripe_test", error: errorPayload, reference: "" },
      },
    };

    const card = renderMissionHistoryEntry("mission-1", "USD", event);

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);

    for (const dangerous of DANGEROUS_TAGS) assert.ok(!tags.includes(dangerous), `no <${dangerous}> from any field in the self-contained entry`);
    for (const payload of [rationalePayload, flagPayload, policyReasonPayload, errorPayload]) {
      assert.ok(texts.some((t) => t.includes(payload)), `payload ${payload} must survive as literal text`);
    }
  });

  test("a mission_pipeline_outcome entry DENIED by capability/policy (no risk field at all, matching decide.ts's own contract) renders as inert text only", () => {
    const { renderMissionHistoryEntry } = loadAppJsContext();
    const policyReasonPayload = "<script>window.__xss_fired=11</script>";
    const event = {
      seq: 3,
      createdAt: new Date().toISOString(),
      kind: "mission_pipeline_outcome",
      data: {
        missionId: "mission-1",
        amountMinorUnits: 50_000,
        category: "flights",
        counterparty: "acme-airlines",
        verdict: "deny",
        reason: policyReasonPayload,
        policy: { allowed: false, reason: policyReasonPayload },
        // no `risk` field — the risk engine never runs on a policy-denied transaction.
      },
    };

    const card = renderMissionHistoryEntry("mission-1", "USD", event);

    const tags: string[] = [];
    const texts: string[] = [];
    walk(card, tags, texts);

    assert.ok(!tags.includes("script"));
    assert.ok(texts.some((t) => t.includes(policyReasonPayload)));
  });
});

describe("renderMissionDetail() — the full mission detail view never becomes DOM markup", () => {
  test("a mission with script-shaped fields, rendered alongside a script-shaped ledger history, is entirely inert text", () => {
    const context = loadAppJsContext();
    const goalPayload = "<script>window.__xss_fired=10</script>";
    const reasonPayload = "<img src=x onerror=alert(6)>";

    const mission = {
      missionId: "mission-1",
      agentId: "agent-root",
      goal: goalPayload,
      status: "active",
      budgetMinorUnits: 200_000,
      currency: "USD",
      spentMinorUnits: 0,
      reservedMinorUnits: 0,
      remainingMinorUnits: 200_000,
      allowedCategories: ["flights"],
      approvedCounterparties: ["acme-airlines"],
      expiresAt: new Date().toISOString(),
    };
    const ledgerEntries = [
      {
        seq: 1,
        createdAt: new Date().toISOString(),
        kind: "mission_policy_verdict",
        // A real mission_policy_verdict entry's data always carries the full
        // submitted `transaction` and `counterparty` too (see routes/transactions.ts's
        // real write site) — included here so this fixture matches what the server
        // actually writes, since renderMissionDetail -> renderMissionHistoryEntry now
        // reads them to render the real submitted-amount context line.
        data: { missionId: "mission-1", reason: reasonPayload, transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "test" }, counterparty: "acme-airlines" },
      },
    ];

    context.renderMissionDetail(mission, ledgerEntries);
    const rendered = context.document.getElementById("missionDetail");

    const tags: string[] = [];
    const texts: string[] = [];
    walk(rendered, tags, texts);

    assert.ok(!tags.includes("script"));
    assert.ok(!tags.includes("img"));
    assert.ok(texts.some((t) => t.includes(goalPayload)));
    assert.ok(texts.some((t) => t.includes(reasonPayload)));
  });
});

describe("selectMissionHistoryEvents() / historyEventToDecisionBody() — correctness of the Step 8 self-contained mission-history selection", () => {
  test("selects a mission's own mission_pipeline_outcome and mission_policy_verdict entries, sorted most-recent-first, and nothing else", () => {
    const { selectMissionHistoryEvents } = loadAppJsContext();
    const entries = [
      { seq: 1, kind: "policy_verdict", data: { allowed: true } },
      { seq: 2, kind: "mission_policy_verdict", data: { missionId: "mission-1", reason: "denied first" } },
      { seq: 3, kind: "mission_pipeline_outcome", data: { missionId: "mission-1", verdict: "allow", reason: "ok", policy: { allowed: true } } },
      { seq: 4, kind: "mission_transaction_link", data: { missionId: "mission-1", amountMinorUnits: 38_000, success: true } },
      { seq: 5, kind: "execution_result", data: { success: true, rail: "stripe_test", reference: "ref-1" } },
    ];

    const result = selectMissionHistoryEvents(entries, "mission-1") as Array<{ seq: number; kind: string }>;
    assert.deepEqual(result.map((e) => e.seq), [3, 2], "most-recent-first, and mission_transaction_link/policy_verdict/execution_result must never appear directly");
    assert.deepEqual(result.map((e) => e.kind), ["mission_pipeline_outcome", "mission_policy_verdict"]);
  });

  test("never selects entries belonging to a DIFFERENT mission, even one interleaved immediately adjacent in seq order", () => {
    const { selectMissionHistoryEvents } = loadAppJsContext();
    const entries = [
      { seq: 1, kind: "mission_pipeline_outcome", data: { missionId: "other-mission", verdict: "allow", reason: "other's own", policy: { allowed: true } } },
      { seq: 2, kind: "mission_pipeline_outcome", data: { missionId: "mission-1", verdict: "deny", reason: "mission-1's own", policy: { allowed: false } } },
    ];

    const result = selectMissionHistoryEvents(entries, "mission-1") as Array<{ data: { reason: string } }>;
    assert.equal(result.length, 1);
    assert.equal(result[0]!.data.reason, "mission-1's own");
  });

  test("never selects an unrelated, non-mission-scoped transaction's ordinary policy_verdict/decision/execution_result entries", () => {
    const { selectMissionHistoryEvents } = loadAppJsContext();
    const entries = [
      { seq: 1, kind: "policy_verdict", data: { allowed: true } },
      { seq: 2, kind: "decision", data: { verdict: "deny", reason: "unrelated denial", source: "policy" } },
      { seq: 3, kind: "mission_pipeline_outcome", data: { missionId: "mission-1", verdict: "allow", reason: "ok", policy: { allowed: true } } },
    ];

    const result = selectMissionHistoryEvents(entries, "mission-1") as Array<{ seq: number }>;
    assert.deepEqual(result.map((e) => e.seq), [3]);
  });

  test("historyEventToDecisionBody reconstructs a deny-shaped body for a mission_policy_verdict (gate denial) entry", () => {
    const { historyEventToDecisionBody } = loadAppJsContext();
    const body = historyEventToDecisionBody({ kind: "mission_policy_verdict", data: { reason: "budget exceeded" } }) as { decision: { verdict: string; source: string } };
    assert.equal(body.decision.verdict, "deny");
    assert.equal(body.decision.source, "mission");
  });

  test("historyEventToDecisionBody reconstructs the full decision+execution shape directly from a mission_pipeline_outcome entry's own data, with no correlation step", () => {
    const { historyEventToDecisionBody } = loadAppJsContext();
    const event = {
      kind: "mission_pipeline_outcome",
      data: {
        missionId: "mission-1",
        verdict: "escalate",
        reason: "flagged",
        policy: { allowed: true },
        risk: { intentJudgment: { verdict: "inconsistent", rationale: "does not match goal" }, baselineFlags: [] },
        execution: undefined,
      },
    };
    const body = historyEventToDecisionBody(event) as { decision: { verdict: string; reason: string; policy: unknown; risk: unknown }; execution: unknown };
    assert.equal(body.decision.verdict, "escalate");
    assert.equal(body.decision.reason, "flagged");
    assert.deepEqual(body.decision.policy, { allowed: true });
    assert.equal((body.decision.risk as { intentJudgment: { verdict: string } }).intentJudgment.verdict, "inconsistent");
    assert.equal(body.execution, undefined, "no execution ever occurs on a non-allow verdict — matches executeTransaction's own contract");
  });

  test("historyEventToDecisionBody omits `risk` entirely for a capability/policy-denied outcome, matching decide.ts's own contract (risk never runs on a policy denial)", () => {
    const { historyEventToDecisionBody } = loadAppJsContext();
    const event = {
      kind: "mission_pipeline_outcome",
      data: { missionId: "mission-1", verdict: "deny", reason: "over the cap", policy: { allowed: false, reason: "over the cap" } },
    };
    const body = historyEventToDecisionBody(event) as { decision: { risk?: unknown } };
    assert.equal(body.decision.risk, undefined);
  });
});
