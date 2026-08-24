import type { Caveats } from "./types.js";

/**
 * Plain-identifier validation for anything that gets interpolated into a Datalog
 * source string (currency codes, category names, rail names, agent/principal ids).
 * This is the defense-in-depth boundary: because every such value is checked against
 * this allowlist *before* it ever touches a template string, none of them can contain
 * a quote character or anything else that could alter the structure of the generated
 * check. Free text (e.g. a delegated goal) is handled separately by
 * `escapeDatalogString`, below, and is never used inside an enforcement check — only
 * as an informational fact.
 */
const IDENTIFIER_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;

export function assertValidIdentifier(value: string, field: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${field}: "${value}" must match ${IDENTIFIER_RE} (max 64 chars, alphanumeric/._:- only)`
    );
  }
}

/** Escapes free text for safe use inside a Datalog double-quoted string literal (facts only, never checks). */
export function escapeDatalogString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Biscuit's Datalog engine (as shipped by @biscuit-auth/biscuit-wasm 0.6.0-beta.1)
 * only supports integer number literals — decimal/float literals fail to parse.
 * This is why money is represented as integer minor units throughout this module.
 */
function assertValidMinorUnits(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field}: must be a positive integer (minor units, e.g. cents)`);
  }
}

/** Biscuit date literals are bare RFC3339 (no surrounding quotes), e.g. 2026-12-31T00:00:00Z. */
function toDatalogTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid timestamp: "${iso}" is not a valid ISO 8601 date`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function validateCaveats(c: Caveats): void {
  assertValidMinorUnits(c.maxAmountMinorUnits, "caveats.maxAmountMinorUnits");
  assertValidIdentifier(c.currency, "caveats.currency");
  if (c.categories.length === 0) {
    throw new Error("caveats.categories must contain at least one entry");
  }
  c.categories.forEach((cat) => assertValidIdentifier(cat, "caveats.categories[]"));
  if (c.rails.length === 0) {
    throw new Error("caveats.rails must contain at least one entry");
  }
  c.rails.forEach((r) => assertValidIdentifier(r, "caveats.rails[]"));
  toDatalogTimestamp(c.expiresAt); // throws if invalid
}

/**
 * Fast-fail, application-level check that a proposed sub-agent's caveats do not
 * exceed its parent's in any dimension. This is a convenience for a clear error
 * message at issuance time — it is NOT the security boundary. The security
 * boundary is the cryptographic fact that every ancestor block's checks remain in
 * the token and are ANDed together at verification time (see authorize.ts and the
 * "widening" test in the test suite), so even a caller that bypassed this function
 * could never produce a token with broader effective authority than its parent.
 */
export function validateAttenuation(parent: Caveats, child: Caveats): void {
  if (child.maxAmountMinorUnits > parent.maxAmountMinorUnits) {
    throw new Error(
      `Attenuation error: child maxAmountMinorUnits (${child.maxAmountMinorUnits}) exceeds parent's (${parent.maxAmountMinorUnits})`
    );
  }
  if (child.currency !== parent.currency) {
    throw new Error(
      `Attenuation error: child currency (${child.currency}) must match parent's (${parent.currency})`
    );
  }
  const parentCategories = new Set(parent.categories);
  for (const cat of child.categories) {
    if (!parentCategories.has(cat)) {
      throw new Error(`Attenuation error: child category "${cat}" is not in the parent's allowlist`);
    }
  }
  const parentRails = new Set(parent.rails);
  for (const rail of child.rails) {
    if (!parentRails.has(rail)) {
      throw new Error(`Attenuation error: child rail "${rail}" is not in the parent's allowlist`);
    }
  }
  if (new Date(child.expiresAt).getTime() > new Date(parent.expiresAt).getTime()) {
    throw new Error(
      `Attenuation error: child expiresAt (${child.expiresAt}) is later than parent's (${parent.expiresAt})`
    );
  }
}

/**
 * Compiles a Caveats object into Biscuit check-source strings.
 *
 * Each check binds its literal bound directly against a fact the *authorizer*
 * supplies at verification time (transaction_amount_minor_units, transaction_currency,
 * category, rail, transaction_time) — never against a same-named fact stored inside
 * the token itself. This matters: a check of the shape
 * `check if spend_limit($x), $x <= 500` is exploitable, because Datalog checks are
 * existentially satisfied — if two different blocks each declared their own
 * `spend_limit(...)` fact, the check would pass as long as *any* declared value
 * satisfied it, not the most restrictive one. Binding against a single
 * authorizer-supplied fact with a literal, per-block constant instead means every
 * block's check is independently required to hold (checks are ANDed across blocks),
 * so the effective limit is always the *minimum* across the whole ancestry chain —
 * which is exactly the attenuation-only guarantee this system depends on. This was
 * verified empirically, not assumed; see the test suite's "cannot widen via a second
 * block" case.
 */
export function buildCaveatChecks(c: Caveats): string[] {
  validateCaveats(c);
  const categoryDisjuncts = c.categories
    .map((cat) => `category($c), $c == "${cat}"`)
    .join(" or ");
  const railDisjuncts = c.rails.map((r) => `rail($r), $r == "${r}"`).join(" or ");
  return [
    `check if transaction_amount_minor_units($amt), $amt <= ${c.maxAmountMinorUnits}`,
    `check if transaction_currency($cur), $cur == "${c.currency}"`,
    `check if ${categoryDisjuncts}`,
    `check if ${railDisjuncts}`,
    `check if transaction_time($t), $t <= ${toDatalogTimestamp(c.expiresAt)}`,
  ];
}
