/**
 * Tier-2 integration test: journal-body-anchor record (Shard M6 D
 * invariant 6 / architecture §5.2 extension 2026-05-20).
 *
 * Verifies the body-anchor crypto pin closes the equivalent of the
 * §4.5 equivocation-parity residual at the journal-body layer:
 *
 *   1. Write a journal file → emit body-anchor record (signed
 *      `{path, sha256_of_content_bytes, slot_record_ref}`).
 *   2. Re-hash the file in-place via the fold predicate — verifies
 *      `accepted: true, tampered: false` on the unchanged body.
 *   3. Tamper with the file body (simulating a bounded-trust insider
 *      with disk access who rewrites a body without re-signing).
 *   4. Re-fold — verifies the predicate now returns `tampered: true`
 *      with `expected` vs `actual` hashes in the evidence field, AND
 *      that the original anchor record is still `accepted: true`
 *      (the detection is the value, NOT rejection of the anchor).
 *
 * Per probe-driven-verification.md Rule 3: structural assertions —
 * sha256 string match, JSON parse of predicate verdict, file existence.
 * No mocking — real fs + real crypto module + real predicate.
 *
 * Per zero-tolerance.md Rule 3: typed-error branches verified.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ANCHOR_LIB = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "journal-body-anchor.js",
);

const {
  RECORD_TYPE,
  hashJournalBody,
  buildAnchorRecord,
  foldAnchorPredicate,
} = require(ANCHOR_LIB);

function mkTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m6d-anchor-"));
  fs.mkdirSync(path.join(dir, "journal"), { recursive: true });
  return dir;
}

function writeJournal(repoDir, relPath, body) {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test("RECORD_TYPE constant exposed for downstream consumers", () => {
  assert.equal(RECORD_TYPE, "journal-body-anchor");
});

test("hashJournalBody returns sha256:<hex> prefix + 64-hex hash", () => {
  const dir = mkTempRepo();
  try {
    const full = writeJournal(
      dir,
      "journal/0001-DECISION-test.md",
      "# Decision\nbody content\n",
    );
    const h = hashJournalBody(full);
    assert.match(h, /^sha256:[0-9a-f]{64}$/);
  } finally {
    cleanup(dir);
  }
});

test("hashJournalBody — typed error on bad input", () => {
  assert.throws(() => hashJournalBody(""), /non-empty string/);
  assert.throws(() => hashJournalBody(null), /non-empty string/);
});

test("buildAnchorRecord — produces correct record shape with stamped hash", () => {
  const dir = mkTempRepo();
  try {
    const relPath = "journal/0001-DECISION-test.md";
    const full = writeJournal(dir, relPath, "body for anchor\n");
    const result = buildAnchorRecord({
      journalPath: full,
      relPath,
      slotRecordRef: "rec-42",
    });
    assert.equal(result.type, "journal-body-anchor");
    assert.equal(result.content.path, relPath);
    assert.match(
      result.content.sha256_of_content_bytes,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(result.content.slot_record_ref, "rec-42");
  } finally {
    cleanup(dir);
  }
});

test("buildAnchorRecord — typed errors on bad input", () => {
  assert.throws(() => buildAnchorRecord(null), /must be an object/);
  assert.throws(() => buildAnchorRecord({}), /journalPath/);
  assert.throws(() => buildAnchorRecord({ journalPath: "/tmp/x" }), /relPath/);
});

test("foldAnchorPredicate — accepts unchanged body, tampered:false", () => {
  const dir = mkTempRepo();
  try {
    const relPath = "journal/0001-DECISION-test.md";
    const full = writeJournal(dir, relPath, "unchanged body\n");
    const rec = buildAnchorRecord({ journalPath: full, relPath });
    // Build the candidate record the predicate will see at fold time.
    const candidate = { type: rec.type, content: rec.content };
    const verdict = foldAnchorPredicate(candidate, { repoDir: dir });
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.tampered, false);
  } finally {
    cleanup(dir);
  }
});

test("foldAnchorPredicate — tamper-detected on body rewrite (the load-bearing case)", () => {
  // The structural defense against bounded-trust insider rewrites:
  // anchor at time T1 with content C1, then attacker rewrites file
  // body to C2 at T2. The fold predicate at T3 re-hashes the file
  // and surfaces tamper:true with both expected + actual hashes.
  const dir = mkTempRepo();
  try {
    const relPath = "journal/0001-DECISION-tamper.md";
    const full = writeJournal(dir, relPath, "original body\n");
    const rec = buildAnchorRecord({ journalPath: full, relPath });
    // Tamper.
    fs.writeFileSync(full, "ATTACKER REWROTE THIS\n");
    const candidate = { type: rec.type, content: rec.content };
    const verdict = foldAnchorPredicate(candidate, { repoDir: dir });
    // Critically: the anchor record is STILL accepted (it IS the
    // detection evidence — owner-accountability via the chain) but
    // tampered=true.
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.tampered, true);
    assert.match(verdict.evidence.expected, /^sha256:[0-9a-f]{64}$/);
    assert.match(verdict.evidence.actual, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(verdict.evidence.expected, verdict.evidence.actual);
    assert.equal(verdict.evidence.path, relPath);
  } finally {
    cleanup(dir);
  }
});

test("foldAnchorPredicate — missing file at fold time is accepted with advisory", () => {
  const dir = mkTempRepo();
  try {
    const relPath = "journal/0001-DECISION-deleted.md";
    const full = writeJournal(dir, relPath, "soon to be deleted\n");
    const rec = buildAnchorRecord({ journalPath: full, relPath });
    fs.unlinkSync(full);
    const verdict = foldAnchorPredicate(
      { type: rec.type, content: rec.content },
      { repoDir: dir },
    );
    // Per architecture §4.5: deletion is folded-accepted with advisory.
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.tampered, false);
    assert.match(verdict.reason, /absent at fold time/);
  } finally {
    cleanup(dir);
  }
});

test("foldAnchorPredicate — rejects malformed record with typed reason", () => {
  const v1 = foldAnchorPredicate(null, {});
  assert.equal(v1.accepted, false);
  assert.match(v1.reason, /not a journal-body-anchor/);

  const v2 = foldAnchorPredicate(
    { type: "journal-body-anchor", content: null },
    {},
  );
  assert.equal(v2.accepted, false);
  assert.match(v2.reason, /missing or malformed content/);

  const v3 = foldAnchorPredicate(
    { type: "journal-body-anchor", content: { path: "x" } },
    {},
  );
  assert.equal(v3.accepted, false);
  assert.match(v3.reason, /sha256_of_content_bytes/);

  const v4 = foldAnchorPredicate(
    {
      type: "journal-body-anchor",
      content: { path: "x", sha256_of_content_bytes: "not-a-hash" },
    },
    {},
  );
  assert.equal(v4.accepted, false);
  assert.match(v4.reason, /sha256_of_content_bytes/);
});

test("foldAnchorPredicate — no repoDir in ctx accepts structurally-only", () => {
  // Unit-test path: when ctx lacks repoDir the predicate cannot re-hash
  // but accepts the structurally-valid record with a reason marker.
  const dir = mkTempRepo();
  try {
    const relPath = "journal/0001-DECISION-test.md";
    const full = writeJournal(dir, relPath, "body\n");
    const rec = buildAnchorRecord({ journalPath: full, relPath });
    const v = foldAnchorPredicate({ type: rec.type, content: rec.content }, {});
    assert.equal(v.accepted, true);
    assert.match(v.reason, /no repoDir/);
  } finally {
    cleanup(dir);
  }
});
