/**
 * Golden fixtures: real content hashes and Ed25519 signatures produced ONCE by
 * actually running Aegis's real, unmodified production code
 * (src/state/crypto.ts's stableStringify/sha256Hex/sign, via a throwaway script
 * deleted immediately after use — never checked in). Hardcoded here as static data
 * so verifier/canonical.ts's independent reimplementation can be proven to agree with
 * production byte-for-byte, without importing production code at test time.
 *
 * The keypair below is a fixture-only, throwaway Ed25519 keypair generated for this
 * purpose alone — it has never signed a real Aegis ledger entry and grants no real
 * authority.
 */

export const GOLDEN_PUBLIC_KEY_HEX =
  "302a300506032b6570032100a968f1c82977dfd254dc9a4f734e5ea68a21de78168922776063fc3e352c0dc3";

export interface GoldenCase {
  name: string;
  kind: string;
  agentId: string;
  principalId: string;
  data: unknown;
  createdAt: string;
  prevHash: string;
  contentHash: string;
  signature: string;
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: "simple_primitives",
    kind: "agent_registered",
    agentId: "agent-1",
    principalId: "principal-1",
    data: { delegatedGoal: "Book travel", maxAmountMinorUnits: 200000, active: true, note: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
    contentHash: "b0d7791677286588c01801a990b8d2abe1315b7faaf1c8965ef7527d47ba55f2",
    signature:
      "6c74e70eee8814bc9df0fba9f4aed59e595a39912c8b31067ce455d7ee9e3eaea1419bd77acace4202dd449ef5c285c8c18e9a05cdf6ca8c7c1dfbe907f1980b",
  },
  {
    // Same logical data as "simple_primitives", keys inserted in a DIFFERENT order —
    // must produce the IDENTICAL contentHash/signature, proving recursive key sorting.
    name: "unsorted_keys_must_canonicalize_same",
    kind: "agent_registered",
    agentId: "agent-1",
    principalId: "principal-1",
    data: { note: null, active: true, maxAmountMinorUnits: 200000, delegatedGoal: "Book travel" },
    createdAt: "2026-01-01T00:00:00.000Z",
    prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
    contentHash: "b0d7791677286588c01801a990b8d2abe1315b7faaf1c8965ef7527d47ba55f2",
    signature:
      "6c74e70eee8814bc9df0fba9f4aed59e595a39912c8b31067ce455d7ee9e3eaea1419bd77acace4202dd449ef5c285c8c18e9a05cdf6ca8c7c1dfbe907f1980b",
  },
  {
    name: "nested_objects_and_arrays",
    kind: "mission_created",
    agentId: "agent-2",
    principalId: "principal-1",
    data: {
      missionId: "mission-1",
      budgetMinorUnits: 200000,
      currency: "USD",
      allowedCategories: ["flights", "hotels", "software"],
      approvedCounterparties: null,
      nested: { z: 1, a: [3, 2, 1], m: { inner: true } },
    },
    createdAt: "2026-01-02T00:00:00.000Z",
    prevHash: "abc123",
    contentHash: "75138972a07eeae647ce8e5deb932d827066d6e07f34727d606c03909e1b6663",
    signature:
      "6f41830af77e768952fdbe7251ada1ac413509225faab4bce600264142a9a1a1bda1ed314d44d145576d72b33cc9e62b2d24989d15d9b27b0bfc05e95a7f150b",
  },
  {
    name: "non_ascii_keys_and_values",
    kind: "policy_verdict",
    agentId: "agent-3",
    principalId: "principal-1",
    data: { "café": "Zürich", "名前": "エージェント", emoji: "🔒", note: "naïve résumé" },
    createdAt: "2026-01-03T00:00:00.000Z",
    prevHash: "def456",
    contentHash: "8b1e80fbe5ff8cce0135be0c4e94da1791d57b19412cddfa6be97695f2415574",
    signature:
      "90d9e8ee0e838e52d4bfc3fd6d192041887fcf11bad6460139437d88df1aa81c79413210ba8d3a5ec3db71263d57b3521d39bc1b52f781c2b7b86974d1a55803",
  },
  {
    name: "numbers_edge_cases",
    kind: "risk_verdict",
    agentId: "agent-4",
    principalId: "principal-1",
    data: { zero: 0, negative: -42, float: 3.14159, large: 9007199254740991, tiny: 0.0001 },
    createdAt: "2026-01-04T00:00:00.000Z",
    prevHash: "ghi789",
    contentHash: "42a8d587b940190980020836636a1cd519a147498ecd2f49729af79ac5fa2f7d",
    signature:
      "0141b56443d87bd4183de5daa1410cb8f7a69c04c347246987861dd977fdfdf2efcbf36755bfe1d44f71548644730145ea15ea82cd77dc636af3d72407ce4504",
  },
  {
    name: "empty_object_and_array",
    kind: "mission_pipeline_outcome",
    agentId: "agent-5",
    principalId: "principal-1",
    data: { empty: {}, emptyArr: [], list: [{}, { x: 1 }] },
    createdAt: "2026-01-05T00:00:00.000Z",
    prevHash: "jkl012",
    contentHash: "abf5696882a7141a3244d12c977d527d33b3b7d41515263c71a6be8cddd35d52",
    signature:
      "4fbb602b2e3314fc25963945dddc5a8832c1033a4e7d4f313dcf0a3e27ffc21b30c7d177f855581b4bf1a2308ee52c68db81a79eca49fee6668007db3b5fe701",
  },
];
