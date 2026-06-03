/**
 * Tier-2 integration test: coc-append.js refuse-on-overflow contract
 * (Shard M6 D, Sec-LOW-2).
 *
 * Verifies that appendStamped REFUSES oversized records before signing
 * rather than truncating evidence AFTER signing. The prior behavior
 * signed the original record bytes, then mutated record.evidence /
 * dropped fields to fit MAX_LINE_BYTES — but the signature was over
 * pre-truncation bytes, so a verifier re-canonicalizing the parsed
 * line would compute different bytes and the signature would fail to
 * verify.
 *
 * Two structural assertions per probe-driven-verification.md Rule 3:
 *   (a) overflow → typed {ok:false, reason:"exceeds-..."} return; file
 *       is NOT written.
 *   (b) signed line ≤ MAX_LINE_BYTES → record on disk passes the
 *       signature-verification round-trip (parse line → strip sig →
 *       canonicalSerialize → verify against stored sig).
 *
 * Tier-2 discipline: real filesystem, real canonicalSerialize, caller-
 * injected stub signer (deterministic) so the test does not depend on
 * a real SSH/GPG key being present in the test environment. The stub
 * IS a Protocol-Satisfying Deterministic Adapter per testing.md Tier-2
 * exception — it satisfies the sign(bytes, opts) → {ok, sig} contract
 * with deterministic output, NOT a mock of state.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APPEND_LIB = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "coc-append.js",
);
const SIGN_LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js");

const { appendStamped, MAX_LINE_BYTES } = require(APPEND_LIB);
const { canonicalSerialize } = require(SIGN_LIB);

function mkTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `m6d-append-${label}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Deterministic stub signer — emits a sha256 hex digest of the bytes.
// Satisfies the sign(bytes, opts) → {ok, sig} contract; the round-trip
// test re-canonicalizes (record - sig) and recomputes the sha256 to
// confirm the on-disk bytes match the signed bytes.
function stubSigner(bytes /* , opts */) {
  const sig = crypto.createHash("sha256").update(bytes).digest("hex");
  return { ok: true, sig };
}

const IDENTITY = {
  display_id: "alice",
  person_id: "alice-p",
  verified_id: "fp-alice",
};

test("Sec-LOW-2: appendStamped refuses oversized records before signing", () => {
  const dir = mkTempDir("overflow");
  try {
    const logPath = path.join(dir, "violations.jsonl");
    // Build a partial record whose evidence pushes the serialized line
    // well past MAX_LINE_BYTES (2048). 4096 chars of evidence + the
    // prefix fields well exceed the cap.
    const huge = "x".repeat(4096);
    const result = appendStamped(
      dir,
      logPath,
      { kind: "test-overflow", evidence: huge },
      { identity: IDENTITY, sign: stubSigner },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /record too large/);
    assert.match(result.reason, /exceeds.*MAX_LINE_BYTES/i);
    // Structural shape per the contract: size + max present, typed.
    assert.equal(typeof result.size, "number");
    assert.equal(result.max, MAX_LINE_BYTES);
    // Refusal MUST NOT write the file (no partial state on disk).
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    cleanup(dir);
  }
});

test("Sec-LOW-2: appendStamped writes when under cap; signed bytes match disk bytes", () => {
  const dir = mkTempDir("under-cap");
  try {
    const logPath = path.join(dir, "observations.jsonl");
    const result = appendStamped(
      dir,
      logPath,
      { kind: "test-ok", evidence: "small evidence" },
      { identity: IDENTITY, sign: stubSigner },
    );
    assert.equal(result.ok, true);
    assert.equal(typeof result.id, "string");
    assert.equal(typeof result.line, "string");
    // Line on disk MUST match what we got back.
    const onDisk = fs.readFileSync(logPath, "utf8").trim();
    assert.equal(onDisk, result.line);

    // Round-trip: parse → strip sig → re-canonicalize → recompute the
    // sha256 → compare to record.sig. This is the verification the
    // post-sign-truncation bug would have broken.
    const parsed = JSON.parse(onDisk);
    const sig = parsed.sig;
    assert.equal(typeof sig, "string");
    const recordMinusSig = { ...parsed };
    delete recordMinusSig.sig;
    const bytes = canonicalSerialize(recordMinusSig);
    const recomputed = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      recomputed,
      sig,
      "on-disk signed bytes MUST match signature input — refuse-on-overflow contract",
    );
  } finally {
    cleanup(dir);
  }
});

test("Sec-LOW-2: signed-line guard refuses when actual signature blows past SIG_RESERVE", () => {
  // A custom signer that returns a 4KB armoring blows past the
  // 128-byte SIG_RESERVE; the final guard MUST refuse rather than
  // write a line that violates the MAX_LINE_BYTES contract.
  const dir = mkTempDir("oversized-sig");
  try {
    const logPath = path.join(dir, "observations.jsonl");
    const oversizedSigner = () => ({ ok: true, sig: "y".repeat(4096) });
    const result = appendStamped(
      dir,
      logPath,
      { kind: "test-sig-too-big", evidence: "small" },
      { identity: IDENTITY, sign: oversizedSigner },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /record too large/);
    assert.match(result.reason, /signed line.*exceeds.*MAX_LINE_BYTES/i);
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    cleanup(dir);
  }
});
