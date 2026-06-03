/**
 * Tier-2 integration test: computeOwnChainHead parity with the sessionend
 * duplicated implementation (R8-LOW-2 SSOT verification).
 *
 * Shard M6 D Step 1 — verifies the public `computeOwnChainHead(folded,
 * ownVerifiedId)` helper exposed from `coordination-log.js` produces the
 * same `{lastSeq, lastContentHash}` pair as `multi-operator-sessionend.js`'s
 * inline copy (lines 231-265). When sessionend later switches to the
 * helper (Step 4a, R8-LOW-2 consumer), this test locks behavioral parity
 * so the refactor cannot silently drift.
 *
 * Per probe-driven-verification.md Rule 3: assertions are structural —
 * deep-equal on the returned object, byte-equality on the contentHash hex
 * string. Per testing.md Tier 2: real coc-sign canonical-serialize, real
 * SHA-256 hashing; no mocking.
 *
 * Per zero-tolerance.md Rule 3a: typed-error guards on helper inputs are
 * verified by asserting `null` returns on bad inputs (null folded, missing
 * ownVerifiedId, no matching records).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const COORDINATION_LOG = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "coordination-log.js",
);
const COC_SIGN = path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js");

const { computeOwnChainHead } = require(COORDINATION_LOG);
const { canonicalSerialize } = require(COC_SIGN);

// Reference implementation — byte-identical to multi-operator-sessionend.js
// lines 231-265 prior to the R8-LOW-2 consumer migration. The shared helper
// MUST agree with this reference on every fold/ownVerifiedId pair.
function referenceComputeOwnChainHead(folded, ownVerifiedId) {
  if (!folded || !ownVerifiedId) return null;
  const records =
    process.env.COC_TEST_SKIP_SIGN === "1"
      ? folded.rawRecords || folded.accepted
      : folded.accepted;
  if (!Array.isArray(records)) return null;
  let head = null;
  for (const r of records) {
    if (!r || r.verified_id !== ownVerifiedId) continue;
    if (typeof r.seq !== "number") continue;
    if (!head || r.seq > head.seq) head = r;
  }
  if (!head) return null;
  try {
    const { sig: _s, ...core } = head;
    const bytes = canonicalSerialize(core);
    const lastContentHash = crypto
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    return { lastSeq: head.seq, lastContentHash };
  } catch {
    return null;
  }
}

function makeRecord({ verified_id, person_id, seq, content, sig }) {
  return {
    type: "claim",
    verified_id,
    person_id,
    seq,
    ts: new Date().toISOString(),
    content: content || { claim_id: `claim-${seq}` },
    sig: sig || `sig-stub-${verified_id}-${seq}`,
  };
}

test("computeOwnChainHead — null folded returns null", () => {
  assert.equal(computeOwnChainHead(null, "fp-alice"), null);
  assert.equal(computeOwnChainHead(undefined, "fp-alice"), null);
});

test("computeOwnChainHead — missing ownVerifiedId returns null", () => {
  const folded = {
    accepted: [
      makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 0 }),
    ],
  };
  assert.equal(computeOwnChainHead(folded, null), null);
  assert.equal(computeOwnChainHead(folded, ""), null);
  assert.equal(computeOwnChainHead(folded, undefined), null);
});

test("computeOwnChainHead — no records for ownVerifiedId returns null", () => {
  const folded = {
    accepted: [
      makeRecord({ verified_id: "fp-bob", person_id: "bob", seq: 0 }),
      makeRecord({ verified_id: "fp-bob", person_id: "bob", seq: 1 }),
    ],
  };
  assert.equal(computeOwnChainHead(folded, "fp-alice"), null);
});

test("computeOwnChainHead — single own record returns that record's head", () => {
  const recs = [
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 7 }),
    makeRecord({ verified_id: "fp-bob", person_id: "bob", seq: 12 }),
  ];
  const folded = { accepted: recs };
  const helperResult = computeOwnChainHead(folded, "fp-alice");
  const refResult = referenceComputeOwnChainHead(folded, "fp-alice");
  assert.deepEqual(helperResult, refResult, "helper must match reference");
  assert.equal(helperResult.lastSeq, 7);
  assert.match(helperResult.lastContentHash, /^[0-9a-f]{64}$/);
});

test("computeOwnChainHead — picks highest seq among own records (parity with sessionend)", () => {
  const recs = [
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 3 }),
    makeRecord({ verified_id: "fp-bob", person_id: "bob", seq: 99 }),
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 5 }),
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 4 }),
  ];
  const folded = { accepted: recs };
  const helperResult = computeOwnChainHead(folded, "fp-alice");
  const refResult = referenceComputeOwnChainHead(folded, "fp-alice");
  assert.deepEqual(
    helperResult,
    refResult,
    "helper must produce byte-identical result to sessionend's inline copy",
  );
  assert.equal(helperResult.lastSeq, 5);
});

test("computeOwnChainHead — skip-sign mode reads rawRecords (test override path)", () => {
  // Simulate the COC_TEST_SKIP_SIGN=1 branch where unsigned stubs land in
  // folded.rawRecords (because fold rule 1 rejects them from .accepted).
  const rawRecs = [
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 0 }),
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 1 }),
  ];
  const folded = { accepted: [], rawRecords: rawRecs };
  const prior = process.env.COC_TEST_SKIP_SIGN;
  process.env.COC_TEST_SKIP_SIGN = "1";
  try {
    const helperResult = computeOwnChainHead(folded, "fp-alice");
    const refResult = referenceComputeOwnChainHead(folded, "fp-alice");
    assert.deepEqual(
      helperResult,
      refResult,
      "skip-sign branch must read rawRecords, matching sessionend's branch",
    );
    assert.equal(helperResult.lastSeq, 1);
  } finally {
    if (prior === undefined) delete process.env.COC_TEST_SKIP_SIGN;
    else process.env.COC_TEST_SKIP_SIGN = prior;
  }
});

test("computeOwnChainHead — non-array records returns null", () => {
  assert.equal(computeOwnChainHead({ accepted: null }, "fp-alice"), null);
  assert.equal(
    computeOwnChainHead({ accepted: "not-array" }, "fp-alice"),
    null,
  );
  assert.equal(computeOwnChainHead({}, "fp-alice"), null);
});

test("computeOwnChainHead — records without numeric seq are skipped (R8-LOW-2 parity)", () => {
  const recs = [
    { verified_id: "fp-alice", person_id: "alice" }, // no seq
    makeRecord({ verified_id: "fp-alice", person_id: "alice", seq: 2 }),
    { verified_id: "fp-alice", person_id: "alice", seq: "not-a-number" },
  ];
  const folded = { accepted: recs };
  const helperResult = computeOwnChainHead(folded, "fp-alice");
  const refResult = referenceComputeOwnChainHead(folded, "fp-alice");
  assert.deepEqual(helperResult, refResult);
  assert.equal(helperResult.lastSeq, 2);
});
