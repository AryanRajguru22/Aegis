import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

/**
 * Covers the redesigned sign-in screen: SIGN IN (Principal ID + API key, verified via
 * GET /principals/me — src/api/routes/principals.ts) and CREATE NEW PRINCIPAL (issues
 * a key, shows it once, only authenticates on explicit "Continue"). The core security
 * property under test throughout: the frontend never trusts a client-typed Principal
 * ID — GET /principals/me derives the real owner from the API key itself
 * (req.principalId, set by requirePrincipalAuth from a hash lookup), and the sign-in
 * form only calls the real signIn()/state.authStatus machinery from the previous
 * task (validateSession/handleSessionExpired/principalApi — all untouched here) once
 * that server-derived identity is confirmed to match what the user typed.
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

function makeFakeStorage(): FakeStorage {
  const data: Record<string, string> = {};
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

const TRACKED_IDS = [
  "authScreen",
  "app",
  "navBar",
  "signInForm",
  "createPrincipalForm",
  "authDivider",
  "issuedKeyPanel",
  "signInPrincipalId",
  "signInApiKey",
  "signInError",
  "newPrincipalId",
  "createPrincipalError",
  "issuedKeyPrincipalId",
  "issuedKeyValue",
];

type FetchResponder = (url: string, init: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function fakeJsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => body });
}

/**
 * A fetch dispatcher safe for a FULL boot() cascade — see
 * dashboard-session-auth.test.ts's near-identical harness for why every one of these
 * URLs needs a safe response. /stream deliberately never resolves at all (not even
 * with a 401): boot() calls startStream() fire-and-forget, never awaited by anything
 * a test itself awaits, so a permanently-pending promise here is completely inert —
 * no dangling timer (setTimeout, unavailable in this sandbox, is never reached), and
 * critically no risk of startStream()'s own 401 handling (handleSessionExpired())
 * firing asynchronously and racing with — and corrupting — a test's own assertions
 * about state.authStatus moments after a successful sign-in. A real 401 response was
 * tried here first and DID intermittently lose exactly that race.
 */
function bootSafeFetch(extra: Record<string, () => Promise<unknown>> = {}): FetchResponder {
  return (url) => {
    if (url === "/stream") return new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(() => {});
    if (url === "/agents") return fakeJsonResponse({ agents: [] });
    if (url === "/missions") return fakeJsonResponse({ missions: [] });
    if (url.startsWith("/ledger")) return fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null });
    if (url === "/demo-mode") return fakeJsonResponse({ demoMode: true, aiProvider: "demo" });
    if (url === "/lab/principals") return fakeJsonResponse({ principalId: "lab-x", apiKey: "lab-key-x" });
    if (url === "/lab/ledger") return fakeJsonResponse({ entries: [], chainValid: true, brokenAtSeq: null, reason: null });
    if (url in extra) return extra[url]!() as Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    return fakeJsonResponse({});
  };
}

function loadSignInContext(fetchImpl: FetchResponder) {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const elementsById = new Map<string, FakeElement>();
  for (const id of TRACKED_IDS) elementsById.set(id, makeFakeElement(id.includes("Input") || id.startsWith("signIn") || id === "newPrincipalId" ? "input" : "div"));
  elementsById.get("authScreen")!.style.display = "";
  elementsById.get("app")!.style.display = "none";
  elementsById.get("navBar")!.style.display = "none";
  elementsById.get("signInForm")!.style.display = "block";
  elementsById.get("createPrincipalForm")!.style.display = "block";
  elementsById.get("authDivider")!.style.display = "flex";
  elementsById.get("issuedKeyPanel")!.style.display = "none";

  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string): FakeTextNode => ({ nodeType: 3, data: String(text) }),
    getElementById: (id: string) => {
      if (!elementsById.has(id)) elementsById.set(id, makeFakeElement("div"));
      return elementsById.get(id)!;
    },
    body: { className: "pre-auth" },
  };

  const storage = makeFakeStorage();
  const context = vm.createContext({
    document: fakeDocument,
    localStorage: storage,
    fetch: fetchImpl,
    console,
    crypto: { randomUUID: () => "test-uuid" },
    confirm: () => false,
  });
  // Same JS-realm distinction as dashboard-session-auth.test.ts: `state` is a
  // top-level `let` binding, invisible outside the vm context except through a
  // function declaration (which DOES become a global-object property) closing over it.
  vm.runInContext(`${src}\nfunction __getState() { return state; }`, context, { filename: "app.js" });

  return {
    elementsById,
    storage,
    context: context as unknown as {
      __getState: () => { authStatus: string; apiKey: string | null; principalId: string | null };
    },
  };
}

describe("SIGN IN — Principal ID + API key, verified against the server, never trusted from the client", () => {
  test("a matching Principal ID + real API key signs in successfully and reaches state.authStatus 'authenticated'", async () => {
    const { elementsById, storage, context } = loadSignInContext(
      bootSafeFetch({ "/principals/me": () => fakeJsonResponse({ principalId: "aryan" }) })
    );
    elementsById.get("signInPrincipalId")!.value = "aryan";
    elementsById.get("signInApiKey")!.value = "real-key-belonging-to-aryan";

    await elementsById.get("signInBtn")!.click();

    assert.equal(context.__getState().authStatus, "authenticated");
    assert.equal(context.__getState().principalId, "aryan");
    assert.equal(context.__getState().apiKey, "real-key-belonging-to-aryan");
    assert.equal(storage.getItem("aegis_principal_id"), "aryan");
    assert.equal(storage.getItem("aegis_principal_key"), "real-key-belonging-to-aryan");
    assert.equal(elementsById.get("app")!.style.display, "block", "boot() must have run — the authenticated app is shown");
  });

  test("a WRONG Principal ID with a real API key belonging to a DIFFERENT principal fails — never signs in, even though the key itself is genuinely valid", async () => {
    // The key is real and authenticates fine — it just belongs to "aryan", not the
    // "tyagi" the user typed. GET /principals/me truthfully reports its real owner.
    const { elementsById, storage, context } = loadSignInContext(
      bootSafeFetch({ "/principals/me": () => fakeJsonResponse({ principalId: "aryan" }) })
    );
    elementsById.get("signInPrincipalId")!.value = "tyagi";
    elementsById.get("signInApiKey")!.value = "real-key-belonging-to-aryan";

    await elementsById.get("signInBtn")!.click();

    assert.notEqual(context.__getState().authStatus, "authenticated");
    assert.equal(context.__getState().apiKey, null, "no stale apiKey may be written on a failed sign-in");
    assert.equal(context.__getState().principalId, null);
    assert.equal(storage.getItem("aegis_principal_key"), null, "localStorage must never be written for a failed sign-in");
    assert.equal(elementsById.get("app")!.style.display, "none", "the app must never become visible on a failed sign-in");
    assert.match(elementsById.get("signInError")!.textContent, /do not match/i);
  });

  test("an invalid/unrecognized API key remains unauthenticated, with a safe message", async () => {
    const { elementsById, storage, context } = loadSignInContext(
      bootSafeFetch({ "/principals/me": () => fakeJsonResponse({ error: "Invalid API key" }, false, 401) })
    );
    elementsById.get("signInPrincipalId")!.value = "aryan";
    elementsById.get("signInApiKey")!.value = "totally-made-up-key";

    await elementsById.get("signInBtn")!.click();

    assert.notEqual(context.__getState().authStatus, "authenticated");
    assert.equal(context.__getState().apiKey, null);
    assert.equal(storage.getItem("aegis_principal_key"), null);
    assert.equal(elementsById.get("app")!.style.display, "none");
    assert.match(elementsById.get("signInError")!.textContent, /invalid api key/i);
  });

  test("an empty Principal ID shows a validation error and never calls the server", async () => {
    let fetchCalled = false;
    const { elementsById } = loadSignInContext(async (url) => {
      fetchCalled = true;
      return fakeJsonResponse({});
    });
    elementsById.get("signInPrincipalId")!.value = "";
    elementsById.get("signInApiKey")!.value = "some-key";

    await elementsById.get("signInBtn")!.click();

    assert.equal(fetchCalled, false);
    assert.match(elementsById.get("signInError")!.textContent, /principal id/i);
  });

  test("an empty API key shows a validation error and never calls the server", async () => {
    let fetchCalled = false;
    const { elementsById } = loadSignInContext(async () => {
      fetchCalled = true;
      return fakeJsonResponse({});
    });
    elementsById.get("signInPrincipalId")!.value = "aryan";
    elementsById.get("signInApiKey")!.value = "";

    await elementsById.get("signInBtn")!.click();

    assert.equal(fetchCalled, false);
    assert.match(elementsById.get("signInError")!.textContent, /api key/i);
  });
});

describe("CREATE NEW PRINCIPAL — issues a key, shows it once, only authenticates on explicit confirmation", () => {
  test("successful creation shows the issued Principal ID and API key, and does NOT sign in until 'Continue' is clicked", async () => {
    const { elementsById, storage, context } = loadSignInContext((url, init) => {
      if (url === "/principals" && init.method === "POST") return fakeJsonResponse({ principalId: "new-corp", apiKey: "freshly-issued-key" }, true, 201);
      return bootSafeFetch()(url, init);
    });

    elementsById.get("newPrincipalId")!.value = "new-corp";
    await elementsById.get("createPrincipalBtn")!.click();

    // Not yet authenticated — creation alone must never sign the user in.
    assert.notEqual(context.__getState().authStatus, "authenticated");
    assert.equal(storage.getItem("aegis_principal_key"), null, "must not be stored until the user explicitly continues");
    assert.equal(elementsById.get("issuedKeyPrincipalId")!.textContent, "new-corp");
    assert.equal(elementsById.get("issuedKeyValue")!.textContent, "freshly-issued-key");
    assert.equal(elementsById.get("issuedKeyPanel")!.style.display, "block");
    assert.equal(elementsById.get("signInForm")!.style.display, "none", "the sign-in form must step aside for the one-time key reveal");

    await elementsById.get("issuedKeyContinueBtn")!.click();

    assert.equal(context.__getState().authStatus, "authenticated");
    assert.equal(context.__getState().principalId, "new-corp");
    assert.equal(storage.getItem("aegis_principal_key"), "freshly-issued-key");
    assert.equal(elementsById.get("app")!.style.display, "block");
  });

  test("a duplicate Principal ID shows a clear error and never signs the user in as the existing principal", async () => {
    const { elementsById, storage, context } = loadSignInContext((url, init) => {
      if (url === "/principals" && init.method === "POST") return fakeJsonResponse({ error: 'Principal "acme-corp" already exists' }, false, 409);
      return bootSafeFetch()(url, init);
    });
    elementsById.get("newPrincipalId")!.value = "acme-corp";

    await elementsById.get("createPrincipalBtn")!.click();

    assert.notEqual(context.__getState().authStatus, "authenticated");
    assert.equal(storage.getItem("aegis_principal_key"), null);
    assert.equal(elementsById.get("issuedKeyPanel")!.style.display, "none", "a failed creation must never show the issued-key panel");
    assert.match(elementsById.get("createPrincipalError")!.textContent, /already exists/i);
  });

  test("an empty new Principal ID shows a validation error and never calls the server", async () => {
    let fetchCalled = false;
    const { elementsById } = loadSignInContext(async () => {
      fetchCalled = true;
      return fakeJsonResponse({});
    });
    elementsById.get("newPrincipalId")!.value = "";

    await elementsById.get("createPrincipalBtn")!.click();

    assert.equal(fetchCalled, false);
    assert.match(elementsById.get("createPrincipalError")!.textContent, /principal id/i);
  });
});
