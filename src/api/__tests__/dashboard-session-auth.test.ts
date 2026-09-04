import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Root-cause regression coverage for a real bug: a stale localStorage principal apiKey
 * (left over from a previous server process — e.g. after a restart with a fresh or
 * different principal store) used to be treated as "signed in" the instant init()
 * found it in storage, with NO server-side check at all. Every widget that then
 * happened to call the API with that dead key discovered the 401 independently — the
 * Security Demonstration Lab in particular showed "Sign-in required — your session
 * key is no longer valid. Sign in again to verify." even though the lab has no
 * sign-in concept of its own (it bootstraps its own identity automatically).
 *
 * See public/app.js's "session / principal authentication" section
 * (validateSession/handleSessionExpired/principalApi) for the fix this proves:
 * state.authStatus is the one place "are we signed in at all" is ever decided, a
 * stored key is always validated against the server before anything treats it as
 * live, and a 401 from any principal-authenticated call routes centrally back to the
 * one, already-working sign-in screen — never silently, never with raw backend text.
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
  getAttribute(name: string): string | null;
  src: string;
  complete: boolean;
  naturalWidth: number;
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
    src: "",
    complete: false,
    naturalWidth: 0,
    // Only ever asked about "src" in this codebase (envWorkspaceShift's crossfade
    // logic, triggered by showWorkspace() inside boot()) — a real <img> element's
    // getAttribute("src") reflects whatever .src was last set to.
    getAttribute(name) {
      return name === "src" ? this.src || null : null;
    },
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

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  _data: Record<string, string>;
}

function makeFakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data: Record<string, string> = { ...initial };
  return {
    _data: data,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const AUTH_RELATED_IDS = [
  "authScreen",
  "app",
  "navBar",
  "signInForm",
  "createPrincipalForm",
  "authDivider",
  "issuedKeyPanel",
  "signInError",
  "createPrincipalError",
  "principalBadge",
  "shellStatus",
  "shellStatusText",
  "ovLedger",
  "chainStatus",
  "integrityStatus",
  "labIntegrityStatus",
  "feed",
];

type FetchResponder = (url: string, init: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; body?: unknown }>;

/**
 * Loads app.js with an EMPTY localStorage at the moment the script itself evaluates —
 * so the file's own top-level `init()` IIFE (which calls validateSession()
 * automatically, exactly as it does in a real browser on page load) finds nothing and
 * harmlessly no-ops, the same way every OTHER dashboard test file in this project
 * already relies on (a stored session is never present unless a test deliberately
 * sets it up). Each test then populates `storage` itself, AFTER context creation,
 * immediately before calling context.validateSession() explicitly — this is what
 * makes the explicit call the only one that ever actually runs against interesting
 * (non-empty) storage, avoiding a race against the auto-init call.
 */
function loadAuthContext(fetchImpl: FetchResponder) {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  for (const id of AUTH_RELATED_IDS) elementsById.set(id, makeFakeElement("div"));
  // authScreen starts at a nonsense sentinel (never a real value showAuthScreen() or
  // boot() would themselves set) specifically so "was this ever touched at all" is
  // distinguishable from "touched and explicitly re-shown" (both of which use "").
  elementsById.get("authScreen")!.style.display = "__untouched__";
  elementsById.get("app")!.style.display = "none";
  elementsById.get("navBar")!.style.display = "none";

  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFakeElement("div"));
      return elementsById.get(id)!;
    },
    body: { className: "pre-auth" },
  };

  const storage = makeFakeStorage({});
  const context = vm.createContext({
    document: fakeDocument,
    localStorage: storage,
    fetch: fetchImpl,
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  // `state` is a top-level `let` binding in app.js — unlike a `function` declaration,
  // that does NOT become a property of the vm context's global object, so
  // `context.state` is never reachable directly (the same JS-realm distinction
  // dashboard-request-race.test.ts and dashboard-attack-theatre.test.ts already rely
  // on for attackMissionId/attackAgentId). __getState/__setState are plain function
  // declarations appended to the SAME source evaluation, so they DO become reachable,
  // and — being declared in the same scope — close over the real, live `state` object
  // every other function in this file also reads and writes.
  vm.runInContext(`${src}\nfunction __getState() { return state; }\nfunction __setState(patch) { Object.assign(state, patch); }`, context, { filename: "app.js" });

  return {
    elementsById,
    storage,
    context: context as unknown as {
      __getState: () => { authStatus: string; apiKey: string | null; principalId: string | null };
      __setState: (patch: Record<string, unknown>) => void;
      validateSession: () => Promise<void>;
      handleSessionExpired: () => void;
      principalApi: (path: string, opts?: unknown) => Promise<unknown>;
      labApi: (path: string, opts?: unknown) => Promise<unknown>;
    },
  };
}

function fakeJsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => body });
}

describe("validateSession() — a stored key is verified against the server, never trusted on sight", () => {
  test("a genuinely valid stored key results in authStatus 'authenticated' and the dashboard shell shown", async () => {
    // A real, valid key makes validateSession() call boot(), which fires off a whole
    // cascade of its own background calls (loadAgents, loadMissions,
    // verifyProductionLedger, checkLabIntegrity, startStream) — this dispatcher gives
    // each a safe, successful response so none of them throws unhandled. /stream never
    // resolves at all (rather than a 401): it's called fire-and-forget from boot(),
    // never awaited by this test, so a permanently-pending promise is inert — no
    // dangling timer (setTimeout is unavailable in this sandbox and never reached),
    // and no risk of startStream()'s own 401 handling (handleSessionExpired()) firing
    // asynchronously and racing with this test's own assertions about authStatus
    // moments after boot() runs (confirmed to actually happen with a real 401 here).
    const { elementsById, storage, context } = loadAuthContext((url) => {
      if (url === "/stream") return new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(() => {});
      if (url === "/principals/me") return fakeJsonResponse({ principalId: "acme-corp" });
      if (url === "/agents") return fakeJsonResponse({ agents: [] });
      if (url === "/missions") return fakeJsonResponse({ missions: [] });
      if (url.startsWith("/ledger")) return fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null });
      if (url === "/demo-mode") return fakeJsonResponse({ demoMode: true, aiProvider: "demo" });
      if (url === "/lab/principals") return fakeJsonResponse({ principalId: "lab-x", apiKey: "lab-key-x" });
      if (url === "/lab/ledger") return fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null });
      return fakeJsonResponse({});
    });
    storage.setItem("aegis_principal_id", "acme-corp");
    storage.setItem("aegis_principal_key", "real-valid-key");

    await context.validateSession();

    assert.equal(context.__getState().authStatus, "authenticated");
    assert.equal(context.__getState().apiKey, "real-valid-key");
    assert.equal(elementsById.get("app")!.style.display, "block", "boot() must have run and shown the dashboard shell");
  });

  test("no stored key at all results in authStatus 'unauthenticated', with no server call made", async () => {
    let fetchCalled = false;
    const { context } = loadAuthContext(() => {
      fetchCalled = true;
      return fakeJsonResponse({ agents: [] });
    });

    await context.validateSession();

    assert.equal(context.__getState().authStatus, "unauthenticated");
    assert.equal(fetchCalled, false, "an absent key must never even attempt a validation call");
  });

  test("an invalid/stale stored key (401 from the server) results in authStatus 'unauthenticated', clears storage, and shows a friendly sign-in-required message — never raw backend text", async () => {
    const { elementsById, storage, context } = loadAuthContext(() => fakeJsonResponse({ error: "Invalid API key" }, false, 401));
    storage.setItem("aegis_principal_id", "acme-corp");
    storage.setItem("aegis_principal_key", "stale-key-from-a-previous-server-process");

    await context.validateSession();

    assert.equal(context.__getState().authStatus, "unauthenticated");
    assert.equal(context.__getState().apiKey, null);
    assert.equal(context.__getState().principalId, null);
    assert.equal(storage.getItem("aegis_principal_key"), null, "the stale key must be removed from localStorage, not left behind");
    assert.equal(storage.getItem("aegis_principal_id"), null);

    assert.equal(elementsById.get("authScreen")!.style.display, "", "the sign-in screen must be shown again");
    assert.equal(elementsById.get("app")!.style.display, "none", "the stale dashboard must not remain visible underneath");
    const message = elementsById.get("signInError")!.textContent;
    assert.match(message, /sign in again/i);
    assert.ok(!message.includes("Invalid API key"), "the raw backend error string must never be shown to the user");
  });

  test("a network failure during validation neither wipes the stored key nor treats the user as authenticated — it is unproven, not disproven", async () => {
    const { storage, context } = loadAuthContext(() => Promise.reject(new Error("network down")));
    storage.setItem("aegis_principal_id", "acme-corp");
    storage.setItem("aegis_principal_key", "maybe-still-valid-key");

    await context.validateSession();

    assert.notEqual(context.__getState().authStatus, "authenticated");
    assert.notEqual(context.__getState().authStatus, "unauthenticated", "a network error must not be conflated with a confirmed-invalid key");
    assert.equal(storage.getItem("aegis_principal_key"), "maybe-still-valid-key", "an unproven key must never be discarded on a mere network error");
  });
});

describe("handleSessionExpired() — the ONE place a 401 ever routes to, from anywhere", () => {
  test("is idempotent — calling it twice in a row (e.g. two widgets 401ing around the same time) does not throw or double-clear", () => {
    const { context } = loadAuthContext(() => fakeJsonResponse({}, false, 401));
    context.__setState({ apiKey: "stale", principalId: "acme-corp" });
    context.handleSessionExpired();
    assert.equal(context.__getState().authStatus, "unauthenticated");
    assert.doesNotThrow(() => context.handleSessionExpired());
  });
});

describe("principalApi() — the single wrapper that authenticates as the real signed-in principal, and the only place its 401s are ever handled", () => {
  test("a 401 from ANY principal-authenticated call triggers the same global session-expired handling — not just the ledger check", async () => {
    const { elementsById, context } = loadAuthContext(() => fakeJsonResponse({ error: "Invalid API key" }, false, 401));
    context.__setState({ apiKey: "stale-key", principalId: "acme-corp", authStatus: "authenticated" }); // simulates an already-booted session whose key just went stale mid-use

    await assert.rejects(context.principalApi("/missions"));

    assert.equal(context.__getState().authStatus, "unauthenticated");
    assert.equal(elementsById.get("authScreen")!.style.display, "");
  });

  test("a non-auth error (e.g. a 500) does NOT clear the session or show the sign-in screen — only a confirmed 401/403 does", async () => {
    const { elementsById, context } = loadAuthContext(() => fakeJsonResponse({ error: "internal error" }, false, 500));
    context.__setState({ apiKey: "still-a-fine-key", principalId: "acme-corp", authStatus: "authenticated" });

    await assert.rejects(context.principalApi("/missions"));

    assert.equal(context.__getState().authStatus, "authenticated", "a server error is not proof the session is invalid");
    assert.equal(elementsById.get("authScreen")!.style.display, "__untouched__", "a non-auth error must never show the sign-in screen");
  });
});

describe("labApi() — the lab's own identity has NO sign-in concept, so a stale lab identity self-heals silently instead of showing 'sign in'", () => {
  test("a stale lab identity (401) is discarded and a fresh one is bootstrapped automatically — the caller sees a normal success, never an error, never the main session's sign-in flow", async () => {
    let labLedgerCalls = 0;
    let principalsCalls = 0;
    const { elementsById, context } = loadAuthContext((url, init) => {
      if (url === "/lab/principals") {
        principalsCalls++;
        return fakeJsonResponse({ principalId: `lab-${principalsCalls}`, apiKey: `lab-key-${principalsCalls}` });
      }
      if (url === "/lab/ledger") {
        labLedgerCalls++;
        // First attempt (using the FIRST bootstrapped identity) simulates a stale
        // identity from a previous server process — 401. Only the SECOND attempt
        // (after labApi() has silently discarded and re-bootstrapped) succeeds.
        if (labLedgerCalls === 1) return fakeJsonResponse({ error: "Invalid API key" }, false, 401);
        return fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null });
      }
      void init;
      return fakeJsonResponse({});
    });

    const result = (await context.labApi("/lab/ledger")) as { chainValid: boolean };

    assert.equal(result.chainValid, true, "the caller must receive the eventual successful result, not an error");
    assert.equal(principalsCalls, 2, "a stale identity must be discarded and a fresh one bootstrapped exactly once — not zero, not repeatedly");
    assert.equal(labLedgerCalls, 2, "the original failing request must be retried exactly once against the fresh identity");
    // The main, real-principal sign-in screen must never be involved in recovering
    // the lab's own, separate identity — that would conflate two different auth
    // realms and confuse a user who is, in fact, still validly signed in.
    assert.equal(elementsById.get("authScreen")!.style.display, "__untouched__");
  });

  test("a SECOND consecutive failure (even against the freshly re-bootstrapped identity) is a real, different problem and propagates to the caller", async () => {
    const { context } = loadAuthContext((url) => {
      if (url === "/lab/principals") return fakeJsonResponse({ principalId: "lab-x", apiKey: "lab-key-x" });
      if (url === "/lab/ledger") return fakeJsonResponse({ error: "Invalid API key" }, false, 401); // fails every time, even after recovery
      return fakeJsonResponse({});
    });

    // Not `err instanceof Error` — an error thrown inside this separate vm.Context is
    // an instance of THAT context's own Error constructor, not this file's, so a
    // cross-realm instanceof check would be a false negative here, not a real signal.
    await assert.rejects(context.labApi("/lab/ledger"));
  });
});
