/**
 * Tier-2 integration tests for F14 substrate-hardening shard
 * (workspaces/multi-operator-coc — security review against M0/M1 substrate).
 *
 * This suite is the pre-ship contract for:
 *   CRIT-1 — fold predicates exported but unwired
 *   HIGH-1 — resolveTrustRoot skips host_role:ci filter
 *   HIGH-2 — _checkRule5 does not cryptographically verify cosigner sigs
 *   HIGH-3 — Rule 3 sig-less path is structurally unreachable
 *   MED-3 — _checkRule5 / fold-rule-9b / fold-rule-9c inline eligibility drift
 *   MED-4 — journal-write-guard.js missing resolveMainCheckout
 *   LOW-4 — settings.json deny-list missing posture.json.tmp.*
 *
 * Run via:  node --test tests/integration/multi-operator/substrate-hardening.test.js
 *
 * Tier-2 discipline: real ssh-keygen + real coc-sign verify; no mocking
 * of crypto / signature / fold semantics (rules/testing.md § Tier 2).
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
const FOLD_RULE_9B = path.join(LIB_DIR, "fold-rule-9b.js");
const FOLD_RULE_9C = path.join(LIB_DIR, "fold-rule-9c.js");
const POSTURE_V2 = path.join(LIB_DIR, "posture-v2.js");
const ELIGIBILITY = path.join(LIB_DIR, "eligibility.js");
const SETTINGS_JSON = path.join(REPO_ROOT, ".claude", "settings.json");
const JOURNAL_WRITE_GUARD = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "journal-write-guard.js",
);

// ---- ephemeral key fixtures -------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-f14-${label}-`));
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
    `coc-f14-test-${label}`,
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

// ---- record helpers ---------------------------------------------------------
function contentHash(core) {
  const { canonicalSerialize } = require(COC_SIGN);
  return crypto
    .createHash("sha256")
    .update(canonicalSerialize(core))
    .digest("hex");
}

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

function ownerPerson(login, fp, pub, opts) {
  const o = opts || {};
  return {
    display_id: o.display_id || login,
    role: o.role || "owner",
    github_login: login,
    host_role: o.host_role || "human",
    keys: [{ type: "ssh", fingerprint: fp, pubkey: pub }],
  };
}

function makeRoster(persons, genesis) {
  return {
    genesis: genesis || {
      repo_owner: "owner-A",
      repo_owner_kind: "user",
      root_commit: "rootABC",
      genesis_generation: 0,
    },
    persons,
  };
}

function buildMigrationRecord(keyA, keyB, opts) {
  const o = opts || {};
  const coreNoSig = {
    type: "genesis-migration",
    verified_id: keyA.fingerprint,
    person_id: o.person_id || "pid-A",
    seq: o.seq != null ? o.seq : 0,
    prev_hash: o.prev_hash !== undefined ? o.prev_hash : null,
    ts: o.ts || "2026-05-20T00:00:00Z",
    content: {
      from_genesis_generation:
        o.from_genesis_generation != null ? o.from_genesis_generation : 0,
      to_genesis_generation:
        o.to_genesis_generation != null ? o.to_genesis_generation : 1,
      new_repo_owner: o.new_repo_owner || "new-owner-Z",
      new_repo_owner_kind: o.new_repo_owner_kind || "user",
      gh_api_repo_owner_capture:
        o.gh_api_repo_owner_capture !== undefined
          ? o.gh_api_repo_owner_capture
          : {
              owner: { login: o.new_repo_owner || "new-owner-Z", type: "User" },
              name: "repo",
              full_name: `${o.new_repo_owner || "new-owner-Z"}/repo`,
              capture_ts: o.capture_ts || o.ts || "2026-05-20T00:00:00Z",
            },
      co_signers: [],
    },
  };
  if (o.omitOwnerCapture) delete coreNoSig.content.gh_api_repo_owner_capture;
  if (o.omitCoSigners) delete coreNoSig.content.co_signers;
  const { co_signers, ...coreForCoSig } = coreNoSig.content;
  const baseForCoSig = { ...coreNoSig, content: coreForCoSig };
  if (!o.singleSigner && !o.omitCoSigners && keyB) {
    if (o.forgedCosigSig) {
      // Attach a structurally-shaped but cryptographically-invalid cosig.
      coreNoSig.content.co_signers.push({
        verified_id: keyB.fingerprint,
        sig: o.forgedCosigSig,
      });
    } else {
      coreNoSig.content.co_signers.push(
        coSign(baseForCoSig, keyB.keyPath, keyB.fingerprint),
      );
    }
  }
  return signRecord(coreNoSig, keyA.keyPath);
}

function buildCheckpointRecord(keyA, keyB, opts) {
  const o = opts || {};
  const coreNoSig = {
    type: "compaction-checkpoint",
    verified_id: keyA.fingerprint,
    person_id: o.person_id || "pid-A",
    seq: o.seq != null ? o.seq : 0,
    prev_hash: o.prev_hash !== undefined ? o.prev_hash : null,
    ts: o.ts || "2026-05-20T00:00:00Z",
    content: {
      up_to_seq: o.up_to_seq != null ? o.up_to_seq : 100,
      retained_chain_heads:
        o.retained_chain_heads !== undefined
          ? o.retained_chain_heads
          : { [keyA.fingerprint]: { lastSeq: 5, lastContentHash: "abc" } },
      exempt_closure:
        o.exempt_closure !== undefined ? o.exempt_closure : [],
      folded_state_digest:
        o.folded_state_digest != null ? o.folded_state_digest : "digest-abc",
      archive_genN_tip_hash:
        o.archive_genN_tip_hash != null
          ? o.archive_genN_tip_hash
          : "f".repeat(40),
      archive_ref_name: o.archive_ref_name || "refs/coc/archive-gen0",
      co_signers: [],
    },
  };
  const { co_signers, ...coreForCoSig } = coreNoSig.content;
  const baseForCoSig = { ...coreNoSig, content: coreForCoSig };
  if (!o.singleSigner && keyB) {
    if (o.forgedCosigSig) {
      coreNoSig.content.co_signers.push({
        verified_id: keyB.fingerprint,
        sig: o.forgedCosigSig,
      });
    } else {
      coreNoSig.content.co_signers.push(
        coSign(baseForCoSig, keyB.keyPath, keyB.fingerprint),
      );
    }
  }
  return signRecord(coreNoSig, keyA.keyPath);
}

function buildGenesisAnchorRecord(keyA, opts) {
  const o = opts || {};
  const coreNoSig = {
    type: "genesis-anchor",
    verified_id: keyA.fingerprint,
    person_id: o.person_id || "pid-A",
    seq: o.seq != null ? o.seq : 0,
    prev_hash: o.prev_hash !== undefined ? o.prev_hash : null,
    ts: o.ts || "2026-05-20T00:00:00Z",
    content: {
      pinned: o.pinned || {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "rootABC",
      },
      genesis_generation:
        o.genesis_generation != null ? o.genesis_generation : 0,
    },
  };
  return signRecord(coreNoSig, keyA.keyPath);
}

// =============================================================================
// CRIT-1: fold predicates wired (single-signer genesis-migration rejected
// at fold engine; generation-rotation wired to fold-rule-9b)
// =============================================================================

test("CRIT-1: single-signer genesis-migration is rejected by fold engine", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("crit1-single-A");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
    });
    // Build a migration with NO co_signers field at all.
    const migration = buildMigrationRecord(kA, null, {
      omitCoSigners: true,
    });
    // Use module-default engine (M0 + C1 defaults pre-registered);
    // this is the engine consumers hit through `require(ENGINE).foldLog`.
    const r = eng.foldLog([migration], roster, {});
    assert.equal(r.accepted.length, 0, "single-signer migration must NOT land");
    assert.equal(r.rejected.length, 1, "exactly one rejection");
    assert.match(
      r.rejected[0].reason,
      /co.sign|R6-S-04|2-of-N|degenerate|self-sign/i,
      `rejection cites 2-of-N cosig requirement; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
  }
});

test("CRIT-1: genesis-migration with one signer + invalid cosig is rejected", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("crit1-invcosig-A");
  const kB = mkEphemeralSshKey("crit1-invcosig-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Use a structurally-valid base64 sig string that won't actually verify.
    const forged = Buffer.from(new Uint8Array(64)).toString("base64");
    const migration = buildMigrationRecord(kA, kB, {
      forgedCosigSig: forged,
    });
    const r = eng.foldLog([migration], roster, {});
    assert.equal(r.accepted.length, 0, "forged cosig must NOT land");
    assert.equal(r.rejected.length, 1, "exactly one rejection");
    assert.match(
      r.rejected[0].reason,
      /co.sign|verify|signature|invalid/i,
      `rejection cites cosig verification failure; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("CRIT-1: genesis-migration with stale gh_api capture is rejected", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("crit1-stale-A");
  const kB = mkEphemeralSshKey("crit1-stale-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const migration = buildMigrationRecord(kA, kB, {
      new_repo_owner: "new-owner-Z",
      gh_api_repo_owner_capture: {
        owner: { login: "different-owner", type: "User" },
        name: "repo",
        full_name: "different-owner/repo",
        capture_ts: "2026-05-20T00:00:00Z",
      },
    });
    const r = eng.foldLog([migration], roster, {});
    assert.equal(r.accepted.length, 0, "stale capture rejected");
    assert.match(
      r.rejected[0].reason,
      /capture|owner|stale|mismatch/i,
      `rejection cites stale capture; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("CRIT-1: genesis-migration with non-monotonic generation is rejected", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("crit1-mono-A");
  const kB = mkEphemeralSshKey("crit1-mono-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // to <= from is a non-monotonic increment.
    const migration = buildMigrationRecord(kA, kB, {
      from_genesis_generation: 2,
      to_genesis_generation: 2,
    });
    const r = eng.foldLog([migration], roster, {});
    assert.equal(r.accepted.length, 0, "non-monotonic generation rejected");
    assert.match(
      r.rejected[0].reason,
      /monotonic|generation|increment/i,
      `rejection cites generation monotonicity; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("CRIT-1: single-signer generation-rotation is rejected by fold engine", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("crit1-rot-A");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
    });
    const coreNoSig = {
      type: "generation-rotation",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        from_generation: 0,
        to_generation: 1,
        retained_chain_heads: {},
        exempt_closure: [],
        folded_state_digest: "d-single",
        archive_genN_tip_pin: {
          ref: "refs/coc/archive-gen0",
          tip_sha: "0".repeat(40),
        },
        co_signers: [],
      },
    };
    const rotation = signRecord(coreNoSig, kA.keyPath);
    const r = eng.foldLog([rotation], roster, {});
    assert.equal(r.accepted.length, 0, "single-signer rotation rejected");
    assert.match(
      r.rejected[0].reason,
      /co.sign|2-of-N|distinct/i,
      `rejection cites co-sign requirement; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
  }
});

test("CRIT-1: 2-of-N owner-cosigned migration with fresh capture is accepted", () => {
  // Positive case — the predicates wire correctly when everything is valid.
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("crit1-pos-A");
  const kB = mkEphemeralSshKey("crit1-pos-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const migration = buildMigrationRecord(kA, kB, {
      from_genesis_generation: 0,
      to_genesis_generation: 1,
      new_repo_owner: "new-owner-Z",
    });
    const r = eng.foldLog([migration], roster, {});
    assert.equal(
      r.accepted.length,
      1,
      `migration accepted; rejected: ${JSON.stringify(r.rejected)}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// =============================================================================
// HIGH-1: resolveTrustRoot filters host_role:ci owner keys (R5-S-04)
// =============================================================================

test("HIGH-1: resolveTrustRoot rejects CI-host owner-signed anchor", () => {
  const { resolveTrustRoot } = require(POSTURE_V2);
  const kCi = mkEphemeralSshKey("high1-ci");
  try {
    // The CI-host person is owner-role per roster, but host_role:ci makes
    // them audit-only per R5-S-04 — never an eligible trust-root signer.
    const roster = {
      genesis: {
        repo_owner: "owner-ci",
        repo_owner_kind: "user",
        root_commit: "rootCI",
        genesis_generation: 0,
      },
      persons: {
        "pid-ci": {
          display_id: "owner-ci-deploy",
          role: "owner",
          github_login: "owner-ci",
          host_role: "ci",
          keys: [
            {
              type: "ssh",
              fingerprint: kCi.fingerprint,
              pubkey: kCi.pubKey,
            },
          ],
        },
      },
    };
    const acceptedRecords = [
      {
        type: "genesis-anchor",
        seq: 0,
        ts: "2026-05-20T00:00:00Z",
        verified_id: kCi.fingerprint,
        content: {
          pinned: { repo_owner: "owner-ci", root_commit: "rootCI" },
          genesis_generation: 0,
        },
      },
    ];
    const trustRoot = resolveTrustRoot(acceptedRecords, roster);
    assert.equal(
      trustRoot,
      null,
      "CI-host owner-bound anchor MUST NOT become trust root (R5-S-04)",
    );
  } finally {
    cleanup(kCi.dir);
  }
});

test("HIGH-1: resolveTrustRoot picks human owner over CI-host sibling", () => {
  const { resolveTrustRoot } = require(POSTURE_V2);
  const kHuman = mkEphemeralSshKey("high1-human");
  const kCi = mkEphemeralSshKey("high1-ci2");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-mix",
        repo_owner_kind: "user",
        root_commit: "rootMix",
        genesis_generation: 0,
      },
      persons: {
        "pid-human": {
          display_id: "owner-human",
          role: "owner",
          github_login: "owner-mix",
          host_role: "human",
          keys: [
            {
              type: "ssh",
              fingerprint: kHuman.fingerprint,
              pubkey: kHuman.pubKey,
            },
          ],
        },
        "pid-ci": {
          display_id: "owner-ci-mirror",
          role: "owner",
          github_login: "owner-ci-mirror",
          host_role: "ci",
          keys: [
            { type: "ssh", fingerprint: kCi.fingerprint, pubkey: kCi.pubKey },
          ],
        },
      },
    };
    const acceptedRecords = [
      // CI-host anchor with HIGHER seq — would win without the host_role:ci filter.
      {
        type: "genesis-anchor",
        seq: 5,
        ts: "2026-05-21T00:00:00Z",
        verified_id: kCi.fingerprint,
        content: { genesis_generation: 1 },
      },
      // Human owner anchor with LOWER seq — must win after the filter.
      {
        type: "genesis-anchor",
        seq: 1,
        ts: "2026-05-20T00:00:00Z",
        verified_id: kHuman.fingerprint,
        content: { genesis_generation: 0 },
      },
    ];
    const trustRoot = resolveTrustRoot(acceptedRecords, roster);
    assert.notEqual(trustRoot, null, "human owner anchor must resolve");
    assert.equal(
      trustRoot.verified_id,
      kHuman.fingerprint,
      "human owner wins over CI-host even at higher seq",
    );
    assert.equal(
      trustRoot.anchor_record_seq,
      1,
      "selected seq is the human owner's (1), not CI host's (5)",
    );
  } finally {
    cleanup(kHuman.dir);
    cleanup(kCi.dir);
  }
});

// =============================================================================
// HIGH-2: _checkRule5 cryptographically verifies cosigner signatures
// =============================================================================

test("HIGH-2: compaction-checkpoint with forged cosig sig is rejected at rule 5", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("high2-cp-A");
  const kB = mkEphemeralSshKey("high2-cp-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // 64-zero-byte base64 — structurally a sig string, won't verify.
    const forged = Buffer.from(new Uint8Array(64)).toString("base64");
    const checkpoint = buildCheckpointRecord(kA, kB, {
      forgedCosigSig: forged,
    });
    const r = eng.foldLog([checkpoint], roster, {});
    assert.equal(r.accepted.length, 0, "forged cosig must NOT land");
    assert.equal(r.rejected.length, 1, "exactly one rejection");
    assert.equal(r.rejected[0].rule, "rule-5", "rejected at rule 5");
    assert.match(
      r.rejected[0].reason,
      /co.sign|signature|verify|invalid/i,
      `rejection cites cosig verification; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("HIGH-2: compaction-checkpoint with valid 2-of-N cosig is accepted at rule 5", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("high2-acc-A");
  const kB = mkEphemeralSshKey("high2-acc-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const checkpoint = buildCheckpointRecord(kA, kB, {});
    const r = eng.foldLog([checkpoint], roster, {});
    assert.equal(
      r.accepted.length,
      1,
      `valid checkpoint accepted; rejected: ${JSON.stringify(r.rejected)}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// =============================================================================
// HIGH-3: Rule 3 sig-less record path is structurally unreachable
// =============================================================================

test("HIGH-3: sig-less records are rejected at shape validation before rule 3", () => {
  // The defensive sig-skip in _checkRule3 (coordination-log.js:689) cannot
  // be reached: _validateRecordShape (line 532) requires record.sig to be a
  // non-empty string, and shape validation runs BEFORE rule 3 in the engine
  // loop (lines 997-1004). This test pins that ordering invariant.
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("high3-shape-A");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
    });
    // Hand-craft a record WITHOUT sig (cannot use signRecord which sets sig).
    const sigless = {
      type: "heartbeat",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
      // sig: absent
    };
    const r = eng.foldLog([sigless], roster, {});
    assert.equal(r.accepted.length, 0, "sig-less record never lands");
    assert.equal(r.rejected.length, 1, "one rejection");
    assert.equal(
      r.rejected[0].rule,
      "shape",
      "rejected at shape validation, not at rule 3",
    );
    assert.match(
      r.rejected[0].reason,
      /sig missing|shape/i,
      `rejection cites shape error; got: ${r.rejected[0].reason}`,
    );
    // forks[] should be empty — no fork detection path even attempted.
    assert.equal(r.forks.length, 0, "no fork entries from sig-less record");
  } finally {
    cleanup(kA.dir);
  }
});

test("HIGH-3: rule 3 detects fork between two signed siblings at (verified_id, seq)", () => {
  // Positive coverage — when BOTH siblings carry valid signatures, rule 3
  // surfaces the equivocation in forks[]. This confirms the signed-fork path
  // (the only reachable path) works.
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("high3-fork-A");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
    });
    const sibling1 = signRecord(
      {
        type: "heartbeat",
        verified_id: kA.fingerprint,
        person_id: "pid-A",
        seq: 0,
        prev_hash: null,
        ts: "2026-05-20T00:00:00Z",
        content: { ts_branch: "branchA" },
      },
      kA.keyPath,
    );
    const sibling2 = signRecord(
      {
        type: "heartbeat",
        verified_id: kA.fingerprint,
        person_id: "pid-A",
        seq: 0,
        prev_hash: null,
        ts: "2026-05-20T00:00:00Z",
        content: { ts_branch: "branchB" },
      },
      kA.keyPath,
    );
    const r = eng.foldLog([sibling1, sibling2], roster, {});
    assert.equal(r.forks.length, 1, "fork surfaced in forks[]");
    assert.equal(
      r.forks[0].verified_id,
      kA.fingerprint,
      "fork names equivocator's verified_id",
    );
    assert.equal(r.forks[0].seq, 0, "fork at seq 0");
  } finally {
    cleanup(kA.dir);
  }
});

// =============================================================================
// MED-3: eligibility consolidation through isEligibleSigner
// =============================================================================

test("MED-3: rule 5 rejects CI-host cosigner via eligibility predicate", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("med3-A");
  const kCi = mkEphemeralSshKey("med3-ci");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "rootABC",
        genesis_generation: 0,
      },
      persons: {
        "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
        "pid-ci": {
          display_id: "ci-deploy",
          role: "owner",
          github_login: "ci-deploy",
          host_role: "ci",
          keys: [
            { type: "ssh", fingerprint: kCi.fingerprint, pubkey: kCi.pubKey },
          ],
        },
      },
    };
    const checkpoint = buildCheckpointRecord(kA, kCi, {});
    const r = eng.foldLog([checkpoint], roster, {});
    assert.equal(r.accepted.length, 0, "CI-host cosigner rejected");
    assert.match(
      r.rejected[0].reason,
      /host_role|ci|audit|R5-S-04|eligib/i,
      `rejection cites CI-host ineligibility; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kCi.dir);
  }
});

test("MED-3: fold-rule-9b rejects CI-host cosigner via eligibility predicate", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("med3-9b-A");
  const kCi = mkEphemeralSshKey("med3-9b-ci");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "rootABC",
        genesis_generation: 0,
      },
      persons: {
        "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
        "pid-ci": {
          display_id: "ci-mirror",
          role: "owner",
          github_login: "ci-mirror",
          host_role: "ci",
          keys: [
            { type: "ssh", fingerprint: kCi.fingerprint, pubkey: kCi.pubKey },
          ],
        },
      },
    };
    // Build a generation-rotation with CI-host as cosigner.
    const coreNoSig = {
      type: "generation-rotation",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        from_generation: 0,
        to_generation: 1,
        retained_chain_heads: {},
        exempt_closure: [],
        folded_state_digest: "d-med3-9b",
        archive_genN_tip_pin: {
          ref: "refs/coc/archive-gen0",
          tip_sha: "0".repeat(40),
        },
        co_signers: [],
      },
    };
    const { co_signers, ...coreForCoSig } = coreNoSig.content;
    const baseForCoSig = { ...coreNoSig, content: coreForCoSig };
    coreNoSig.content.co_signers.push(
      coSign(baseForCoSig, kCi.keyPath, kCi.fingerprint),
    );
    const rotation = signRecord(coreNoSig, kA.keyPath);
    const r = eng.foldLog([rotation], roster, {});
    assert.equal(r.accepted.length, 0, "CI-host cosigner rejected on rotation");
    assert.match(
      r.rejected[0].reason,
      /host_role|ci|audit|R5-S-04|eligib/i,
      `rejection cites CI-host ineligibility; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kCi.dir);
  }
});

test("MED-3: fold-rule-9c rejects CI-host cosigner via eligibility predicate", () => {
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("med3-9c-A");
  const kCi = mkEphemeralSshKey("med3-9c-ci");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "rootABC",
        genesis_generation: 0,
      },
      persons: {
        "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
        "pid-ci": {
          display_id: "ci-deploy",
          role: "owner",
          github_login: "ci-deploy",
          host_role: "ci",
          keys: [
            { type: "ssh", fingerprint: kCi.fingerprint, pubkey: kCi.pubKey },
          ],
        },
      },
    };
    const migration = buildMigrationRecord(kA, kCi, {});
    const r = eng.foldLog([migration], roster, {});
    assert.equal(r.accepted.length, 0, "CI-host cosigner rejected on migration");
    assert.match(
      r.rejected[0].reason,
      /host_role|ci|audit|R5-S-04|eligib/i,
      `rejection cites CI-host ineligibility; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kCi.dir);
  }
});

test("MED-3: eligibility module exposes isEligibleSigner with CI-forever-ineligible contracts", () => {
  const { isEligibleSigner, CI_FOREVER_INELIGIBLE_CONTEXTS } =
    require(ELIGIBILITY);
  // CI-host owner → ineligible in every owner-quorum / migration context.
  const ciOwner = {
    role: "owner",
    host_role: "ci",
  };
  for (const ctx of CI_FOREVER_INELIGIBLE_CONTEXTS) {
    const r = isEligibleSigner(ciOwner, ctx);
    assert.equal(
      r.eligible,
      false,
      `CI-host owner ineligible for ${ctx}; got: ${JSON.stringify(r)}`,
    );
  }
  // Human owner → eligible for owner-quorum.
  const human = { role: "owner", host_role: "human" };
  const ok = isEligibleSigner(human, "owner-quorum");
  assert.equal(ok.eligible, true, "human owner eligible for owner-quorum");
});

// =============================================================================
// MED-4: journal-write-guard uses resolveMainCheckout
// =============================================================================

test("MED-4: journal-write-guard.js imports resolveMainCheckout", () => {
  const source = fs.readFileSync(JOURNAL_WRITE_GUARD, "utf8");
  assert.match(
    source,
    /require\([^)]*state-resolver[^)]*\)/,
    "journal-write-guard.js imports state-resolver",
  );
  assert.match(
    source,
    /resolveMainCheckout/,
    "journal-write-guard.js references resolveMainCheckout",
  );
});

test("MED-4: journal-write-guard routes session cwd through resolveMainCheckout", () => {
  // Mechanical AST-grep — the main flow MUST resolve repoDir via
  // resolveMainCheckout(sessionCwd) || sessionCwd, mirroring integrity-guard.
  const source = fs.readFileSync(JOURNAL_WRITE_GUARD, "utf8");
  // The pattern: `const sessionCwd = resolveRepoDir(...)` followed within
  // a few lines by `resolveMainCheckout(sessionCwd)`. This is the
  // canonical integrity-guard.js shape (integrity-guard.js:324-325).
  assert.match(
    source,
    /const sessionCwd\s*=\s*resolveRepoDir\s*\(\s*payload\s*\)/,
    "main flow binds sessionCwd via resolveRepoDir(payload)",
  );
  assert.match(
    source,
    /const repoDir\s*=\s*resolveMainCheckout\s*\(\s*sessionCwd\s*\)/,
    "main flow binds repoDir via resolveMainCheckout(sessionCwd) — mirrors integrity-guard.js",
  );
});

// =============================================================================
// LOW-4: settings.json deny-list covers posture.json.tmp.*
// =============================================================================

test("LOW-4: settings.json deny-list includes posture.json.tmp.*", () => {
  const raw = fs.readFileSync(SETTINGS_JSON, "utf8");
  const settings = JSON.parse(raw);
  const denies = settings.permissions && settings.permissions.deny;
  assert.ok(Array.isArray(denies), "permissions.deny is an array");
  const haveTmpEdit = denies.some(
    (d) =>
      typeof d === "string" &&
      /posture\.json\.tmp\.\*/.test(d) &&
      /^Edit\(/.test(d),
  );
  const haveTmpWrite = denies.some(
    (d) =>
      typeof d === "string" &&
      /posture\.json\.tmp\.\*/.test(d) &&
      /^Write\(/.test(d),
  );
  assert.ok(
    haveTmpEdit,
    "Edit(.claude/learning/posture.json.tmp.*) present in deny list",
  );
  assert.ok(
    haveTmpWrite,
    "Write(.claude/learning/posture.json.tmp.*) present in deny list",
  );
});

test("LOW-4: settings.json deny-list still covers canonical posture.json + violations.jsonl", () => {
  // Regression — confirm the LOW-4 fix did not displace prior entries.
  const raw = fs.readFileSync(SETTINGS_JSON, "utf8");
  const settings = JSON.parse(raw);
  const denies = settings.permissions.deny;
  for (const want of [
    "Edit(.claude/learning/posture.json)",
    "Write(.claude/learning/posture.json)",
    "Edit(.claude/learning/violations.jsonl)",
    "Write(.claude/learning/violations.jsonl)",
  ]) {
    assert.ok(denies.includes(want), `deny still covers ${want}`);
  }
});

// =============================================================================
// CRIT-1 end-to-end fixture (the validation gate's load-bearing test)
// =============================================================================

test("CRIT-1 e2e: single-signer genesis-migration in rejected[] with cosig reason", () => {
  // The exact assertion from the prompt's validation gate (item 4):
  //   construct a single-signer genesis-migration record (valid rule-1 sig,
  //   fresh chain, NO co_signers field), submit via foldLog(records, roster, {}),
  //   assert accepted[] does NOT include it AND rejected[] DOES include it
  //   with a reason citing the 2-of-N cosig requirement.
  const eng = require(ENGINE);
  const kA = mkEphemeralSshKey("e2e-crit1-A");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
    });
    // Migration with NO co_signers field at all (omitCoSigners=true) —
    // valid rule-1 sig from kA, fresh chain (seq=0, prev_hash=null).
    const migration = buildMigrationRecord(kA, null, {
      omitCoSigners: true,
      from_genesis_generation: 0,
      to_genesis_generation: 1,
      seq: 0,
      prev_hash: null,
    });
    const r = eng.foldLog([migration], roster, {});

    // ASSERT 1: accepted[] does NOT include the migration.
    const acceptedMigration = r.accepted.find(
      (rec) => rec.type === "genesis-migration",
    );
    assert.equal(
      acceptedMigration,
      undefined,
      `single-signer migration MUST NOT appear in accepted[]; saw: ${JSON.stringify(acceptedMigration)}`,
    );

    // ASSERT 2: rejected[] DOES include the migration.
    const rejectedMigration = r.rejected.find(
      (item) => item.record && item.record.type === "genesis-migration",
    );
    assert.notEqual(
      rejectedMigration,
      undefined,
      "single-signer migration MUST appear in rejected[]",
    );

    // ASSERT 3: rejection reason cites the 2-of-N cosig requirement.
    assert.match(
      rejectedMigration.reason,
      /co.sign|2-of-N|R6-S-04|degenerate|self-sign/i,
      `rejection reason cites 2-of-N cosig; got: ${rejectedMigration.reason}`,
    );

    // Surface the result so the validation gate can paste it verbatim.
    console.log(
      `[CRIT-1 e2e] rejected reason: ${JSON.stringify(rejectedMigration.reason)}`,
    );
  } finally {
    cleanup(kA.dir);
  }
});
