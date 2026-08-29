import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression test for a bug found during Step 11's live-browser delegation/
 * attenuation/revocation verification: the "Create" button's submit handler always
 * computed a fresh caveats.expiresAt of "now + 365 days" for EVERY submission,
 * including when attenuating a sub-agent. Since attenuation happens even slightly
 * after the parent's own creation, the child's freshly-computed expiresAt was
 * virtually always strictly LATER than the parent's own (also freshly-computed at an
 * earlier moment) expiresAt — which validateAttenuation correctly rejects as a
 * widening. In practice this meant the dashboard's Attenuate feature could not
 * succeed at all, for any agent, through normal use. Fixed by defaulting the child's
 * expiresAt to the parent's own recorded expiresAt (equal is allowed; only strictly
 * later is a widening) when state.attenuateParentId is set.
 *
 * Uses the same click-triggering fake-DOM technique as dashboard-request-race.test.ts
 * (a self-contained harness, not shared/imported — each dashboard test file in this
 * project builds its own fake DOM sized to what it needs) since this requires
 * actually invoking the real, unmodified createAgentBtn click handler and inspecting
 * the request body it POSTs, not just calling an exported pure function.
 */

const APP_JS_PATH = path.join(import.meta.dirname, "../../../public/app.js");

interface FakeElement {
  value: string;
  textContent: string;
  checked: boolean;
  addEventListener(type: string, fn: () => unknown): void;
  click(): Promise<unknown>;
}

function makeFormElement(initial: Partial<FakeElement> = {}): FakeElement {
  const listeners = new Map<string, Array<() => unknown>>();
  return {
    value: "",
    textContent: "",
    checked: true,
    ...initial,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    click() {
      return Promise.all((listeners.get("click") ?? []).map((fn) => fn()));
    },
  } as FakeElement;
}

/** attenuateParentId: null for a root creation, or a parent id string to simulate attenuating. parentExpiresAt is only used when attenuating. */
function loadContext(attenuateParentId: string | null, parentExpiresAt = "2027-01-01T00:00:00.000Z") {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  for (const id of ["agentId", "delegatedGoal", "maxAmount", "categories"]) elementsById.set(id, makeFormElement());
  elementsById.set("railStripe", makeFormElement({ checked: true }));
  elementsById.set("railX402", makeFormElement({ checked: true }));
  elementsById.set("createAgentBtn", makeFormElement());
  elementsById.set("agentError", makeFormElement());
  elementsById.set("cancelAttenuateBtn", makeFormElement());
  elementsById.set("createAgentContext", makeFormElement());

  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (url: string, init: { body?: string }) => {
    fetchCalls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return Promise.resolve({
      ok: true,
      status: 201,
      json: async () => ({ agentId: "whatever", token: "fake-token", caveats: {} }),
    });
  };

  const fakeDocument = {
    createElement: () => makeFormElement(),
    createTextNode: (text: string) => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFormElement());
      return elementsById.get(id)!;
    },
  };

  const context = vm.createContext({
    document: fakeDocument,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fakeFetch,
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  // state.attenuateParentId / state.agents are `let`-declared top-level bindings —
  // not exposed as context properties to outside JS (same vm/JS-realm distinction
  // documented in dashboard-request-race.test.ts) — so they're set here, in the same
  // realm, appended to the same source evaluation.
  const stateSetup =
    attenuateParentId === null
      ? `state.attenuateParentId = null; state.agents = [];`
      : `state.attenuateParentId = ${JSON.stringify(attenuateParentId)};
         state.agents = [{ agentId: ${JSON.stringify(attenuateParentId)}, caveats: { expiresAt: ${JSON.stringify(parentExpiresAt)} } }];`;
  vm.runInContext(`${src}\n${stateSetup}`, context, { filename: "app.js" });

  return { elementsById, fetchCalls };
}

describe("dashboard attenuation — child expiresAt defaults to the parent's own, never a fresh later one (Step 11 regression)", () => {
  test("submitting the Create button while attenuating posts a caveats.expiresAt equal to the parent's recorded expiresAt, not a freshly-computed later value", async () => {
    const { elementsById, fetchCalls } = loadContext("parent-1");
    elementsById.get("agentId")!.value = "child-1";
    elementsById.get("delegatedGoal")!.value = "Do the narrower thing.";
    elementsById.get("maxAmount")!.value = "100";
    elementsById.get("categories")!.value = "flights";

    await elementsById.get("createAgentBtn")!.click();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.url, "/agents/parent-1/attenuate");
    const body = fetchCalls[0]!.body as { caveats: { expiresAt: string } };
    assert.equal(
      body.caveats.expiresAt,
      "2027-01-01T00:00:00.000Z",
      "the submitted expiresAt must equal the parent's own, not a fresh now+365d computation that would almost always be later"
    );
  });

  test("creating a ROOT agent (no attenuateParentId) still gets a fresh now+365d expiresAt, unaffected by the attenuation-path fix", async () => {
    const { elementsById, fetchCalls } = loadContext(null);
    elementsById.get("agentId")!.value = "root-1";
    elementsById.get("delegatedGoal")!.value = "Root goal.";
    elementsById.get("maxAmount")!.value = "100";
    elementsById.get("categories")!.value = "flights";

    const before = Date.now();
    await elementsById.get("createAgentBtn")!.click();
    const after = Date.now();

    const rootCall = fetchCalls.find((c) => c.url === "/agents");
    assert.ok(rootCall, "a root agent creation must POST to /agents, not an attenuate URL");
    const expiresAtMs = new Date((rootCall!.body as { caveats: { expiresAt: string } }).caveats.expiresAt).getTime();
    const expectedMin = before + 364 * 24 * 60 * 60 * 1000;
    const expectedMax = after + 366 * 24 * 60 * 60 * 1000;
    assert.ok(expiresAtMs > expectedMin && expiresAtMs < expectedMax, "root creation must still default to roughly now+365 days");
  });
});
