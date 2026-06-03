/**
 * Tier-2 integration tests for shard A3 (workspaces/multi-operator-coc,
 * design v11 §3 transport + §2.2 fold rules 9b/9c/9d + §2.3 cold archive ref).
 *
 * Real `git init --bare` "remote" in a per-test tmpdir; real ssh-keygen;
 * real canonicalSerialize + coc-sign verify. No production remote contact
 * — every test sets up its own bare repo via execFileSync('git'...).
 *
 * 5 invariants per the shard contract:
 *
 *   (1) git-ref transport over refs/coc/coordination-genN — implements
 *       A2a's Transport typedef (readAllRecords, appendRecord, headHash,
 *       peerHighWaterFor). Append is fetch-merge-append-retry with
 *       --force-with-lease optimistic concurrency.
 *   (2) Fold rule 9b (generation-rotation) — 2-of-N owner-co-signed
 *       + retained chain-heads + from-genesis transitive closure of
 *       checkpoint-exempt subsequence + folded-state digest + transitive
 *       archive-tip-pin re-anchor across rotations (R9-A-01).
 *   (3) Fold rule 9c (genesis-migration) — 2-of-N owner-co-signed
 *       (NO degenerate self-sign R6-S-04) + fresh gh-api repo_owner
 *       capture + monotonic genesis_generation increment + R6-S-06
 *       latest-wins supersession.
 *   (4) Fold rule 9d (post-migration partition detection) — compares
 *       local genesis_generation to signature-verified peer-observed
 *       high-water from folded genesis-migration records; ref-name
 *       (coordination-genN) is NEVER authoritative — the signed record
 *       content is.
 *   (5) Cold archive ref helpers + engine dispatch wiring — pinArchiveTip
 *       writes the tip-sha pin into the compaction-checkpoint content;
 *       verifyArchiveTipPin reads it back; engine.foldLog dispatches
 *       generation-rotation → fold-rule-9b and genesis-migration → fold-rule-9c.
 *
 * Run: node tests/integration/transport-git-ref.test.js
 * Exit: 0 = all passed; 1 = any failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const ENGINE = path.join(LIB_DIR, "coordination-log.js");
const TRANSPORT_GITREF = path.join(LIB_DIR, "transport-git-ref.js");
const FOLD_RULE_9B = path.join(LIB_DIR, "fold-rule-9b.js");
const FOLD_RULE_9C = path.join(LIB_DIR, "fold-rule-9c.js");
const FOLD_RULE_9D = path.join(LIB_DIR, "fold-rule-9d.js");
const ARCHIVE_REF = path.join(LIB_DIR, "archive-ref.js");

// ---- minimal test harness ---------------------------------------------------
let PASS = 0;
let FAIL = 0;
const FAILS = [];

function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    FAIL += 1;
    FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
    console.log(`  FAIL  ${name}`);
    if (err && err.stack)
      console.log(`        ${err.stack.split("\n")[1] || ""}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: ${a} !== ${e}`);
}

// ---- ephemeral key fixtures -------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-a3-${label}-`));
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
    `coc-a3-test-${label}`,
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

// ---- bare-repo fixtures (git-ref transport remote) --------------------------
function mkBareRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-bare-${label}-`));
  execFileSync("git", ["init", "--bare", "--initial-branch=main", dir], {
    stdio: "pipe",
  });
  return dir;
}

function mkLocalClone(bareDir, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-clone-${label}-`));
  execFileSync("git", ["clone", "-q", bareDir, dir], { stdio: "pipe" });
  // Ensure local has identity (commits inside the clone need it)
  execFileSync("git", [
    "-C",
    dir,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  execFileSync("git", ["-C", dir, "config", "user.name", "coc-a3-test"]);
  // Create an initial commit on main so the bare repo has at least one ref
  // (some git versions reject pushes to an empty repo without a default branch).
  // Skip if HEAD already exists — a sibling clone of the same bare may have
  // already seeded main, in which case `git clone` brings the README into
  // this clone's working tree and an attempted re-commit fails with
  // "nothing to commit". The seed is idempotent at the bare level.
  let hasHead = false;
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], {
      stdio: "pipe",
    });
    hasHead = true;
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    fs.writeFileSync(path.join(dir, "README"), "coc-a3-test\n");
    execFileSync("git", ["-C", dir, "add", "README"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", dir, "push", "-q", "origin", "main"], {
      stdio: "pipe",
    });
  }
  return dir;
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
  // Co-signers each contribute a detached sig over the SAME canonical core.
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(coreNoSig);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`co-sign failed: ${r.error}`);
  return { verified_id: signerVerifiedId, sig: r.sig };
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

// ============================================================================
// Suite 1 — git-ref transport (invariant 1)
// ============================================================================
console.log("\n--- transport-git-ref: contract (A3 invariant 1) ---");

test("transport_git_ref_module_exports_transport_factory", () => {
  const t = require(TRANSPORT_GITREF);
  assert(
    typeof t.createGitRefTransport === "function",
    "createGitRefTransport exported",
  );
});

test("transport_git_ref_appendRecord_writes_to_correct_ref", () => {
  const bare = mkBareRepo("append-write");
  const clone = mkLocalClone(bare, "append-write");
  try {
    const { createGitRefTransport } = require(TRANSPORT_GITREF);
    const tx = createGitRefTransport({
      repoDir: clone,
      refName: "refs/coc/coordination-gen0",
    });
    const rec = {
      type: "heartbeat",
      verified_id: "fp1",
      person_id: "p1",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
      sig: "stub-sig-not-verified-at-transport-layer",
    };
    const r = tx.appendRecordSync(rec);
    assert(r.ok === true, `appendRecord ok; got: ${JSON.stringify(r)}`);
    // The ref should now exist on the remote bare repo
    const refOut = execFileSync(
      "git",
      ["-C", bare, "for-each-ref", "refs/coc/coordination-gen0"],
      { encoding: "utf8" },
    );
    assert(
      refOut.includes("refs/coc/coordination-gen0"),
      `ref created on remote; got: ${refOut}`,
    );
  } finally {
    cleanup(clone);
    cleanup(bare);
  }
});

test("transport_git_ref_readAllRecords_returns_records_in_seq_order", () => {
  const bare = mkBareRepo("read-order");
  const clone = mkLocalClone(bare, "read-order");
  try {
    const { createGitRefTransport } = require(TRANSPORT_GITREF);
    const tx = createGitRefTransport({
      repoDir: clone,
      refName: "refs/coc/coordination-gen0",
    });
    const rec0 = {
      type: "heartbeat",
      verified_id: "fp1",
      person_id: "p1",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
      sig: "s0",
    };
    const rec1 = {
      type: "heartbeat",
      verified_id: "fp1",
      person_id: "p1",
      seq: 1,
      prev_hash: "hashA",
      ts: "2026-05-20T00:01:00Z",
      content: {},
      sig: "s1",
    };
    const rec2 = {
      type: "heartbeat",
      verified_id: "fp1",
      person_id: "p1",
      seq: 2,
      prev_hash: "hashB",
      ts: "2026-05-20T00:02:00Z",
      content: {},
      sig: "s2",
    };
    assert(tx.appendRecordSync(rec0).ok, "rec0 append");
    assert(tx.appendRecordSync(rec1).ok, "rec1 append");
    assert(tx.appendRecordSync(rec2).ok, "rec2 append");
    const all = tx.readAllRecordsSync();
    assertEqual(
      all.map((r) => r.seq),
      [0, 1, 2],
      "preserved append order",
    );
    assertEqual(all[0].verified_id, "fp1", "verified_id intact");
  } finally {
    cleanup(clone);
    cleanup(bare);
  }
});

test("transport_git_ref_headHash_returns_current_ref_tip_sha", () => {
  const bare = mkBareRepo("head-sha");
  const clone = mkLocalClone(bare, "head-sha");
  try {
    const { createGitRefTransport } = require(TRANSPORT_GITREF);
    const tx = createGitRefTransport({
      repoDir: clone,
      refName: "refs/coc/coordination-gen0",
    });
    const beforeAny = tx.headHashSync();
    assert(
      beforeAny === null || beforeAny === "",
      "headHash is null/empty before any append",
    );
    const rec = {
      type: "heartbeat",
      verified_id: "fp1",
      person_id: "p1",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
      sig: "s",
    };
    tx.appendRecordSync(rec);
    const afterAppend = tx.headHashSync();
    assert(
      typeof afterAppend === "string" && /^[0-9a-f]{40}$/.test(afterAppend),
      `headHash returns full SHA; got: ${afterAppend}`,
    );
  } finally {
    cleanup(clone);
    cleanup(bare);
  }
});

test("transport_git_ref_fetch_merge_append_retry_succeeds_after_concurrent_push", () => {
  // Simulate a concurrent push from a second clone: the first appendRecord
  // sees the bare repo at SHA-1; a second clone appends and updates the bare
  // repo to SHA-2 before the first clone's push lands. The first clone's
  // appendRecord MUST refetch + retry and succeed.
  const bare = mkBareRepo("concur");
  const cloneA = mkLocalClone(bare, "concur-A");
  const cloneB = mkLocalClone(bare, "concur-B");
  try {
    const { createGitRefTransport } = require(TRANSPORT_GITREF);
    const txA = createGitRefTransport({
      repoDir: cloneA,
      refName: "refs/coc/coordination-gen0",
    });
    const txB = createGitRefTransport({
      repoDir: cloneB,
      refName: "refs/coc/coordination-gen0",
    });
    // Clone B writes first (sets the baseline ref on the remote)
    const recB0 = {
      type: "heartbeat",
      verified_id: "fpB",
      person_id: "pB",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
      sig: "sb0",
    };
    assert(txB.appendRecordSync(recB0).ok, "B baseline append");
    // Now clone A appends — it must fetch B's update first, then append.
    const recA0 = {
      type: "heartbeat",
      verified_id: "fpA",
      person_id: "pA",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:01:00Z",
      content: {},
      sig: "sa0",
    };
    const r = txA.appendRecordSync(recA0);
    assert(
      r.ok === true,
      `A append after concurrent B push; got: ${JSON.stringify(r)}`,
    );
    // After fetch on A, A's log should have BOTH records
    const all = txA.readAllRecordsSync();
    assertEqual(all.length, 2, "both records visible after refetch");
    const ids = all.map((r) => r.verified_id).sort();
    assertEqual(ids, ["fpA", "fpB"], "both emitters present");
  } finally {
    cleanup(cloneA);
    cleanup(cloneB);
    cleanup(bare);
  }
});

test("transport_git_ref_peer_high_water_for_returns_max_seq_per_verified_id", () => {
  const bare = mkBareRepo("phw");
  const clone = mkLocalClone(bare, "phw");
  try {
    const { createGitRefTransport } = require(TRANSPORT_GITREF);
    const tx = createGitRefTransport({
      repoDir: clone,
      refName: "refs/coc/coordination-gen0",
    });
    const recs = [
      {
        type: "heartbeat",
        verified_id: "fpA",
        person_id: "pA",
        seq: 0,
        prev_hash: null,
        ts: "2026-05-20T00:00:00Z",
        content: {},
        sig: "sa0",
      },
      {
        type: "heartbeat",
        verified_id: "fpA",
        person_id: "pA",
        seq: 1,
        prev_hash: "h",
        ts: "2026-05-20T00:01:00Z",
        content: {},
        sig: "sa1",
      },
      {
        type: "heartbeat",
        verified_id: "fpB",
        person_id: "pB",
        seq: 0,
        prev_hash: null,
        ts: "2026-05-20T00:02:00Z",
        content: {},
        sig: "sb0",
      },
    ];
    for (const r of recs) tx.appendRecordSync(r);
    assertEqual(tx.peerHighWaterForSync("fpA"), 1, "highest seq for fpA");
    assertEqual(tx.peerHighWaterForSync("fpB"), 0, "highest seq for fpB");
    assertEqual(
      tx.peerHighWaterForSync("fpUnknown"),
      null,
      "null for unknown emitter",
    );
  } finally {
    cleanup(clone);
    cleanup(bare);
  }
});

// ============================================================================
// Suite 2 — fold rule 9b (generation-rotation) — invariant 2
// ============================================================================
console.log("\n--- fold-rule-9b: generation-rotation (A3 invariant 2) ---");

function buildRotationRecord(keyA, keyB, opts) {
  const o = opts || {};
  const coreNoSig = {
    type: "generation-rotation",
    verified_id: keyA.fingerprint,
    person_id: "pid-A",
    seq: o.seq != null ? o.seq : 0,
    prev_hash: o.prev_hash !== undefined ? o.prev_hash : null,
    ts: "2026-05-20T00:00:00Z",
    content: {
      from_generation: o.from_generation != null ? o.from_generation : 0,
      to_generation: o.to_generation != null ? o.to_generation : 1,
      retained_chain_heads: o.retained_chain_heads || {},
      exempt_closure: o.exempt_closure || [],
      folded_state_digest:
        o.folded_state_digest != null ? o.folded_state_digest : "digest-abc",
      archive_genN_tip_pin:
        o.archive_genN_tip_pin != null
          ? o.archive_genN_tip_pin
          : { ref: "refs/coc/archive-gen0", tip_sha: "0".repeat(40) },
      co_signers: [], // filled below
    },
  };
  if (o.omitArchivePin) delete coreNoSig.content.archive_genN_tip_pin;
  // Build co-signer sig over the core MINUS its co_signers field, then attach
  const { co_signers, ...coreForCoSig } = coreNoSig.content;
  const baseForCoSig = { ...coreNoSig, content: coreForCoSig };
  const coSigArr = [];
  if (!o.singleSigner) {
    coSigArr.push(coSign(baseForCoSig, keyB.keyPath, keyB.fingerprint));
  }
  coreNoSig.content.co_signers = coSigArr;
  return signRecord(coreNoSig, keyA.keyPath);
}

test("fold_rule_9b_accepts_2_of_n_cosigned_rotation_with_retained_chain_head_and_transitive_closure_and_archive_tip_pin", () => {
  const eng = require(ENGINE);
  const fold9b = require(FOLD_RULE_9B);
  const kA = mkEphemeralSshKey("9b-acc-A");
  const kB = mkEphemeralSshKey("9b-acc-B");
  try {
    const sandbox = eng.createEngine({ inheritDefaults: true });
    sandbox.registerFoldPredicate(
      "generation-rotation",
      fold9b.foldGenerationRotation,
      {
        checkpoint_exempt: true,
        authoritative_for_record: true,
        authoritative_for_aggregate: false,
      },
    );
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const rotation = buildRotationRecord(kA, kB, {
      seq: 0,
      prev_hash: null,
      retained_chain_heads: {
        [kA.fingerprint]: { lastSeq: 5, lastContentHash: "abc" },
      },
      exempt_closure: [
        { type: "clone-init", verified_id: kA.fingerprint, seq: 0 },
      ],
      folded_state_digest: "d-acc",
      archive_genN_tip_pin: {
        ref: "refs/coc/archive-gen0",
        tip_sha: "f".repeat(40),
      },
    });
    const r = sandbox.foldLog([rotation], roster, {});
    assertEqual(
      r.accepted.length,
      1,
      `rotation accepted; rejected: ${JSON.stringify(r.rejected)}`,
    );
    assertEqual(r.rejected.length, 0, "no rejection");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9b_rejects_single_signer_rotation", () => {
  const eng = require(ENGINE);
  const fold9b = require(FOLD_RULE_9B);
  const kA = mkEphemeralSshKey("9b-single-A");
  const kB = mkEphemeralSshKey("9b-single-B"); // present in roster but NOT co-signing
  try {
    const sandbox = eng.createEngine({ inheritDefaults: true });
    sandbox.registerFoldPredicate(
      "generation-rotation",
      fold9b.foldGenerationRotation,
    );
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const rotation = buildRotationRecord(kA, kB, { singleSigner: true });
    const r = sandbox.foldLog([rotation], roster, {});
    assertEqual(r.accepted.length, 0, "single-signer rejected");
    assert(r.rejected.length === 1, "one rejection");
    assert(
      /2-of-N|co.sign|distinct/i.test(r.rejected[0].reason),
      `reason names co-sign requirement; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9b_rejects_rotation_missing_archive_tip_pin", () => {
  const eng = require(ENGINE);
  const fold9b = require(FOLD_RULE_9B);
  const kA = mkEphemeralSshKey("9b-noarch-A");
  const kB = mkEphemeralSshKey("9b-noarch-B");
  try {
    const sandbox = eng.createEngine({ inheritDefaults: true });
    sandbox.registerFoldPredicate(
      "generation-rotation",
      fold9b.foldGenerationRotation,
    );
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const rotation = buildRotationRecord(kA, kB, { omitArchivePin: true });
    const r = sandbox.foldLog([rotation], roster, {});
    assertEqual(r.accepted.length, 0, "missing archive pin rejected");
    assert(
      /archive.tip.pin|archive_genN_tip_pin|archive.pin/i.test(
        r.rejected[0].reason,
      ),
      `reason names archive-pin; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9b_transitively_re_anchors_prior_archive_tips_across_rotations", () => {
  // R9-A-01: a generation-rotation MUST transitively re-anchor every prior
  // archive-genM tip pin (M < N) embedded in folded checkpoint records.
  // We test this by verifying the predicate's accepted output carries
  // prior_archive_tip_pins enumerated from the engine's accepted record set.
  const fold9b = require(FOLD_RULE_9B);
  // Build a fake foldState that the predicate's transitive re-anchor reads.
  const kA = mkEphemeralSshKey("9b-trans-A");
  const kB = mkEphemeralSshKey("9b-trans-B");
  try {
    // Predicate ctx — simulate two prior checkpoints with archive pins.
    const ctx = {
      foldState: { trustRoot: null, archive_tip_pins: {} },
      roster: makeRoster({
        "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
        "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
      }),
      acceptedSoFar: [
        // Pretend two earlier checkpoints landed; each pinned its archive ref.
        {
          type: "compaction-checkpoint",
          verified_id: kA.fingerprint,
          seq: 10,
          content: {
            archive_genN_tip_hash: "aa".repeat(20),
            archive_ref_name: "refs/coc/archive-gen0",
          },
        },
        {
          type: "compaction-checkpoint",
          verified_id: kA.fingerprint,
          seq: 20,
          content: {
            archive_genN_tip_hash: "bb".repeat(20),
            archive_ref_name: "refs/coc/archive-gen1",
          },
        },
      ],
    };
    const rotation = buildRotationRecord(kA, kB, {
      from_generation: 2,
      to_generation: 3,
      archive_genN_tip_pin: {
        ref: "refs/coc/archive-gen2",
        tip_sha: "c".repeat(40),
      },
    });
    const result = fold9b.foldGenerationRotation(rotation, ctx);
    assertEqual(
      result.accepted,
      true,
      `rotation accepted; reason: ${result.reason || ""}`,
    );
    const carried = result.foldState && result.foldState.archive_tip_pins;
    assert(carried, "foldState carries archive_tip_pins");
    // R9-A-01: both prior gens AND the new pin survive
    assert(carried["refs/coc/archive-gen0"], "gen0 archive tip preserved");
    assert(carried["refs/coc/archive-gen1"], "gen1 archive tip preserved");
    assert(
      carried["refs/coc/archive-gen2"],
      "gen2 (newly rotated) archive tip pinned",
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// ============================================================================
// Suite 3 — fold rule 9c (genesis-migration) — invariant 3
// ============================================================================
console.log("\n--- fold-rule-9c: genesis-migration (A3 invariant 3) ---");

function buildMigrationRecord(keyA, keyB, opts) {
  const o = opts || {};
  const coreNoSig = {
    type: "genesis-migration",
    verified_id: keyA.fingerprint,
    person_id: "pid-A",
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
      // M3 HIGH-4 / F-7: capture_ts lives INSIDE the gh_api_repo_owner_capture
      // (the allowlist's output shape). The freshness predicate reads
      // capture.capture_ts, not content.capture_ts.
      gh_api_repo_owner_capture:
        o.gh_api_repo_owner_capture !== undefined
          ? o.gh_api_repo_owner_capture
          : {
              owner: { login: "new-owner-Z", type: "User" },
              name: "repo",
              full_name: "new-owner-Z/repo",
              capture_ts: o.capture_ts || o.ts || "2026-05-20T00:00:00Z",
            },
      co_signers: [],
    },
  };
  if (o.omitOwnerCapture) delete coreNoSig.content.gh_api_repo_owner_capture;
  const { co_signers, ...coreForCoSig } = coreNoSig.content;
  const baseForCoSig = { ...coreNoSig, content: coreForCoSig };
  if (!o.singleSigner && keyB) {
    coreNoSig.content.co_signers.push(
      coSign(baseForCoSig, keyB.keyPath, keyB.fingerprint),
    );
  }
  return signRecord(coreNoSig, keyA.keyPath);
}

test("fold_rule_9c_accepts_2_of_n_cosigned_migration_with_fresh_gh_api_owner_and_incremented_generation", () => {
  const eng = require(ENGINE);
  const fold9c = require(FOLD_RULE_9C);
  const kA = mkEphemeralSshKey("9c-acc-A");
  const kB = mkEphemeralSshKey("9c-acc-B");
  try {
    const sandbox = eng.createEngine({ inheritDefaults: true });
    sandbox.registerFoldPredicate(
      "genesis-migration",
      fold9c.foldGenesisMigration,
    );
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const migration = buildMigrationRecord(kA, kB, {
      from_genesis_generation: 0,
      to_genesis_generation: 1,
      new_repo_owner: "new-owner-Z",
      gh_api_repo_owner_capture: {
        owner: { login: "new-owner-Z", type: "User" },
        name: "repo",
        full_name: "new-owner-Z/repo",
        capture_ts: "2026-05-20T00:00:00Z",
      },
    });
    const r = sandbox.foldLog([migration], roster, {});
    assertEqual(
      r.accepted.length,
      1,
      `migration accepted; rejected: ${JSON.stringify(r.rejected)}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9c_rejects_degenerate_self_signed_migration_even_under_genuine_genesis_n1", () => {
  // R6-S-04: NO degenerate self-sign for genesis-migration even when N=1.
  const eng = require(ENGINE);
  const fold9c = require(FOLD_RULE_9C);
  const kA = mkEphemeralSshKey("9c-self-A");
  try {
    const sandbox = eng.createEngine({ inheritDefaults: true });
    sandbox.registerFoldPredicate(
      "genesis-migration",
      fold9c.foldGenesisMigration,
    );
    // Genuine N=1 roster: only one owner.
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
    });
    // Migration with empty co_signers — degenerate self-sign attempt.
    const migration = buildMigrationRecord(kA, null, { singleSigner: true });
    const r = sandbox.foldLog([migration], roster, {});
    assertEqual(r.accepted.length, 0, "degenerate self-sign rejected");
    assert(r.rejected.length === 1, "one rejection");
    assert(
      /R6-S-04|self.sign|degenerate|2-of-N|co.sign|2 of N/i.test(
        r.rejected[0].reason,
      ),
      `reason names R6-S-04 / degenerate / co-sign; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
  }
});

test("fold_rule_9c_rejects_stale_gh_api_capture", () => {
  const eng = require(ENGINE);
  const fold9c = require(FOLD_RULE_9C);
  const kA = mkEphemeralSshKey("9c-stale-A");
  const kB = mkEphemeralSshKey("9c-stale-B");
  try {
    const sandbox = eng.createEngine({ inheritDefaults: true });
    sandbox.registerFoldPredicate(
      "genesis-migration",
      fold9c.foldGenesisMigration,
    );
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Stale: gh_api_repo_owner_capture's owner.login does NOT match new_repo_owner.
    const migration = buildMigrationRecord(kA, kB, {
      new_repo_owner: "new-owner-Z",
      gh_api_repo_owner_capture: {
        owner: { login: "different-owner", type: "User" },
        capture_ts: "2026-05-20T00:00:00Z",
      },
    });
    const r = sandbox.foldLog([migration], roster, {});
    assertEqual(r.accepted.length, 0, "stale gh-api capture rejected");
    assert(
      /gh.api|owner|capture|mismatch/i.test(r.rejected[0].reason),
      `reason names gh-api owner mismatch; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9c_supersedes_prior_anchor_via_r6_s_06_latest_wins", () => {
  // R6-S-06: a verifying genesis-migration supersedes the prior trust root.
  const fold9c = require(FOLD_RULE_9C);
  const kA = mkEphemeralSshKey("9c-sup-A");
  const kB = mkEphemeralSshKey("9c-sup-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Establish a prior trust root in foldState (as if from rule 9a).
    const ctx = {
      foldState: {
        trustRoot: {
          verified_id: "old-owner-fp",
          person_id: "pid-old",
          seq: 0,
          ts: "2026-04-01T00:00:00Z",
          pinnedFacts: {
            repo_owner: "owner-A",
            repo_owner_kind: "user",
            root_commit: "rootABC",
          },
          genesis_generation: 0,
        },
      },
      roster,
      acceptedSoFar: [],
    };
    const migration = buildMigrationRecord(kA, kB, {
      from_genesis_generation: 0,
      to_genesis_generation: 1,
      new_repo_owner: "new-owner-Z",
      gh_api_repo_owner_capture: {
        owner: { login: "new-owner-Z", type: "User" },
        capture_ts: "2026-05-20T00:00:00Z",
      },
    });
    const result = fold9c.foldGenesisMigration(migration, ctx);
    assertEqual(
      result.accepted,
      true,
      `migration superseded; reason: ${result.reason || ""}`,
    );
    assert(
      result.foldState && result.foldState.trustRoot,
      "trustRoot present after migration",
    );
    assertEqual(
      result.foldState.trustRoot.pinnedFacts.repo_owner,
      "new-owner-Z",
      "trust root rebased to new external owner (R6-S-06 latest wins)",
    );
    assertEqual(
      result.foldState.trustRoot.genesis_generation,
      1,
      "genesis_generation incremented",
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// ============================================================================
// Suite 4 — fold rule 9d (post-migration partition detection) — invariant 4
// ============================================================================
console.log("\n--- fold-rule-9d: partition detection (A3 invariant 4) ---");

test("fold_rule_9d_detects_local_below_peer_high_water_genesis_generation", () => {
  const fold9d = require(FOLD_RULE_9D);
  const kA = mkEphemeralSshKey("9d-below-A");
  const kB = mkEphemeralSshKey("9d-below-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Folded log contains a signed migration to gen=5; local genesis is gen=0.
    const acceptedRecords = [
      buildMigrationRecord(kA, kB, {
        from_genesis_generation: 4,
        to_genesis_generation: 5,
      }),
    ];
    const out = fold9d.detectPostMigrationPartition({
      localGenesisGeneration: 0,
      acceptedRecords,
      roster,
    });
    assertEqual(
      out.partitioned,
      true,
      "local below peer high-water → partitioned",
    );
    assertEqual(out.local_genesis_generation, 0, "local generation reported");
    assertEqual(
      out.peer_high_water_generation,
      5,
      "peer high-water from signed record",
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9d_uses_signed_migration_records_not_ref_name", () => {
  // The ref name `coordination-gen7` is ADVISORY; the authoritative
  // peer high-water is the signed migration record's to_genesis_generation.
  // We pass a misleading refName but a signed record with a different value.
  const fold9d = require(FOLD_RULE_9D);
  const kA = mkEphemeralSshKey("9d-name-A");
  const kB = mkEphemeralSshKey("9d-name-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Signed record says to_generation=3, ref name says gen=7. Authoritative = 3.
    const acceptedRecords = [
      buildMigrationRecord(kA, kB, {
        from_genesis_generation: 2,
        to_genesis_generation: 3,
      }),
    ];
    const out = fold9d.detectPostMigrationPartition({
      localGenesisGeneration: 1,
      acceptedRecords,
      roster,
      currentRefName: "refs/coc/coordination-gen7", // misleading but ignored
    });
    assertEqual(
      out.peer_high_water_generation,
      3,
      "ignores ref-name; uses signed record's to_genesis_generation",
    );
    assertEqual(out.partitioned, true, "local (1) below peer (3)");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("fold_rule_9d_returns_partitioned_false_when_local_at_peer_high_water", () => {
  const fold9d = require(FOLD_RULE_9D);
  const kA = mkEphemeralSshKey("9d-eq-A");
  const kB = mkEphemeralSshKey("9d-eq-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const acceptedRecords = [
      buildMigrationRecord(kA, kB, {
        from_genesis_generation: 0,
        to_genesis_generation: 2,
      }),
    ];
    const out = fold9d.detectPostMigrationPartition({
      localGenesisGeneration: 2,
      acceptedRecords,
      roster,
    });
    assertEqual(
      out.partitioned,
      false,
      "local == peer high-water → no partition",
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// ============================================================================
// Suite 5 — cold archive ref helpers + engine dispatch (invariant 5)
// ============================================================================
console.log("\n--- cold archive ref + engine dispatch (A3 invariant 5) ---");

test("archive_ref_pin_round_trip_verifies", () => {
  const ar = require(ARCHIVE_REF);
  const checkpoint = { type: "compaction-checkpoint", content: {} };
  const ref = "refs/coc/archive-gen0";
  const tip = "a".repeat(40);
  const pinned = ar.pinArchiveTip(checkpoint, ref, tip);
  // Verify reading back finds the pin.
  const v = ar.verifyArchiveTipPin(pinned, ref, tip);
  assertEqual(v.match, true, "matching tip round-trips");
});

test("archive_ref_pin_mismatch_detected", () => {
  const ar = require(ARCHIVE_REF);
  const checkpoint = { type: "compaction-checkpoint", content: {} };
  const ref = "refs/coc/archive-gen0";
  const pinned = ar.pinArchiveTip(checkpoint, ref, "a".repeat(40));
  const v = ar.verifyArchiveTipPin(pinned, ref, "b".repeat(40));
  assertEqual(v.match, false, "mismatched tip detected");
  assert(
    /mismatch|drift|expected|tip/i.test(v.reason),
    `mismatch reason explains; got: ${v.reason}`,
  );
});

test("engine_dispatches_generation_rotation_to_fold_rule_9b", () => {
  const eng = require(ENGINE);
  const fold9b = require(FOLD_RULE_9B);
  // Register A3 dispatchers and verify the registry binds.
  const sandbox = eng.createEngine({ inheritDefaults: true });
  sandbox.registerFoldPredicate(
    "generation-rotation",
    fold9b.foldGenerationRotation,
  );
  const meta = sandbox.predicateMetadataFor("generation-rotation");
  assert(meta, "generation-rotation predicate metadata present");
});

test("engine_dispatches_genesis_migration_to_fold_rule_9c", () => {
  const eng = require(ENGINE);
  const fold9c = require(FOLD_RULE_9C);
  const sandbox = eng.createEngine({ inheritDefaults: true });
  sandbox.registerFoldPredicate(
    "genesis-migration",
    fold9c.foldGenesisMigration,
  );
  const meta = sandbox.predicateMetadataFor("genesis-migration");
  assert(meta, "genesis-migration predicate metadata present");
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n--- summary: ${PASS} pass / ${FAIL} fail ---`);
if (FAIL > 0) {
  for (const f of FAILS) console.log(`  ${f}`);
  process.exit(1);
}
process.exit(0);
