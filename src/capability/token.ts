import {
  AuthorizerBuilder,
  Biscuit,
  Check,
  Rule,
  type Authorizer,
  type PrivateKey,
  type PublicKey,
} from "@biscuit-auth/biscuit-wasm";
import { AUTHORIZE_LIMITS, ensureWasmReady } from "./wasm.js";
import { assertValidIdentifier, buildCaveatChecks, escapeDatalogString, validateAttenuation } from "./caveats.js";
import type { AttenuateInput, IssueRootTokenInput } from "./types.js";

/**
 * Issues a root capability token: block 0 (the "authority" block), signed by the
 * root private key. Its checks are the outermost bound every descendant sub-agent
 * token will inherit and can only narrow, never escape.
 */
export function issueRootToken(input: IssueRootTokenInput, privateKey: PrivateKey): string {
  ensureWasmReady();
  assertValidIdentifier(input.principalId, "principalId");
  assertValidIdentifier(input.agentId, "agentId");

  const builder = Biscuit.builder();
  builder.addCode(
    [
      `principal("${escapeDatalogString(input.principalId)}");`,
      `agent("${escapeDatalogString(input.agentId)}");`,
      `delegated_goal("${escapeDatalogString(input.delegatedGoal)}");`,
    ].join("\n")
  );
  for (const checkSource of buildCaveatChecks(input.caveats)) {
    builder.addCheck(Check.fromString(checkSource));
  }
  return builder.build(privateKey).toBase64();
}

/**
 * Attenuates a parent token into a narrower sub-agent token by appending a new
 * block. The new block's checks are ANDed with every block that came before it at
 * verification time — it can only add restrictions, never remove the parent's.
 * `validateAttenuation` additionally fast-fails here with a clear error if the
 * caller *asked* for something wider than the parent allows, but that check is a
 * convenience, not the security boundary (see caveats.ts doc comment).
 */
export function attenuateToken(input: AttenuateInput, rootPublicKey: PublicKey): string {
  ensureWasmReady();
  assertValidIdentifier(input.agentId, "agentId");
  validateAttenuation(input.parentCaveats, input.caveats);

  const parent = Biscuit.fromBase64(input.parentTokenBase64, rootPublicKey);
  const block = Biscuit.block_builder();
  block.addCode(`agent("${escapeDatalogString(input.agentId)}");`);
  for (const checkSource of buildCaveatChecks(input.caveats)) {
    block.addCheck(Check.fromString(checkSource));
  }
  return parent.appendBlock(block).toBase64();
}

/** Loads and cryptographically verifies a token's signature against the root public key. Throws if the token was tampered with or was not signed by this root key. */
export function loadToken(tokenBase64: string, rootPublicKey: PublicKey): Biscuit {
  ensureWasmReady();
  return Biscuit.fromBase64(tokenBase64, rootPublicKey);
}

/** One revocation identifier per block in the token's ancestry chain, oldest (root) first. A sub-agent token always includes every ancestor's identifier, which is what makes cascading revocation possible — see revocation.ts. */
export function getRevocationIdentifiers(tokenBase64: string, rootPublicKey: PublicKey): string[] {
  return loadToken(tokenBase64, rootPublicKey)
    .getRevocationIdentifiers()
    .map(String);
}

export function countBlocks(tokenBase64: string, rootPublicKey: PublicKey): number {
  return loadToken(tokenBase64, rootPublicKey).countBlocks();
}

export interface RootFacts {
  principalId: string;
  delegatedGoal: string;
}

/**
 * Recovers principalId and delegatedGoal straight from the token's own signed
 * content, via Biscuit's Datalog query API — never from a value a caller separately
 * asserts. This is deliberately NOT implemented via `Biscuit.getBlockSource()` text
 * parsing: that API's pretty-printer does not correctly re-escape special characters
 * (confirmed empirically — a delegated goal containing a `"` round-trips through
 * `getBlockSource` as literally-unescaped text, which is unsound to parse back). The
 * query API instead reads the already-parsed internal fact representation directly,
 * with no text round-trip, and was verified to reproduce a goal containing quotes,
 * backslashes, and unicode exactly — see the test suite.
 *
 * This only recovers principalId/delegatedGoal, not agentId: both are declared once,
 * in block 0 (the root/authority block — see issueRootToken), and by default a query
 * only trusts facts from that block, which makes reading them unambiguous regardless
 * of how many attenuation blocks were appended since. agentId, by contrast, is
 * redeclared in every attenuation block (see attenuateToken), and those non-authority
 * blocks are *not* trusted by a plain query by default — querying `agent($x)` on an
 * attenuated token does not even see the token's own most-recent block, only
 * block 0's. Resolving "which agent does this specific token belong to" is instead
 * done at the API layer via the token's own revocation identifier (getRevocationIds,
 * below) looked up against the AgentStore record created at issuance time — see
 * src/api/auth.ts. That is both simpler and strictly stronger: it ties identity to
 * Aegis's own issuance record for this exact token rather than to text embedded
 * inside it.
 */
export function extractRootFacts(tokenBase64: string, rootPublicKey: PublicKey): RootFacts {
  ensureWasmReady();
  const token = loadToken(tokenBase64, rootPublicKey); // throws on invalid signature/format

  const authBuilder = new AuthorizerBuilder();
  authBuilder.addCode(`ok(1); allow if ok(1);`);
  const authorizer = authBuilder.buildAuthenticated(token);
  try {
    authorizer.authorizeWithLimits(AUTHORIZE_LIMITS);
  } catch {
    // Irrelevant here — this policy always trivially passes; the only reason to run
    // it at all is that query() operates against the authorizer's evaluated world.
  }

  const principalId = queryScalarString(authorizer, "principal");
  const delegatedGoal = queryScalarString(authorizer, "delegated_goal");
  if (principalId === undefined || delegatedGoal === undefined) {
    throw new Error("Token is missing required identity facts (principal/delegated_goal) — not an Aegis-issued token");
  }
  return { principalId, delegatedGoal };
}

function queryScalarString(authorizer: Authorizer, factName: string): string | undefined {
  const results = authorizer.query(Rule.fromString(`out($x) <- ${factName}($x)`));
  const first = results[0];
  if (!first) return undefined;
  const value = first.terms()[0];
  return typeof value === "string" ? value : undefined;
}

/** This token's own revocation identifier — the last block's, i.e. the one specific to whichever issuance or attenuation call produced this exact token. See revocation.ts's revokeAgentToken and src/api/auth.ts's identity resolution, both of which rely on this being unique per token and unforgeable without the root signing key. */
export function getOwnRevocationId(tokenBase64: string, rootPublicKey: PublicKey): string {
  const ids = getRevocationIdentifiers(tokenBase64, rootPublicKey);
  const own = ids[ids.length - 1];
  if (!own) {
    throw new Error("Token has no blocks — cannot determine its own revocation id");
  }
  return own;
}
