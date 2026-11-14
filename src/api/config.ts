/**
 * Environment parsing helpers for src/api/main.ts, kept separate so they can be unit
 * tested. Principle: an empty value (`NAME=` in a copied .env.example) means "unset",
 * and a malformed value fails startup with a message naming the variable — never a
 * silent fallback.
 */

/** Returns the trimmed value, or undefined when the variable is unset or blank. */
export function envString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function parsePort(value: string | undefined): number {
  const v = envString(value);
  if (v === undefined) return 8787;
  if (!/^[0-9]+$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
    throw new Error(`Invalid PORT value: "${value}" — must be a whole number from 1 to 65535.`);
  }
  return Number(v);
}

/**
 * AEGIS_TRUST_PROXY: unset/"false" -> off; "true" -> trust all proxies; a whole number
 * -> trust that many hops (e.g. "1" for a single load balancer such as Render's);
 * anything else is passed to Express as a subnet list (e.g. "loopback, 10.0.0.0/8").
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  const v = envString(value);
  if (v === undefined || v.toLowerCase() === "false") return undefined;
  if (v.toLowerCase() === "true") return true;
  if (/^[0-9]+$/.test(v)) return Number(v);
  return v;
}

/** AEGIS_SIGNUP_RATE_LIMIT: max unauthenticated sign-ups per client IP per hour. Unset -> 30. "0" disables the limiter. */
export function parseSignupRateLimit(value: string | undefined): number {
  const v = envString(value);
  if (v === undefined) return 30;
  if (!/^[0-9]+$/.test(v)) {
    throw new Error(`Invalid AEGIS_SIGNUP_RATE_LIMIT value: "${value}" — must be a whole number (0 disables the limit).`);
  }
  return Number(v);
}

export interface KeyPolicyInput {
  nodeEnv: string | undefined;
  rootKeySet: boolean;
  ledgerKeySet: boolean;
  /** AEGIS_ALLOW_EPHEMERAL_KEYS=true */
  allowEphemeral: boolean;
  rootKeyHex?: string;
  ledgerKeyHex?: string;
}

/**
 * Startup policy for the two signing keys. In NODE_ENV=production, running with
 * generated (ephemeral) keys would silently invalidate every issued token and make the
 * previous ledger look tampered after any restart, so it is refused unless the operator
 * explicitly opts in with AEGIS_ALLOW_EPHEMERAL_KEYS=true (e.g. a throwaway demo or a CI
 * smoke test). Returns human-readable problems (never including key material); empty = ok.
 */
export function checkKeyPolicy(input: KeyPolicyInput): string[] {
  const problems: string[] = [];
  if (input.nodeEnv === "production" && !input.allowEphemeral) {
    if (!input.rootKeySet) {
      problems.push(
        "AEGIS_ROOT_PRIVATE_KEY_HEX is required when NODE_ENV=production (run `npm run keygen`, or set AEGIS_ALLOW_EPHEMERAL_KEYS=true for a throwaway instance)."
      );
    }
    if (!input.ledgerKeySet) {
      problems.push(
        "AEGIS_LEDGER_PRIVATE_KEY_HEX is required when NODE_ENV=production (run `npm run keygen`, or set AEGIS_ALLOW_EPHEMERAL_KEYS=true for a throwaway instance)."
      );
    }
  }
  if (input.rootKeyHex !== undefined && input.ledgerKeyHex !== undefined && input.rootKeyHex === input.ledgerKeyHex) {
    problems.push("AEGIS_ROOT_PRIVATE_KEY_HEX and AEGIS_LEDGER_PRIVATE_KEY_HEX must be two different keys.");
  }
  return problems;
}

/** AEGIS_ALLOW_EPHEMERAL_KEYS: only the exact string "true" enables it. */
export function parseAllowEphemeral(value: string | undefined): boolean {
  return envString(value) === "true";
}
