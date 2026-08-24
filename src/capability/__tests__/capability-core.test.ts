import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Biscuit, Check } from "@biscuit-auth/biscuit-wasm";

import {
  ensureWarm,
  generateRootKeyPair,
  issueRootToken,
  attenuateToken,
  verifyTransaction,
  createInMemoryRevocationStore,
  revokeAgentToken,
  getRevocationIdentifiers,
  extractRootFacts,
  getOwnRevocationId,
} from "../index.js";
import type { Caveats, TransactionRequest } from "../types.js";

ensureWarm();

const ONE_YEAR_FROM_NOW = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function conferenceTravelCaveats(overrides: Partial<Caveats> = {}): Caveats {
  return {
    maxAmountMinorUnits: 200_000, // $2,000.00
    currency: "USD",
    categories: ["flights", "hotels"],
    rails: ["stripe_test", "mock_x402"],
    expiresAt: ONE_YEAR_FROM_NOW,
    ...overrides,
  };
}

function flightTx(overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  return {
    amountMinorUnits: 38_000, // $380.00
    currency: "USD",
    category: "flights",
    rail: "stripe_test",
    ...overrides,
  };
}

describe("root token issuance and verification", () => {
  test("allows a transaction within every caveat", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );
    const store = createInMemoryRevocationStore();

    const result = verifyTransaction(rootToken, publicKey, flightTx(), store);
    assert.equal(result.allowed, true);
  });

  test("denies a transaction over the amount cap", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 100_000 }) },
      privateKey
    );
    const store = createInMemoryRevocationStore();

    const result = verifyTransaction(rootToken, publicKey, flightTx({ amountMinorUnits: 150_000 }), store);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /transaction_amount_minor_units/);
  });

  test("denies a transaction in a disallowed category", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats() },
      privateKey
    );
    const store = createInMemoryRevocationStore();

    const result = verifyTransaction(rootToken, publicKey, flightTx({ category: "gpu_credits" }), store);
    assert.equal(result.allowed, false);
  });

  test("denies a transaction on a disallowed rail", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats() },
      privateKey
    );
    const store = createInMemoryRevocationStore();

    const result = verifyTransaction(rootToken, publicKey, flightTx({ rail: "unknown_rail" }), store);
    assert.equal(result.allowed, false);
  });

  test("denies a transaction after the token has expired", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats({ expiresAt: YESTERDAY }) },
      privateKey
    );
    const store = createInMemoryRevocationStore();

    const result = verifyTransaction(rootToken, publicKey, flightTx(), store);
    assert.equal(result.allowed, false);
  });

  test("denies a currency mismatch", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats() },
      privateKey
    );
    const store = createInMemoryRevocationStore();

    const result = verifyTransaction(rootToken, publicKey, flightTx({ currency: "EUR" }), store);
    assert.equal(result.allowed, false);
  });
});

describe("attenuation (sub-agent delegation)", () => {
  test("a sub-agent token enforces its own narrower cap, not just the parent's", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats(); // $2,000 cap
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );

    const flightsCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 50_000, categories: ["flights"] }); // $500 cap, narrower category
    const flightsToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-flights", caveats: flightsCaveats },
      publicKey
    );

    const store = createInMemoryRevocationStore();

    // Within the sub-agent's own $500 cap: allowed.
    assert.equal(verifyTransaction(flightsToken, publicKey, flightTx({ amountMinorUnits: 38_000 }), store).allowed, true);

    // Within the ROOT's $2,000 cap but over the sub-agent's own $500 cap: must be denied.
    // This is the specific property that proves attenuation is enforced per-token, not
    // just inherited as "whatever the root allows".
    const result = verifyTransaction(flightsToken, publicKey, flightTx({ amountMinorUnits: 150_000 }), store);
    assert.equal(result.allowed, false);
  });

  test("a sub-agent token cannot be used for a category outside its own (narrower) allowlist even though the root allows it", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats(); // allows flights + hotels
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );

    const flightsOnlyCaveats = conferenceTravelCaveats({ categories: ["flights"] });
    const flightsToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-flights", caveats: flightsOnlyCaveats },
      publicKey
    );

    const store = createInMemoryRevocationStore();
    const result = verifyTransaction(flightsToken, publicKey, flightTx({ category: "hotels" }), store);
    assert.equal(result.allowed, false);
  });

  test("attenuateToken rejects an application-level attempt to widen authority", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 50_000 });
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );

    assert.throws(
      () =>
        attenuateToken(
          {
            parentTokenBase64: rootToken,
            parentCaveats: rootCaveats,
            agentId: "agent-sub",
            caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 999_999 }), // wider than parent
          },
          publicKey
        ),
      /exceeds parent/
    );
  });

  test("even a block that bypasses application-level validation and asserts a wider limit cannot escape the parent's cap — the cryptographic guarantee, not just the app check", () => {
    // This test deliberately reaches past attenuateToken()'s validateAttenuation guard
    // and hand-builds a "malicious" wider block the way a buggy or compromised caller
    // might, to prove the security property holds independent of that application-level
    // check: the root's own check (<=500) is still a separate block that must
    // independently pass, because Biscuit ANDs every block's checks together.
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      {
        principalId: "principal-1",
        agentId: "agent-root",
        delegatedGoal: "Book conference travel",
        caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 50_000 }),
      },
      privateKey
    );

    const parsed = Biscuit.fromBase64(rootToken, publicKey);
    const maliciousBlock = Biscuit.block_builder();
    maliciousBlock.addCheck(
      Check.fromString("check if transaction_amount_minor_units($amt), $amt <= 999999999")
    );
    const maliciousToken = parsed.appendBlock(maliciousBlock).toBase64();

    const store = createInMemoryRevocationStore();
    const result = verifyTransaction(maliciousToken, publicKey, flightTx({ amountMinorUnits: 150_000 }), store);
    assert.equal(result.allowed, false, "a wider second block must not override the root's narrower check");
  });

  test("a delegation chain three levels deep enforces the intersection of all three", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 200_000 });
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );

    const teamCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 100_000 });
    const teamToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-team", caveats: teamCaveats },
      publicKey
    );

    const taskCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 20_000 });
    const taskToken = attenuateToken(
      { parentTokenBase64: teamToken, parentCaveats: teamCaveats, agentId: "agent-task", caveats: taskCaveats },
      publicKey
    );

    const store = createInMemoryRevocationStore();
    assert.equal(verifyTransaction(taskToken, publicKey, flightTx({ amountMinorUnits: 15_000 }), store).allowed, true);
    assert.equal(verifyTransaction(taskToken, publicKey, flightTx({ amountMinorUnits: 50_000 }), store).allowed, false);
  });
});

describe("cascading revocation", () => {
  test("revoking a root agent denies its own future transactions and every descendant's", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );
    const subCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 50_000 });
    const subToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-flights", caveats: subCaveats },
      publicKey
    );

    const store = createInMemoryRevocationStore();

    // both work before revocation
    assert.equal(verifyTransaction(rootToken, publicKey, flightTx(), store).allowed, true);
    assert.equal(verifyTransaction(subToken, publicKey, flightTx(), store).allowed, true);

    revokeAgentToken(rootToken, publicKey, store, "principal requested emergency shutdown");

    const rootResult = verifyTransaction(rootToken, publicKey, flightTx(), store);
    const subResult = verifyTransaction(subToken, publicKey, flightTx(), store);
    assert.equal(rootResult.allowed, false);
    assert.match(rootResult.reason ?? "", /revoked/);
    assert.equal(subResult.allowed, false, "sub-agent must be denied purely because its ancestor was revoked");
    assert.match(subResult.reason ?? "", /revoked/);
  });

  test("revoking a sub-agent does not affect its parent or its siblings", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );
    const flightsToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-flights", caveats: conferenceTravelCaveats({ categories: ["flights"] }) },
      publicKey
    );
    const hotelsToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-hotels", caveats: conferenceTravelCaveats({ categories: ["hotels"] }) },
      publicKey
    );

    const store = createInMemoryRevocationStore();
    revokeAgentToken(flightsToken, publicKey, store, "flights sub-agent misbehaved");

    assert.equal(verifyTransaction(flightsToken, publicKey, flightTx(), store).allowed, false);
    assert.equal(verifyTransaction(rootToken, publicKey, flightTx(), store).allowed, true, "parent must be unaffected by a child's revocation");
    assert.equal(
      verifyTransaction(hotelsToken, publicKey, flightTx({ category: "hotels" }), store).allowed,
      true,
      "sibling must be unaffected by a sibling's revocation"
    );
  });

  test("revoking a mid-chain agent cascades to its descendants but not its ancestor", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );
    const teamCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 100_000 });
    const teamToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-team", caveats: teamCaveats },
      publicKey
    );
    const taskToken = attenuateToken(
      { parentTokenBase64: teamToken, parentCaveats: teamCaveats, agentId: "agent-task", caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 20_000 }) },
      publicKey
    );

    const store = createInMemoryRevocationStore();
    revokeAgentToken(teamToken, publicKey, store, "team lead reassigned");

    assert.equal(verifyTransaction(rootToken, publicKey, flightTx(), store).allowed, true);
    assert.equal(verifyTransaction(teamToken, publicKey, flightTx(), store).allowed, false);
    assert.equal(verifyTransaction(taskToken, publicKey, flightTx(), store).allowed, false);
  });
});

describe("cryptographic integrity", () => {
  test("a tampered token fails signature verification rather than silently passing or being evaluated as a policy denial", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats() },
      privateKey
    );
    const chars = rootToken.split("");
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === "A" ? "B" : "A";
    const tampered = chars.join("");

    const store = createInMemoryRevocationStore();
    assert.throws(() => verifyTransaction(tampered, publicKey, flightTx(), store));
  });

  test("a token verified against the wrong root public key fails rather than passing", () => {
    const { privateKey } = generateRootKeyPair();
    const { publicKey: wrongPublicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats() },
      privateKey
    );

    const store = createInMemoryRevocationStore();
    assert.throws(() => verifyTransaction(rootToken, wrongPublicKey, flightTx(), store));
  });

  test("revocation identifiers are stable, one per block, and every ancestor's id is present in a descendant's list", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );
    const subToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-flights", caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 50_000 }) },
      publicKey
    );

    const rootIds = getRevocationIdentifiers(rootToken, publicKey);
    const subIds = getRevocationIdentifiers(subToken, publicKey);

    assert.equal(rootIds.length, 1);
    assert.equal(subIds.length, 2);
    assert.equal(subIds[0], rootIds[0]);
  });
});

describe("input validation", () => {
  test("rejects a caveats object with an empty category allowlist", () => {
    const { privateKey } = generateRootKeyPair();
    assert.throws(() =>
      issueRootToken(
        { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: conferenceTravelCaveats({ categories: [] }) },
        privateKey
      )
    );
  });

  test("rejects a non-integer amount cap (floats are not supported by the underlying Datalog engine — money is minor units)", () => {
    const { privateKey } = generateRootKeyPair();
    assert.throws(() =>
      issueRootToken(
        { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 199.99 }) },
        privateKey
      )
    );
  });

  test("rejects an identifier containing characters that could break out of a Datalog string literal", () => {
    const { privateKey } = generateRootKeyPair();
    assert.throws(() =>
      issueRootToken(
        { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: conferenceTravelCaveats({ categories: ['flights"); allow if true; //'] }) },
        privateKey
      )
    );
  });
});

describe("extractRootFacts — deriving principal/goal from the token itself, not a client claim", () => {
  test("recovers principalId and delegatedGoal from a root token", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: conferenceTravelCaveats() },
      privateKey
    );

    assert.deepEqual(extractRootFacts(rootToken, publicKey), {
      principalId: "principal-1",
      delegatedGoal: "Book conference travel",
    });
  });

  test("a three-level attenuated token still reads back the root's principalId and delegatedGoal exactly", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "Book conference travel", caveats: rootCaveats },
      privateKey
    );
    const teamCaveats = conferenceTravelCaveats({ maxAmountMinorUnits: 100_000 });
    const teamToken = attenuateToken(
      { parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-team", caveats: teamCaveats },
      publicKey
    );
    const taskToken = attenuateToken(
      { parentTokenBase64: teamToken, parentCaveats: teamCaveats, agentId: "agent-task", caveats: conferenceTravelCaveats({ maxAmountMinorUnits: 20_000 }) },
      publicKey
    );

    assert.deepEqual(extractRootFacts(taskToken, publicKey), {
      principalId: "principal-1",
      delegatedGoal: "Book conference travel",
    });
  });

  test("round-trips a delegated goal containing quotes, backslashes, and unicode exactly", () => {
    // This specifically exercises the query-API path rather than block-source text
    // parsing — Biscuit's getBlockSource() pretty-printer does not correctly
    // re-escape special characters (confirmed empirically while building this), so
    // extractRootFacts is implemented via query() instead, which reads the parsed
    // fact directly with no text round-trip. This test is the proof that choice
    // matters, not just style.
    const { privateKey, publicKey } = generateRootKeyPair();
    const tricky = 'Book "cheap" flights \\ hotels — do not exceed $2,000; avoid "premium" fares.';
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: tricky, caveats: conferenceTravelCaveats() },
      privateKey
    );

    assert.equal(extractRootFacts(rootToken, publicKey).delegatedGoal, tricky);
  });

  test("throws on a tampered token rather than returning a spoofable identity", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: conferenceTravelCaveats() },
      privateKey
    );
    const chars = rootToken.split("");
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === "A" ? "B" : "A";
    assert.throws(() => extractRootFacts(chars.join(""), publicKey));
  });
});

describe("getOwnRevocationId — the per-token identity handle used for API auth (see src/api/auth.ts)", () => {
  test("a root token's own id is its single block's revocation id", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: conferenceTravelCaveats() },
      privateKey
    );
    assert.equal(getOwnRevocationId(rootToken, publicKey), getRevocationIdentifiers(rootToken, publicKey)[0]);
  });

  test("distinct tokens — even attenuated from the same parent — have distinct own ids", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootCaveats = conferenceTravelCaveats();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: rootCaveats },
      privateKey
    );
    const subA = attenuateToken({ parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-a", caveats: rootCaveats }, publicKey);
    const subB = attenuateToken({ parentTokenBase64: rootToken, parentCaveats: rootCaveats, agentId: "agent-b", caveats: rootCaveats }, publicKey);

    const idRoot = getOwnRevocationId(rootToken, publicKey);
    const idA = getOwnRevocationId(subA, publicKey);
    const idB = getOwnRevocationId(subB, publicKey);
    assert.notEqual(idA, idRoot);
    assert.notEqual(idB, idRoot);
    assert.notEqual(idA, idB);
  });

  test("throws on a tampered token rather than returning a usable id", () => {
    const { privateKey, publicKey } = generateRootKeyPair();
    const rootToken = issueRootToken(
      { principalId: "principal-1", agentId: "agent-root", delegatedGoal: "x", caveats: conferenceTravelCaveats() },
      privateKey
    );
    const chars = rootToken.split("");
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === "A" ? "B" : "A";
    assert.throws(() => getOwnRevocationId(chars.join(""), publicKey));
  });
});
