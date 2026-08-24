/**
 * The Biscuit wasm engine has a real, empirically-observed cold-start cost: the
 * first `Authorizer.authorize()` call in a process can occasionally exceed the
 * engine's default run limits and report a spurious timeout even for a trivially
 * satisfiable check, while every subsequent call in the same process is fast and
 * reliable. `ensureWarm()` pays that cost once, deliberately, at module load time
 * with a throwaway token, so it never happens on a real caller's first request.
 */
import {
  init,
  KeyPair,
  SignatureAlgorithm,
  Biscuit,
  AuthorizerBuilder,
} from "@biscuit-auth/biscuit-wasm";

let ready = false;
let warmed = false;

export function ensureWasmReady(): void {
  if (ready) return;
  init();
  ready = true;
}

/** Generous, explicit limits for every authorization run in this module — see wasm.ts doc comment for why we never rely on the library's implicit defaults. */
export const AUTHORIZE_LIMITS = {
  max_facts: 1000,
  max_iterations: 1000,
  max_time_micro: 5_000_000,
};

export function ensureWarm(): void {
  if (warmed) return;
  ensureWasmReady();
  const kp = new KeyPair(SignatureAlgorithm.Ed25519);
  const token = Biscuit.builder().build(kp.getPrivateKey());
  const builder = new AuthorizerBuilder();
  builder.addCode(`ok(1); allow if ok(1);`);
  const auth = builder.buildAuthenticated(token);
  try {
    auth.authorize();
  } catch {
    // Expected in rare cases if this very first call is the one that's slow;
    // the point is only to pay the JIT/setup cost, not to assert an outcome.
  }
  warmed = true;
}
