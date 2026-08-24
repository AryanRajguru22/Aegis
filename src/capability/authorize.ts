import { AuthorizerBuilder, type PublicKey } from "@biscuit-auth/biscuit-wasm";
import { AUTHORIZE_LIMITS, ensureWasmReady } from "./wasm.js";
import { getRevocationIdentifiers, loadToken } from "./token.js";
import { assertValidIdentifier } from "./caveats.js";
import type { RevocationStore } from "./revocation.js";
import type { TransactionRequest, VerifyResult } from "./types.js";

function toDatalogTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid transaction timestamp: "${iso}"`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Verifies a presented capability token against a specific proposed transaction.
 *
 * Two independent gates, cheapest/least-trusted-input first:
 *  1. Revocation — a fast, non-cryptographic lookup. If the token's own ancestry
 *     (its own block's identifier, or any ancestor's) is in the revocation store,
 *     deny immediately. This is what makes revoking a root or intermediate agent
 *     cascade to every descendant without needing to enumerate them.
 *  2. Cryptographic + Datalog verification — the token's signature is checked
 *     (throws if tampered or signed by a different key), then every check across
 *     every block in its ancestry is evaluated against the facts describing this
 *     specific transaction. All of them must hold.
 */
export function verifyTransaction(
  tokenBase64: string,
  rootPublicKey: PublicKey,
  transaction: TransactionRequest,
  revocationStore: RevocationStore
): VerifyResult {
  ensureWasmReady();
  assertValidIdentifier(transaction.currency, "transaction.currency");
  assertValidIdentifier(transaction.category, "transaction.category");
  assertValidIdentifier(transaction.rail, "transaction.rail");
  if (!Number.isInteger(transaction.amountMinorUnits) || transaction.amountMinorUnits <= 0) {
    throw new Error("transaction.amountMinorUnits must be a positive integer");
  }

  const revocationIdentifiers = getRevocationIdentifiers(tokenBase64, rootPublicKey);

  const revoked = revocationStore.findRevoked(revocationIdentifiers);
  if (revoked) {
    return {
      allowed: false,
      reason: `Token (or an ancestor) was revoked at ${revoked.revokedAt}: ${revoked.reason}`,
      revocationIdentifiers,
    };
  }

  const token = loadToken(tokenBase64, rootPublicKey); // throws on signature/tamper failure

  const timestamp = toDatalogTimestamp(transaction.timestamp ?? new Date().toISOString());
  const facts = [
    `transaction_amount_minor_units(${transaction.amountMinorUnits});`,
    `transaction_currency("${transaction.currency}");`,
    `category("${transaction.category}");`,
    `rail("${transaction.rail}");`,
    `transaction_time(${timestamp});`,
    `verification_request(1);`,
  ].join("\n");
  const policy = `allow if verification_request(1);`;

  const authBuilder = new AuthorizerBuilder();
  authBuilder.addCode(`${facts}\n${policy}`);
  const auth = authBuilder.buildAuthenticated(token);

  try {
    auth.authorizeWithLimits(AUTHORIZE_LIMITS);
    return { allowed: true, revocationIdentifiers };
  } catch (error) {
    return {
      allowed: false,
      reason: summarizeAuthorizationFailure(error),
      revocationIdentifiers,
    };
  }
}

function summarizeAuthorizationFailure(error: unknown): string {
  try {
    const asAny = error as {
      FailedLogic?: {
        Unauthorized?: {
          checks?: Array<{ Block?: { rule?: string }; Authorizer?: { rule?: string } }>;
        };
      };
      RunLimit?: string;
    };
    if (asAny?.RunLimit) {
      return `Authorization engine exceeded its run limit (${asAny.RunLimit}) — treat as deny/escalate, not allow.`;
    }
    const checks = asAny?.FailedLogic?.Unauthorized?.checks;
    if (checks && checks.length > 0) {
      const rules = checks.map((c) => c.Block?.rule ?? c.Authorizer?.rule).filter(Boolean);
      return `Failed check(s): ${rules.join(" | ")}`;
    }
  } catch {
    // fall through to generic message below
  }
  return `Authorization denied: ${JSON.stringify(error)}`;
}
