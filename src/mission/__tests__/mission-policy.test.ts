import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateMissionAgainstToken, checkMissionGate } from "../policy.js";
import type { Caveats } from "../../capability/types.js";
import type { MissionRecord, MissionRecordInput } from "../../state/missions.js";
import type { MissionCandidateTransaction } from "../types.js";

const ONE_YEAR_FROM_NOW = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const SIX_MONTHS_FROM_NOW = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000).toISOString();
const ONE_YEAR_AND_A_DAY_FROM_NOW = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString();

function tokenCaveats(overrides: Partial<Caveats> = {}): Caveats {
  return {
    maxAmountMinorUnits: 50_000,
    currency: "INR",
    categories: ["api_credits", "software"],
    rails: ["stripe_test", "mock_x402"],
    expiresAt: ONE_YEAR_FROM_NOW,
    ...overrides,
  };
}

function missionInput(
  overrides: Partial<Pick<MissionRecordInput, "currency" | "allowedCategories" | "expiresAt">> = {}
): Pick<MissionRecordInput, "currency" | "allowedCategories" | "expiresAt"> {
  return {
    currency: "INR",
    allowedCategories: ["api_credits"],
    expiresAt: SIX_MONTHS_FROM_NOW,
    ...overrides,
  };
}

describe("validateMissionAgainstToken — a mission may only narrow a token, never widen it", () => {
  test("a mission strictly narrower than its token in every dimension is accepted (does not throw)", () => {
    assert.doesNotThrow(() => validateMissionAgainstToken(missionInput(), tokenCaveats()));
  });

  test("allowedCategories: null (no narrowing beyond the token) is always accepted, regardless of the token's own categories", () => {
    assert.doesNotThrow(() => validateMissionAgainstToken(missionInput({ allowedCategories: null }), tokenCaveats()));
  });

  test("allowedCategories: [] (narrower than everything) is accepted — an empty set is a trivial subset, not a widening", () => {
    assert.doesNotThrow(() => validateMissionAgainstToken(missionInput({ allowedCategories: [] }), tokenCaveats()));
  });

  test("ADVERSARIAL: a mission requesting a single category the token never granted is rejected", () => {
    assert.throws(
      () => validateMissionAgainstToken(missionInput({ allowedCategories: ["gift_cards"] }), tokenCaveats()),
      /category "gift_cards" is not in the agent token's allowed categories/
    );
  });

  test("ADVERSARIAL: a mission mixing one legitimate category with one the token never granted is still rejected — partial widening is still widening", () => {
    assert.throws(() =>
      validateMissionAgainstToken(missionInput({ allowedCategories: ["api_credits", "gift_cards"] }), tokenCaveats())
    );
  });

  test("ADVERSARIAL: a mission attempting to claim every category the token has PLUS one more is rejected, not silently truncated to the valid subset", () => {
    assert.throws(() =>
      validateMissionAgainstToken(
        missionInput({ allowedCategories: ["api_credits", "software", "unauthorized_category"] }),
        tokenCaveats()
      )
    );
  });

  test("ADVERSARIAL: a mission whose currency does not match the token's currency is rejected, even if every other dimension is narrower", () => {
    assert.throws(
      () => validateMissionAgainstToken(missionInput({ currency: "USD" }), tokenCaveats({ currency: "INR" })),
      /currency \(USD\) must match the agent token's currency \(INR\)/
    );
  });

  test("ADVERSARIAL: a mission whose expiresAt is later than the token's expiresAt is rejected", () => {
    assert.throws(
      () =>
        validateMissionAgainstToken(
          missionInput({ expiresAt: ONE_YEAR_AND_A_DAY_FROM_NOW }),
          tokenCaveats({ expiresAt: ONE_YEAR_FROM_NOW })
        ),
      /expiresAt .* is later than the agent token's expiresAt/
    );
  });

  test("a mission whose expiresAt is exactly equal to the token's expiresAt is accepted (boundary: equal is not 'later than')", () => {
    assert.doesNotThrow(() =>
      validateMissionAgainstToken(missionInput({ expiresAt: ONE_YEAR_FROM_NOW }), tokenCaveats({ expiresAt: ONE_YEAR_FROM_NOW }))
    );
  });

  test("a mission whose expiresAt is earlier than the token's expiresAt is accepted", () => {
    assert.doesNotThrow(() =>
      validateMissionAgainstToken(missionInput({ expiresAt: SIX_MONTHS_FROM_NOW }), tokenCaveats({ expiresAt: ONE_YEAR_FROM_NOW }))
    );
  });

  test("a mission's cumulative budgetMinorUnits exceeding the token's PER-TRANSACTION maxAmountMinorUnits ceiling is not itself a widening — these are different dimensions, and this function has no opinion about budget at all", () => {
    // A ₹2,000 cumulative mission budget against a token whose single-transaction
    // ceiling is only ₹500 is completely normal: the mission is meant to be spent
    // across multiple transactions, each still separately bounded by the token's own
    // per-transaction check at execution time (unchanged, untouched by this module).
    assert.doesNotThrow(() =>
      validateMissionAgainstToken(missionInput(), tokenCaveats({ maxAmountMinorUnits: 5_000 }))
    );
  });
});

function activeMission(overrides: Partial<Pick<MissionRecord, "status" | "approvedCounterparties" | "allowedCategories" | "budgetMinorUnits">> = {}) {
  return {
    status: "active" as const,
    approvedCounterparties: ["cloudcredits-vendor"],
    allowedCategories: ["api_credits"],
    budgetMinorUnits: 200_000,
    ...overrides,
  };
}

function candidate(overrides: Partial<MissionCandidateTransaction> = {}): MissionCandidateTransaction {
  return {
    amountMinorUnits: 180_000,
    category: "api_credits",
    counterparty: "cloudcredits-vendor",
    ...overrides,
  };
}

describe("checkMissionGate — happy path and boundary", () => {
  test("an in-budget, approved-counterparty, allowed-category candidate is allowed", () => {
    assert.deepEqual(checkMissionGate(activeMission(), candidate(), 0), { allowed: true });
  });

  test("spentSoFar + amount landing EXACTLY on the budget is allowed — only strictly exceeding it denies", () => {
    const result = checkMissionGate(activeMission({ budgetMinorUnits: 200_000 }), candidate({ amountMinorUnits: 200_000 }), 0);
    assert.equal(result.allowed, true);
  });

  test("approvedCounterparties: null permits any counterparty (no narrowing beyond the token on this dimension)", () => {
    const result = checkMissionGate(activeMission({ approvedCounterparties: null }), candidate({ counterparty: "anyone-at-all" }), 0);
    assert.equal(result.allowed, true);
  });

  test("allowedCategories: null permits any category (no narrowing beyond the token on this dimension)", () => {
    const result = checkMissionGate(activeMission({ allowedCategories: null }), candidate({ category: "anything" }), 0);
    assert.equal(result.allowed, true);
  });

  test("the function is pure: identical inputs always produce an identical, deepEqual result across repeated calls", () => {
    const mission = activeMission();
    const tx = candidate();
    const first = checkMissionGate(mission, tx, 50_000);
    const second = checkMissionGate(mission, tx, 50_000);
    const third = checkMissionGate(mission, tx, 50_000);
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
  });
});

describe("checkMissionGate — adversarial: non-active status always denies", () => {
  for (const status of ["completed", "cancelled", "expired"] as const) {
    test(`status "${status}" denies even an otherwise perfectly valid candidate transaction`, () => {
      const result = checkMissionGate(activeMission({ status }), candidate(), 0);
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? "", new RegExp(`status: "${status}"`));
    });
  }

  test("ADVERSARIAL: non-active status is reported even when the candidate ALSO violates counterparty, category, and budget simultaneously — status is checked first and short-circuits everything else", () => {
    const result = checkMissionGate(
      activeMission({ status: "completed" }),
      candidate({ counterparty: "unapproved-vendor", category: "gift_cards", amountMinorUnits: 999_999_999 }),
      0
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /status/);
  });
});

describe("checkMissionGate — adversarial: unauthorized counterparty", () => {
  test("a counterparty not in the approved list denies, with a reason naming the rejected counterparty", () => {
    const result = checkMissionGate(activeMission(), candidate({ counterparty: "shady-marketplace" }), 0);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /shady-marketplace/);
    assert.match(result.reason ?? "", /not in this mission's approved counterparties/);
  });

  test("ADVERSARIAL: an unapproved counterparty is denied even when the amount is well within budget and the category is allowed — a technically-cheap, technically-in-category purchase from the wrong vendor must not slip through", () => {
    const result = checkMissionGate(activeMission(), candidate({ counterparty: "shady-marketplace", amountMinorUnits: 1 }), 0);
    assert.equal(result.allowed, false);
  });

  test("counterparty check precedes the category check: a candidate failing BOTH reports the counterparty reason, not the category reason", () => {
    const result = checkMissionGate(
      activeMission(),
      candidate({ counterparty: "shady-marketplace", category: "gift_cards" }),
      0
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /counterparties/);
  });
});

describe("checkMissionGate — adversarial: unauthorized category", () => {
  test("a category not in the allowed list denies, with a reason naming the rejected category", () => {
    const result = checkMissionGate(activeMission(), candidate({ category: "gift_cards" }), 0);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /gift_cards/);
    assert.match(result.reason ?? "", /not in this mission's allowed categories/);
  });

  test("category check precedes the budget check: a candidate failing BOTH reports the category reason, not the budget reason", () => {
    const result = checkMissionGate(
      activeMission({ budgetMinorUnits: 100 }),
      candidate({ category: "gift_cards", amountMinorUnits: 999_999 }),
      0
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /categories/);
  });
});

describe("checkMissionGate — adversarial: cumulative budget", () => {
  test("spentSoFar + amount exceeding the budget by even 1 minor unit denies", () => {
    const result = checkMissionGate(activeMission({ budgetMinorUnits: 200_000 }), candidate({ amountMinorUnits: 1 }), 200_000);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /exceed this mission's budget/);
  });

  test("a mission whose spentSoFar has already, somehow, exceeded its budget denies any further spend at all, including a nominal 1-unit request", () => {
    const result = checkMissionGate(activeMission({ budgetMinorUnits: 200_000 }), candidate({ amountMinorUnits: 1 }), 250_000);
    assert.equal(result.allowed, false);
  });

  test("splitting a would-be-denied purchase into two smaller candidates does not itself bypass the cap: the second call, given the correct cumulative spentSoFar, still denies once the running total would exceed budget", () => {
    const mission = activeMission({ budgetMinorUnits: 200_000 });
    const first = checkMissionGate(mission, candidate({ amountMinorUnits: 150_000 }), 0);
    assert.equal(first.allowed, true);
    // Caller is responsible for feeding the updated spentSoFar back in (derived from
    // the ledger in a later step) — this test proves the function itself enforces the
    // cap correctly given that accounting, not that it tracks state internally (it must
    // not, to remain pure).
    const second = checkMissionGate(mission, candidate({ amountMinorUnits: 60_000 }), 150_000);
    assert.equal(second.allowed, false);
  });
});
