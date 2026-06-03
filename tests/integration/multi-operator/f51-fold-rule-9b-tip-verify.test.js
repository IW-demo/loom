/**
 * Tier-2 integration tests for F51 — wire verifyArchiveTipPin into
 * fold-rule-9b's generation-rotation predicate path.
 *
 * Closes the F51 forest item per
 * `.claude/rules/multi-operator-coordination.md` § Origin → "Open
 * follow-up forest items": after the existing R9-A-01 pin-presence
 * check, the fold engine now invokes `archive-ref.js::verifyArchiveTipPin`
 * against the observed `refs/coc/archive-genN` tip read live via
 * `transport-git-ref.js::readArchiveRefTip` (a `git for-each-ref`
 * wrapper, NOT a documentation grep — `verify-resource-existence.md`
 * MUST-2 shape). Mismatch returns rule-9b folded-fail with the
 * divergence in the reason.
 *
 * Coverage:
 *   1. PASS — pin matches observed tip → record folds clean.
 *   2. FAIL — pin diverges from observed tip → rejected with both SHAs.
 *   3. FAIL — live-read errors (e.g. ref absent) → typed error, never
 *      silent.
 *   4. REGRESSION — existing R9-A-01 missing-field case still fires
 *      when archive_genN_tip_pin is absent (no behavior regression on
 *      the field-presence layer).
 *   5. SKIP — no archiveTipVerify opt → tip-verify is bypassed (the
 *      opt-in gate works correctly; production paths wire it).
 *   6. STRUCTURAL — readArchiveRefTip helper itself:
 *        a. valid refs/coc/archive-genN ref returns the tip SHA.
 *        b. missing ref returns typed error (no silent default).
 *        c. non-coc refName is rejected by the allowlist.
 *
 * Run via:
 *   node --test tests/integration/multi-operator/f51-fold-rule-9b-tip-verify.test.js
 *
 * Tier-2 discipline per `rules/testing.md`: real ssh-keygen + real
 * coc-sign verify + real git repo for the readArchiveRefTip half; the
 * fold-engine half injects a deterministic reader via
 * ctx.opts.archiveTipVerify.readArchiveRefTip (a TYPED stub satisfying
 * the readArchiveRefTip contract, NOT a unittest.mock-style mock — per
 * `testing.md` § "Protocol-Satisfying Deterministic Adapters" exception
 * to Tier-2 NO mocking. Documenting WHY here per `zero-tolerance.md`
 * Rule 2 no-fake-data discipline: a real git repo per fold-test would
 * 10× the run time without exercising the fold-engine wiring this F51
 * shard ships; the protocol-adapter reader gives the fold path its
 * exact runtime input shape.).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const ENGINE = path.join(LIB_DIR, "coordination-log.js");
const TRANSPORT = path.join(LIB_DIR, "transport-git-ref.js");

// ---- ephemeral key fixtures ------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-f51-${label}-`));
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", [
    "-t",
    "ed25519",
    "-N",
    "",
    "-q",
    "-f",
    keyPath,
    "-C",
    `coc-f51-test-${label}`,
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fpOut = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    encoding: "utf8",
  });
  const m = fpOut.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (!m) throw new Error("could not extract fingerprint");
  return { dir, keyPath, pubKey: pub, fingerprint: m[0] };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ---- record helpers --------------------------------------------------------
function signRecord(core, keyPath) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(core);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`sign failed: ${r.error}`);
  return { ...core, sig: r.sig };
}

function coSign(coreNoSig, keyPath, signerVerifiedId) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(coreNoSig);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`co-sign failed: ${r.error}`);
  return { verified_id: signerVerifiedId, sig: r.sig };
}

function ownerPerson(login, fp, pub) {
  return {
    display_id: login,
    role: "owner",
    github_login: login,
    host_role: "human",
    keys: [{ type: "ssh", fingerprint: fp, pubkey: pub }],
  };
}

function makeRoster(persons) {
  return {
    genesis: {
      repo_owner: "owner-A",
      repo_owner_kind: "user",
      root_commit: "rootABC",
      genesis_generation: 0,
    },
    persons,
  };
}

/**
 * Build a fully-signed generation-rotation record with valid 2-of-N
 * co-sign. `opts.archivePinTipSha` overrides the pinned tip SHA;
 * `opts.archiveRefName` overrides the ref name; `opts.omitArchivePin`
 * removes the archive_genN_tip_pin field entirely.
 */
function buildRotationRecord(keyA, keyB, opts) {
  const o = opts || {};
  const pinTipSha =
    o.archivePinTipSha != null ? o.archivePinTipSha : "a".repeat(40);
  const refName = o.archiveRefName || "refs/coc/archive-gen0";
  const coreNoSig = {
    type: "generation-rotation",
    verified_id: keyA.fingerprint,
    person_id: o.person_id || "pid-A",
    seq: o.seq != null ? o.seq : 0,
    prev_hash: o.prev_hash !== undefined ? o.prev_hash : null,
    ts: o.ts || "2026-05-20T00:00:00Z",
    content: {
      from_generation: 0,
      to_generation: 1,
      retained_chain_heads:
        o.retained_chain_heads !== undefined
          ? o.retained_chain_heads
          : {
              [keyA.fingerprint]: { lastSeq: 5, lastContentHash: "abcd" },
            },
      exempt_closure: o.exempt_closure !== undefined ? o.exempt_closure : [],
      folded_state_digest:
        o.folded_state_digest != null ? o.folded_state_digest : "d-f51",
      co_signers: [],
    },
  };
  if (!o.omitArchivePin) {
    coreNoSig.content.archive_genN_tip_pin = {
      ref: refName,
      tip_sha: pinTipSha,
    };
  }
  const { co_signers, ...coreForCoSig } = coreNoSig.content;
  const baseForCoSig = { ...coreNoSig, content: coreForCoSig };
  if (keyB) {
    coreNoSig.content.co_signers.push(
      coSign(baseForCoSig, keyB.keyPath, keyB.fingerprint),
    );
  }
  return signRecord(coreNoSig, keyA.keyPath);
}

/**
 * Protocol-satisfying deterministic reader for archiveTipVerify.
 * Returns the same shape as transport-git-ref.js::readArchiveRefTip:
 *   { ok: true, tipSha } | { ok: false, reason }
 * (per `rules/testing.md` § "Protocol Adapters": a Protocol-satisfying
 * deterministic adapter is NOT a mock — it's the contract under test
 * with deterministic output. The fold-engine wiring is what this F51
 * shard ships; the live git-read primitive has its own structural
 * tests below.)
 */
function fixtureReader(map) {
  return function (repoDir, refName) {
    if (!Object.prototype.hasOwnProperty.call(map, refName)) {
      return {
        ok: false,
        reason: `fixture-reader: refName '${refName}' absent`,
      };
    }
    const v = map[refName];
    if (v && typeof v === "object" && v.error) {
      return { ok: false, reason: v.error };
    }
    return { ok: true, tipSha: v };
  };
}

// =============================================================================
// PASS / FAIL paths through fold-rule-9b live tip verification
// =============================================================================

test("F51 PASS: pin matches observed tip → rotation folds clean", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("pass-A");
  const kB = mkEphemeralSshKey("pass-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const pinSha = "1".repeat(40);
    const rotation = buildRotationRecord(kA, kB, { archivePinTipSha: pinSha });
    const reader = fixtureReader({ "refs/coc/archive-gen0": pinSha });
    const r = eng.foldLog([rotation], roster, {
      archiveTipVerify: {
        repoDir: "/tmp/synthetic",
        readArchiveRefTip: reader,
      },
    });
    assert.equal(
      r.accepted.length,
      1,
      `expected rotation to fold; rejected: ${JSON.stringify(r.rejected)}`,
    );
    assert.equal(r.rejected.length, 0, "no rejections on match");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("F51 FAIL: pin diverges from observed tip → rejected with both SHAs", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("fail-div-A");
  const kB = mkEphemeralSshKey("fail-div-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const pinSha = "2".repeat(40);
    const observedSha = "3".repeat(40);
    const rotation = buildRotationRecord(kA, kB, { archivePinTipSha: pinSha });
    const reader = fixtureReader({ "refs/coc/archive-gen0": observedSha });
    const r = eng.foldLog([rotation], roster, {
      archiveTipVerify: {
        repoDir: "/tmp/synthetic",
        readArchiveRefTip: reader,
      },
    });
    assert.equal(r.accepted.length, 0, "rotation MUST NOT fold on tip drift");
    assert.equal(r.rejected.length, 1);
    const reason = r.rejected[0].reason;
    assert.match(
      reason,
      /live archive-ref tip verification failed/i,
      `reason names tip-verify failure; got: ${reason}`,
    );
    assert.ok(
      reason.includes(pinSha),
      `reason names pinned SHA; got: ${reason}`,
    );
    assert.ok(
      reason.includes(observedSha),
      `reason names observed SHA; got: ${reason}`,
    );
    assert.ok(
      reason.includes("refs/coc/archive-gen0"),
      `reason names archive ref; got: ${reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("F51 FAIL: live-read errors (ref absent) → typed error, never silent", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("fail-abs-A");
  const kB = mkEphemeralSshKey("fail-abs-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const rotation = buildRotationRecord(kA, kB, {
      archivePinTipSha: "4".repeat(40),
    });
    // Fixture reader returns no-ok for the targeted ref.
    const reader = fixtureReader({});
    const r = eng.foldLog([rotation], roster, {
      archiveTipVerify: {
        repoDir: "/tmp/synthetic",
        readArchiveRefTip: reader,
      },
    });
    assert.equal(r.accepted.length, 0, "rotation MUST NOT fold on read-fail");
    assert.equal(r.rejected.length, 1);
    const reason = r.rejected[0].reason;
    assert.match(
      reason,
      /live archive-ref read failed/i,
      `reason names live-read failure; got: ${reason}`,
    );
    assert.match(
      reason,
      /refs\/coc\/archive-gen0/,
      `reason names archive ref; got: ${reason}`,
    );
    // Typed-error (zero-tolerance Rule 3): MUST NOT mention "silent" or
    // collapse to a generic "predicate threw".
    assert.doesNotMatch(
      reason,
      /predicate threw/i,
      `typed error MUST NOT surface as opaque predicate exception`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// =============================================================================
// REGRESSION: existing R9-A-01 field-presence path still fires
// =============================================================================

test("F51 REGRESSION: missing archive_genN_tip_pin still fires R9-A-01", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("regress-A");
  const kB = mkEphemeralSshKey("regress-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const rotation = buildRotationRecord(kA, kB, { omitArchivePin: true });
    // Even WITH archiveTipVerify wired, the field-presence check fires
    // FIRST — F51 wiring lands AFTER R9-A-01 per the rule body.
    const reader = fixtureReader({ "refs/coc/archive-gen0": "5".repeat(40) });
    const r = eng.foldLog([rotation], roster, {
      archiveTipVerify: {
        repoDir: "/tmp/synthetic",
        readArchiveRefTip: reader,
      },
    });
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.length, 1);
    const reason = r.rejected[0].reason;
    assert.match(
      reason,
      /R9-A-01|archive_genN_tip_pin/i,
      `regression: R9-A-01 missing-field reason; got: ${reason}`,
    );
    assert.doesNotMatch(
      reason,
      /live archive-ref tip verification/i,
      `field-presence MUST fire before live-tip check`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("F51 SKIP: no archiveTipVerify opt → tip-verify is bypassed (opt-in gate)", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("skip-A");
  const kB = mkEphemeralSshKey("skip-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Build a rotation with a pin that would FAIL live-verify if it ran.
    // Caller does NOT pass archiveTipVerify → live verify MUST be
    // skipped, field-presence-only behavior preserved (the second
    // structural defense is opt-in; consumers wire it).
    const rotation = buildRotationRecord(kA, kB, {
      archivePinTipSha: "6".repeat(40),
    });
    const r = eng.foldLog([rotation], roster, {});
    assert.equal(
      r.accepted.length,
      1,
      `without opt: pre-F51 behavior preserved; rejected: ${JSON.stringify(r.rejected)}`,
    );
    assert.equal(r.rejected.length, 0);
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("F51 GUARD: malformed archiveTipVerify (no repoDir) → halt-and-report", () => {
  // Defense-in-depth: a caller that wires archiveTipVerify must wire it
  // completely. Silent skip on malformed opt would be a `zero-tolerance.md`
  // Rule 3 violation (silent fallback). The guard returns rule-9b
  // folded-fail naming the missing field.
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("guard-A");
  const kB = mkEphemeralSshKey("guard-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const rotation = buildRotationRecord(kA, kB, {
      archivePinTipSha: "7".repeat(40),
    });
    const r = eng.foldLog([rotation], roster, {
      archiveTipVerify: { /* missing repoDir */ readArchiveRefTip: () => null },
    });
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.length, 1);
    assert.match(
      r.rejected[0].reason,
      /malformed|repoDir|refusing to skip/i,
      `guard names malformed opt; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// =============================================================================
// readArchiveRefTip structural tests — live git surface
// =============================================================================

test("F51 STRUCTURAL: readArchiveRefTip returns tip SHA for a valid refs/coc/ ref", () => {
  const { readArchiveRefTip } = require(TRANSPORT);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-f51-rrt-ok-"));
  try {
    execFileSync("git", ["-C", repoDir, "init", "--quiet"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "f51@test"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "f51"]);
    // Create an orphan tree-only commit and bind refs/coc/archive-gen0
    // to it (mimics the archive-ref shape — no working-tree changes).
    const treeSha = execFileSync("git", ["-C", repoDir, "mktree"], {
      input: "",
      encoding: "utf8",
    }).trim();
    const commitSha = execFileSync(
      "git",
      ["-C", repoDir, "commit-tree", treeSha, "-m", "f51 archive seed"],
      { encoding: "utf8" },
    ).trim();
    execFileSync("git", [
      "-C",
      repoDir,
      "update-ref",
      "refs/coc/archive-gen0",
      commitSha,
    ]);
    const r = readArchiveRefTip(repoDir, "refs/coc/archive-gen0");
    assert.equal(r.ok, true, `expected ok=true; got: ${JSON.stringify(r)}`);
    assert.equal(r.tipSha, commitSha);
    assert.match(r.tipSha, /^[0-9a-f]{40}$/);
  } finally {
    cleanup(repoDir);
  }
});

test("F51 STRUCTURAL: readArchiveRefTip returns typed error on absent ref", () => {
  const { readArchiveRefTip } = require(TRANSPORT);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-f51-rrt-abs-"));
  try {
    execFileSync("git", ["-C", repoDir, "init", "--quiet"]);
    const r = readArchiveRefTip(repoDir, "refs/coc/archive-gen0");
    assert.equal(r.ok, false);
    assert.match(
      r.reason,
      /not found|empty/i,
      `typed error names absence; got: ${r.reason}`,
    );
    // MUST NOT return a tipSha (silent default forbidden — zero-tolerance Rule 3)
    assert.equal(r.tipSha, undefined);
  } finally {
    cleanup(repoDir);
  }
});

test("F51 STRUCTURAL: readArchiveRefTip rejects non-coc refName (allowlist)", () => {
  const { readArchiveRefTip } = require(TRANSPORT);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-f51-rrt-deny-"));
  try {
    execFileSync("git", ["-C", repoDir, "init", "--quiet"]);
    const r = readArchiveRefTip(repoDir, "refs/heads/main");
    assert.equal(r.ok, false);
    assert.match(
      r.reason,
      /refs\/coc\//,
      `allowlist names required prefix; got: ${r.reason}`,
    );
  } finally {
    cleanup(repoDir);
  }
});

test("F51 STRUCTURAL: readArchiveRefTip rejects missing repoDir arg", () => {
  const { readArchiveRefTip } = require(TRANSPORT);
  const r = readArchiveRefTip("", "refs/coc/archive-gen0");
  assert.equal(r.ok, false);
  assert.match(r.reason, /repoDir required/i);
});

test("F51 STRUCTURAL: readArchiveRefTip rejects missing refName arg", () => {
  const { readArchiveRefTip } = require(TRANSPORT);
  const r = readArchiveRefTip("/tmp", "");
  assert.equal(r.ok, false);
  assert.match(r.reason, /refName required/i);
});

test("F51 STRUCTURAL: readArchiveRefTip rejects nonexistent repoDir", () => {
  const { readArchiveRefTip } = require(TRANSPORT);
  const r = readArchiveRefTip(
    "/nonexistent/path/coc-f51-nope-" + crypto.randomBytes(4).toString("hex"),
    "refs/coc/archive-gen0",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not exist/i);
});
