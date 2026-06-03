/**
 * Tier-2 integration tests for shard A2a (workspaces/multi-operator-coc,
 * design v11 §2.2 fold rules 1-8 + record-type dispatch table +
 * predicate-registration API).
 *
 * Per rules/testing.md 3-Tier: real ssh-keygen + real canonicalSerialize +
 * real coc-sign verify. The fold engine is a pure function over an
 * INJECTED `peerHighWaterFor` callback; no transport / fs / network.
 *
 * Nine invariants per the shard contract (workspaces/multi-operator-coc/
 * todos/active/00-todos.md § A2a):
 *   (1) Fold rule 1 — signature verification gate.
 *   (2) Fold rule 2 — per-emitter chain integrity (seq + prev_hash).
 *   (3) Fold rule 3 — fork detection (same (verified_id, seq), diff hash).
 *   (4) Fold rule 4 — mutation scoping (emitter only; co-signed exceptions).
 *   (5) Fold rule 5 — checkpoint reconciliation (2-of-N + retained head +
 *       transitive closure + digest + archive-genN tip pin).
 *   (6) Fold rule 6 — checkpoint-exempt GENERIC + two-tier retention.
 *   (7) Fold rule 7 — liveness as read-time fold predicate (LIVENESS_TTL).
 *   (8) Fold rule 8 — partial-push gap advisory (claim/release vs heartbeat).
 *   (9) Record-type dispatch table + predicate-registration API + engine.
 *
 * Run: node tests/integration/coordination-log.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const ENGINE = path.join(LIB_DIR, "coordination-log.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");

// ---- minimal test harness ---------------------------------------------------
let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const FAILS = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r === "skip") {
      SKIP += 1;
      console.log(`  SKIP  ${name}`);
      return;
    }
    PASS += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    FAIL += 1;
    FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
    console.log(`  FAIL  ${name}`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-cl-${label}-`));
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
    `coc-cl-test-${label}`,
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
    // best-effort
  }
}

// ---- record helpers ---------------------------------------------------------
function contentHash(core) {
  // hash matches coordination-log.js::_canonicalHash — sha256(canonicalSerialize)
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
// Suite 1 — engine framework + registration API (invariant 9)
// ============================================================================
console.log("\n--- engine framework + registration API (A2a invariant 9) ---");

test("engine_exports_foldLog_and_registerFoldPredicate", () => {
  const eng = require(ENGINE);
  assert(typeof eng.foldLog === "function", "foldLog must be a function");
  assert(
    typeof eng.registerFoldPredicate === "function",
    "registerFoldPredicate must be a function",
  );
  assert(
    typeof eng.isCheckpointExempt === "function",
    "isCheckpointExempt exported",
  );
  assert(typeof eng.LIVENESS_TTL_MS === "number", "LIVENESS_TTL_MS exported");
});

test("engine_returns_accepted_rejected_forks_advisories_arrays", () => {
  const { foldLog } = require(ENGINE);
  const roster = makeRoster({});
  const r = foldLog([], roster, {});
  assert(Array.isArray(r.accepted), "accepted is array");
  assert(Array.isArray(r.rejected), "rejected is array");
  assert(Array.isArray(r.forks), "forks is array");
  assert(Array.isArray(r.advisories), "advisories is array");
  assert(r.foldState && typeof r.foldState === "object", "foldState is object");
});

test("engine_register_predicate_returns_metadata", () => {
  const eng = require(ENGINE);
  // Register on a custom one-shot engine context so we don't pollute the
  // process-wide registry. The default engine MUST also accept registration.
  const sandbox = eng.createEngine();
  sandbox.registerFoldPredicate(
    "test-custom-type",
    (record, ctx) => ({ accepted: true }),
    { checkpoint_exempt: false, authoritative_for_record: false },
  );
  const meta = sandbox.predicateMetadataFor("test-custom-type");
  assert(meta, "metadata returned");
  assertEqual(meta.checkpoint_exempt, false, "checkpoint_exempt persisted");
  assertEqual(
    meta.authoritative_for_record,
    false,
    "authoritative_for_record persisted",
  );
});

test("engine_rejects_unregistered_record_type_with_reason", () => {
  const eng = require(ENGINE);
  const k = mkEphemeralSshKey("dispatch-unknown");
  try {
    // Real ed25519 key in roster so rule 1 passes; then a sandbox engine
    // with inheritDefaults:false to remove every predicate so the dispatch
    // step is the only thing that can reject.
    const sandbox = eng.createEngine({ inheritDefaults: false });
    const roster = makeRoster({
      "pid-x": ownerPerson("owner-X", k.fingerprint, k.pubKey),
    });
    const core = {
      type: "totally-made-up-type",
      verified_id: k.fingerprint,
      person_id: "pid-x",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const record = signRecord(core, k.keyPath);
    const r = sandbox.foldLog([record], roster, {});
    assertEqual(r.rejected.length, 1, "one rejected");
    assert(
      /unknown record type|no predicate registered/i.test(r.rejected[0].reason),
      `reason names the missing registration; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 2 — fold rule 1: signature verification gate (invariant 1)
// ============================================================================
console.log("\n--- fold rule 1: signature verification gate ---");

test("rule_1_rejects_record_with_invalid_signature", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r1-bad-sig");
  try {
    const roster = makeRoster(
      {
        "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
      },
      undefined,
    );
    const core = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    // Sign then tamper the sig: invalid signature.
    const record = signRecord(core, k.keyPath);
    record.sig = record.sig.replace(/^([\s\S]{40})/, "$1TAMPERED");
    const r = foldLog([record], roster, {});
    assertEqual(r.accepted.length, 0, "tampered sig MUST NOT accept");
    assertEqual(r.rejected.length, 1, "one rejected");
    assert(
      /sig|signature|verify/i.test(r.rejected[0].reason),
      `reason names signature failure; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(k.dir);
  }
});

test("rule_1_rejects_record_signed_by_unrostered_key", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r1-no-roster");
  try {
    // Roster has NO entry for this key's fingerprint
    const roster = makeRoster({}, undefined);
    const core = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-rogue",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const record = signRecord(core, k.keyPath);
    const r = foldLog([record], roster, {});
    assertEqual(r.accepted.length, 0, "unrostered signer MUST NOT accept");
    assertEqual(r.rejected.length, 1, "one rejected");
    assert(
      /not in roster|unrostered|no roster key|verified_id/i.test(
        r.rejected[0].reason,
      ),
      `reason names rostered-key absence; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(k.dir);
  }
});

test("rule_1_distinctness_records_advisory_for_aggregate", () => {
  // Per architecture §2.2 rule 1 fine-print: operator-register + clone-init +
  // collaborator-distinctness-attestation/-revocation fold ADVISORY for
  // authority of the record itself but checkpoint-exempt witnesses AND
  // authority-bearing input for AGGREGATE (derived-N).
  // The engine surfaces both bits via predicateMetadataFor.
  const eng = require(ENGINE);
  const metaAtt = eng.predicateMetadataFor(
    "collaborator-distinctness-attestation",
  );
  assert(metaAtt, "attestation metadata registered");
  assertEqual(metaAtt.authoritative_for_record, false, "advisory for record");
  assertEqual(
    metaAtt.authoritative_for_aggregate,
    true,
    "authoritative for aggregate",
  );
  const metaRev = eng.predicateMetadataFor(
    "collaborator-distinctness-revocation",
  );
  assert(metaRev, "revocation metadata registered");
  assertEqual(metaRev.authoritative_for_record, false, "advisory for record");
  assertEqual(
    metaRev.authoritative_for_aggregate,
    true,
    "authoritative for aggregate",
  );
});

// ============================================================================
// Suite 3 — fold rule 2: per-emitter chain integrity (invariant 2)
// ============================================================================
console.log("\n--- fold rule 2: per-emitter chain integrity ---");

test("rule_2_accepts_seq_exactly_plus_one_with_matching_prev_hash", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r2-chain-ok");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    const core0 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const r0 = signRecord(core0, k.keyPath);
    const core1 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 1,
      prev_hash: contentHash(core0),
      ts: "2026-05-20T00:01:00Z",
      content: {},
    };
    const r1 = signRecord(core1, k.keyPath);
    const r = foldLog([r0, r1], roster, {});
    assertEqual(r.accepted.length, 2, "both accepted");
    assertEqual(r.rejected.length, 0, "no rejection");
  } finally {
    cleanup(k.dir);
  }
});

test("rule_2_rejects_stale_seq", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r2-stale");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    const core0 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const r0 = signRecord(core0, k.keyPath);
    // Second record with seq=0 again — stale, should reject (or fork-detect)
    const core1 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:01:00Z",
      content: { duplicate: true },
    };
    const r1 = signRecord(core1, k.keyPath);
    const r = foldLog([r0, r1], roster, {});
    // Either rejected (stale seq) or detected as fork — both are correct rule
    // dispositions for "same verified_id, same seq, different content".
    // Rule 3 governs fork detection; rule 2 governs stale-seq rejection.
    // The engine MUST surface SOMETHING (not silent-accept).
    assertEqual(r.accepted.length, 1, "only first record accepted");
    assert(
      r.rejected.length >= 1 || r.forks.length >= 1,
      "second record must be rejected OR flagged as fork",
    );
  } finally {
    cleanup(k.dir);
  }
});

test("rule_2_rejects_broken_prev_hash", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r2-broken-prev");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    const core0 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const r0 = signRecord(core0, k.keyPath);
    // seq=1 but prev_hash refers to a non-existent record
    const core1 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 1,
      prev_hash: "deadbeef".repeat(8),
      ts: "2026-05-20T00:01:00Z",
      content: {},
    };
    const r1 = signRecord(core1, k.keyPath);
    const r = foldLog([r0, r1], roster, {});
    assertEqual(r.accepted.length, 1, "only first record accepted");
    assertEqual(r.rejected.length, 1, "second record rejected");
    assert(
      /prev_hash|hash chain|broken chain/i.test(r.rejected[0].reason),
      `reason names chain-break; got: ${r.rejected[0].reason}`,
    );
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 4 — fold rule 3: fork detection (invariant 3)
// ============================================================================
console.log("\n--- fold rule 3: fork detection ---");

test("rule_3_detects_fork_on_same_verified_id_same_seq_different_content", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r3-fork");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    const core0 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { branch: "a" },
    };
    const r0 = signRecord(core0, k.keyPath);
    // Same emitter+seq, DIFFERENT content → fork
    const core0b = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:01Z",
      content: { branch: "b" },
    };
    const r0b = signRecord(core0b, k.keyPath);
    const r = foldLog([r0, r0b], roster, {});
    assertEqual(r.forks.length, 1, "one fork detected");
    const f = r.forks[0];
    assertEqual(
      f.verified_id,
      k.fingerprint,
      "fork names the forker via verified_id",
    );
    assertEqual(f.seq, 0, "fork at correct seq");
    assert(f.hash_a && f.hash_b, "both content hashes captured");
    assert(f.hash_a !== f.hash_b, "hashes differ");
  } finally {
    cleanup(k.dir);
  }
});

test("rule_3_names_forker_via_verified_id", () => {
  // Re-asserts that the fork entry NAMES the equivocator via verified_id —
  // that is the cryptographic accountability surface.
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r3-name");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    const core0 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 5,
      prev_hash: "x".repeat(64),
      ts: "2026-05-20T00:00:00Z",
      content: { v: 1 },
    };
    const core0b = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 5,
      prev_hash: "x".repeat(64),
      ts: "2026-05-20T00:00:00Z",
      content: { v: 2 },
    };
    const r0 = signRecord(core0, k.keyPath);
    const r0b = signRecord(core0b, k.keyPath);
    const r = foldLog([r0, r0b], roster, {});
    assert(r.forks.length === 1, "fork detected");
    assertEqual(
      r.forks[0].verified_id,
      k.fingerprint,
      "forker named by verified_id (cryptographic identity)",
    );
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 5 — fold rule 4: mutation scoping (invariant 4)
// ============================================================================
console.log("\n--- fold rule 4: mutation scoping ---");

test("rule_4_rejects_record_whose_person_id_doesnt_match_signer", () => {
  // A record's person_id must resolve to the same person whose verified_id
  // matches one of that person's roster keys. Cross-person mutation is BLOCKED
  // unless the record type is one of the co-signed exception types.
  const { foldLog } = require(ENGINE);
  const kA = mkEphemeralSshKey("r4-A");
  const kB = mkEphemeralSshKey("r4-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // A signs but claims to be person B → mutation-scope violation
    const core = {
      type: "claim",
      verified_id: kA.fingerprint, // A's key
      person_id: "pid-B", // claims to be B
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { resource: "lock-1" },
    };
    const r = signRecord(core, kA.keyPath);
    const folded = foldLog([r], roster, {});
    assertEqual(folded.accepted.length, 0, "cross-person mutation rejected");
    assertEqual(folded.rejected.length, 1, "one rejected");
    assert(
      /mutation|person_id|cross-operator|emitter/i.test(
        folded.rejected[0].reason,
      ),
      `reason names mutation-scope; got: ${folded.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("rule_4_accepts_self_mutation_with_matching_person_id", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r4-self");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    const core = {
      type: "claim",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { resource: "lock-1" },
    };
    const r = signRecord(core, k.keyPath);
    const folded = foldLog([r], roster, {});
    assertEqual(folded.accepted.length, 1, "self-mutation accepted");
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 6 — fold rule 5: checkpoint reconciliation (invariant 5)
// ============================================================================
console.log("\n--- fold rule 5: checkpoint reconciliation ---");

test("rule_5_rejects_checkpoint_without_2_of_n_cosignature", () => {
  // A compaction-checkpoint MUST be 2-of-N owner-co-signed. A single-signer
  // checkpoint is invalid.
  const { foldLog } = require(ENGINE);
  const kA = mkEphemeralSshKey("r5-A");
  const kB = mkEphemeralSshKey("r5-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    const core = {
      type: "compaction-checkpoint",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        up_to_seq: { [kA.fingerprint]: 10 },
        retained_chain_heads: {},
        exempt_closure: [],
        folded_state_digest: "abc",
        archive_genN_tip_hash: "def",
        // co_signers missing or only one
      },
    };
    const r = signRecord(core, kA.keyPath);
    const folded = foldLog([r], roster, {});
    assertEqual(folded.accepted.length, 0, "single-signer checkpoint rejected");
    assertEqual(folded.rejected.length, 1, "one rejected");
    assert(
      /co.?sign|2.?of.?N|quorum|owner.cosign/i.test(folded.rejected[0].reason),
      `reason names cosig requirement; got: ${folded.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("rule_5_rejects_checkpoint_missing_required_fields", () => {
  const { foldLog } = require(ENGINE);
  const kA = mkEphemeralSshKey("r5-missing-A");
  const kB = mkEphemeralSshKey("r5-missing-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // Missing folded_state_digest, archive_genN_tip_hash, exempt_closure, etc.
    const core = {
      type: "compaction-checkpoint",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        up_to_seq: { [kA.fingerprint]: 10 },
        co_signers: [{ verified_id: kB.fingerprint, sig: "fakeBsig" }],
        // retained_chain_heads MISSING
      },
    };
    const r = signRecord(core, kA.keyPath);
    const folded = foldLog([r], roster, {});
    assertEqual(folded.accepted.length, 0, "incomplete checkpoint rejected");
    assertEqual(folded.rejected.length, 1, "one rejected");
    assert(
      /missing|required field|retained|digest|tip/i.test(
        folded.rejected[0].reason,
      ),
      `reason names missing fields; got: ${folded.rejected[0].reason}`,
    );
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

// ============================================================================
// Suite 7 — fold rule 6: checkpoint-exempt (invariant 6)
// ============================================================================
console.log("\n--- fold rule 6: checkpoint-exempt GENERIC ---");

test("rule_6_genesis_anchor_is_exempt", () => {
  const { isCheckpointExempt } = require(ENGINE);
  assert(isCheckpointExempt("genesis-anchor"), "genesis-anchor exempt");
});

test("rule_6_clone_init_is_exempt", () => {
  const { isCheckpointExempt } = require(ENGINE);
  assert(isCheckpointExempt("clone-init"), "clone-init exempt");
});

test("rule_6_distinctness_records_are_exempt", () => {
  const { isCheckpointExempt } = require(ENGINE);
  assert(
    isCheckpointExempt("collaborator-distinctness-attestation"),
    "attestation exempt",
  );
  assert(
    isCheckpointExempt("collaborator-distinctness-revocation"),
    "revocation exempt",
  );
});

test("rule_6_owner_signed_types_are_exempt", () => {
  const { isCheckpointExempt } = require(ENGINE);
  assert(isCheckpointExempt("compaction-checkpoint"), "checkpoint exempt");
  assert(isCheckpointExempt("generation-rotation"), "rotation exempt");
  assert(isCheckpointExempt("genesis-migration"), "migration exempt");
  assert(isCheckpointExempt("reap"), "reap exempt (owner co-signed)");
});

test("rule_6_pure_liveness_churn_is_NOT_exempt", () => {
  const { isCheckpointExempt } = require(ENGINE);
  assertEqual(isCheckpointExempt("heartbeat"), false, "heartbeat NOT exempt");
  assertEqual(isCheckpointExempt("claim"), false, "claim NOT exempt");
  assertEqual(isCheckpointExempt("release"), false, "release NOT exempt");
  assertEqual(
    isCheckpointExempt("session-open"),
    false,
    "session-open NOT exempt",
  );
  assertEqual(
    isCheckpointExempt("session-close"),
    false,
    "session-close NOT exempt",
  );
  assertEqual(
    isCheckpointExempt("operator-register"),
    false,
    "operator-register NOT exempt",
  );
});

test("rule_6_unknown_record_type_defaults_to_exempt", () => {
  // Per architecture §2.2 rule 6: "A new record type is exempt-by-default
  // unless its registration explicitly justifies non-exemption."
  const { isCheckpointExempt } = require(ENGINE);
  assert(
    isCheckpointExempt("totally-novel-record-type-2027"),
    "unknown defaults to exempt",
  );
});

test("rule_6_registration_can_explicitly_mark_non_exempt", () => {
  const eng = require(ENGINE);
  const sandbox = eng.createEngine();
  sandbox.registerFoldPredicate(
    "custom-liveness-event",
    (record, ctx) => ({ accepted: true }),
    { checkpoint_exempt: false },
  );
  assertEqual(
    sandbox.isCheckpointExempt("custom-liveness-event"),
    false,
    "registered non-exempt respected",
  );
});

// ============================================================================
// Suite 8 — fold rule 7: liveness predicate (invariant 7)
// ============================================================================
console.log("\n--- fold rule 7: liveness predicate ---");

test("rule_7_session_live_iff_heartbeat_within_liveness_ttl_and_unclosed", () => {
  const { isSessionLive, LIVENESS_TTL_MS } = require(ENGINE);
  const nowMs = Date.parse("2026-05-20T00:30:00Z");
  // Recent heartbeat (5 minutes ago), unclosed
  const result = isSessionLive({
    lastHeartbeatTs: "2026-05-20T00:25:00Z",
    sessionClosed: false,
    now: nowMs,
  });
  assertEqual(result.live, true, "session live with recent heartbeat");
});

test("rule_7_session_dead_when_heartbeat_older_than_liveness_ttl", () => {
  const { isSessionLive, LIVENESS_TTL_MS } = require(ENGINE);
  const nowMs = Date.parse("2026-05-20T01:00:00Z");
  // Heartbeat 21 minutes ago — older than 20-minute TTL
  const result = isSessionLive({
    lastHeartbeatTs: "2026-05-20T00:39:00Z",
    sessionClosed: false,
    now: nowMs,
  });
  assertEqual(result.live, false, "session dead when heartbeat > TTL");
});

test("rule_7_session_dead_when_closed_even_with_recent_heartbeat", () => {
  const { isSessionLive } = require(ENGINE);
  const nowMs = Date.parse("2026-05-20T00:30:00Z");
  const result = isSessionLive({
    lastHeartbeatTs: "2026-05-20T00:29:00Z",
    sessionClosed: true,
    now: nowMs,
  });
  assertEqual(
    result.live,
    false,
    "explicit close ends session regardless of heartbeat",
  );
});

test("rule_7_claim_active_iff_unexpired_session_live_unreleased", () => {
  const { isClaimActive } = require(ENGINE);
  const nowMs = Date.parse("2026-05-20T00:30:00Z");
  // Unexpired (expires in future), session live, unreleased/unreaped
  const r1 = isClaimActive({
    expiresAtTs: "2026-05-20T01:00:00Z",
    sessionLive: true,
    released: false,
    reaped: false,
    now: nowMs,
  });
  assertEqual(r1.active, true, "claim active when all conditions hold");
  // Expired
  const r2 = isClaimActive({
    expiresAtTs: "2026-05-20T00:20:00Z",
    sessionLive: true,
    released: false,
    reaped: false,
    now: nowMs,
  });
  assertEqual(r2.active, false, "expired claim not active");
  // Session dead
  const r3 = isClaimActive({
    expiresAtTs: "2026-05-20T01:00:00Z",
    sessionLive: false,
    released: false,
    reaped: false,
    now: nowMs,
  });
  assertEqual(r3.active, false, "dead-session claim not active");
  // Released
  const r4 = isClaimActive({
    expiresAtTs: "2026-05-20T01:00:00Z",
    sessionLive: true,
    released: true,
    reaped: false,
    now: nowMs,
  });
  assertEqual(r4.active, false, "released claim not active");
});

// ============================================================================
// Suite 9 — fold rule 8: partial-push gap advisory (invariant 8)
// ============================================================================
console.log("\n--- fold rule 8: partial-push gap advisory ---");

test("rule_8_advisory_when_claim_seq_below_heartbeat_seq_high_water", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("r8-gap");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", k.fingerprint, k.pubKey),
    });
    // Heartbeat at seq 0, 1, 2 (high-water = 2). claim at seq 1 visible but
    // NO claim at seq >= 2 — but we have heartbeat 2 — selective push gap.
    const seq0 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const s0 = signRecord(seq0, k.keyPath);

    const seq1 = {
      type: "claim",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 1,
      prev_hash: contentHash(seq0),
      ts: "2026-05-20T00:00:30Z",
      content: { resource: "lock-1" },
    };
    const s1 = signRecord(seq1, k.keyPath);

    const seq2 = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 2,
      prev_hash: contentHash(seq1),
      ts: "2026-05-20T00:01:00Z",
      content: {},
    };
    const s2 = signRecord(seq2, k.keyPath);

    // Pass a peerHighWaterFor that claims peer saw heartbeat up to seq 5 —
    // gap between claim-high-water (1) and peer-high-water (5).
    const r = foldLog([s0, s1, s2], roster, {
      peerHighWaterFor: (verifiedId) => {
        if (verifiedId === k.fingerprint) return 5;
        return null;
      },
    });
    // Gap detection: claim visible seq=1; heartbeat visible seq=2; peer
    // high-water says 5. Advisory MUST fire.
    const advisories = r.advisories.filter(
      (a) => a.type === "partial-push-gap",
    );
    assert(advisories.length >= 1, "partial-push-gap advisory MUST fire");
    const a = advisories[0];
    assertEqual(a.verified_id, k.fingerprint, "advisory names the emitter");
    assert(a.gap_seq_range, "advisory carries gap_seq_range");
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 10 — M0 predicate dispatch integration (invariant 9)
// ============================================================================
console.log("\n--- M0 predicate dispatch integration ---");

test("engine_pre_registers_genesis_anchor_predicate", () => {
  const eng = require(ENGINE);
  const meta = eng.predicateMetadataFor("genesis-anchor");
  assert(meta, "genesis-anchor predicate registered");
});

test("engine_pre_registers_revocation_predicate", () => {
  const eng = require(ENGINE);
  const meta = eng.predicateMetadataFor("collaborator-distinctness-revocation");
  assert(meta, "revocation predicate registered");
});

test("engine_dispatches_genesis_anchor_to_fold_predicate", () => {
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("dispatch-anchor");
  try {
    const roster = makeRoster(
      {
        "pid-owner": ownerPerson("owner-A", k.fingerprint, k.pubKey),
      },
      {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "abc123",
        genesis_generation: 0,
      },
    );
    const core = {
      type: "genesis-anchor",
      verified_id: k.fingerprint,
      person_id: "pid-owner",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "owner-A",
          repo_owner_kind: "user",
          root_commit: "abc123",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "owner-A", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123", verified: true },
      },
    };
    const record = signRecord(core, k.keyPath);
    const r = foldLog([record], roster, {});
    assertEqual(r.accepted.length, 1, "genesis-anchor accepted via dispatch");
    // The fold state's trustRoot must be set (predicate side-effect)
    assert(r.foldState.trustRoot, "trust root set in fold state");
    assertEqual(
      r.foldState.trustRoot.verified_id,
      k.fingerprint,
      "trust root names the signer",
    );
  } finally {
    cleanup(k.dir);
  }
});

test("engine_dispatches_revocation_to_fold_rule_10", () => {
  // The revocation predicate needs ctx.victimChainEntries — the engine wires
  // this from observed records of the named victim.
  const { foldLog } = require(ENGINE);
  const kA = mkEphemeralSshKey("dispatch-rev-A");
  const kB = mkEphemeralSshKey("dispatch-rev-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // A revokes B. B has NO activity in the log — uncontested.
    const core = {
      type: "collaborator-distinctness-revocation",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T01:00:00Z",
      content: {
        github_login: "owner-B",
        evidence_window: {
          opens_at: "2026-05-20T00:00:00Z",
          closes_at: "2026-05-20T01:00:00Z",
          victim_chain_high_water_seq: 0,
        },
        gh_api_collaborators_capture: { logins: ["owner-A"] },
      },
    };
    const record = signRecord(core, kA.keyPath);
    const r = foldLog([record], roster, {});
    // No contradicting B-activity → accepted (uncontested at fold step).
    assertEqual(r.accepted.length, 1, "uncontested revocation accepted");
    assertEqual(r.contestedRevocations.length, 0, "no contested revocations");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("engine_surfaces_contested_revocations_from_fold_rule_10", () => {
  // B has activity AFTER the evidence window closes → revocation contested.
  const { foldLog } = require(ENGINE);
  const kA = mkEphemeralSshKey("contest-A");
  const kB = mkEphemeralSshKey("contest-B");
  try {
    const roster = makeRoster({
      "pid-A": ownerPerson("owner-A", kA.fingerprint, kA.pubKey),
      "pid-B": ownerPerson("owner-B", kB.fingerprint, kB.pubKey),
    });
    // B has a heartbeat at seq 5, ts AFTER evidence window closes
    const bHeartbeatCore = {
      type: "heartbeat",
      verified_id: kB.fingerprint,
      person_id: "pid-B",
      seq: 5,
      prev_hash: "x".repeat(64),
      ts: "2026-05-20T02:00:00Z",
      content: {},
    };
    const bHeartbeat = signRecord(bHeartbeatCore, kB.keyPath);

    // A revokes B — but evidence window closes at 01:00 while B's heartbeat
    // is at 02:00 → contradicting activity → contested.
    const revCore = {
      type: "collaborator-distinctness-revocation",
      verified_id: kA.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T01:00:00Z",
      content: {
        github_login: "owner-B",
        evidence_window: {
          opens_at: "2026-05-20T00:00:00Z",
          closes_at: "2026-05-20T01:00:00Z",
          victim_chain_high_water_seq: 3,
        },
        gh_api_collaborators_capture: { logins: ["owner-A"] },
      },
    };
    const rev = signRecord(revCore, kA.keyPath);

    // Order: heartbeat first, then revocation. Engine MUST surface contest.
    // Note rule 2 will reject bHeartbeat as seq=5 prev_hash doesn't match
    // (B has no chain in the log) — but the predicate still gets to see it
    // if the engine surfaces records to fold-rule-10 BEFORE applying rule 2.
    // We accept either disposition: the test verifies that when the engine
    // DOES feed B's signed activity into the revocation predicate, the
    // contest fires. To make this deterministic, pass bHeartbeat as a chain
    // continuation that DOES validate by chaining from a seq=0 root.
    const bSeq0Core = {
      type: "heartbeat",
      verified_id: kB.fingerprint,
      person_id: "pid-B",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T02:00:00Z",
      content: {},
    };
    const bSeq0 = signRecord(bSeq0Core, kB.keyPath);

    const r = foldLog([bSeq0, rev], roster, {});
    // bSeq0 is accepted (valid heartbeat). The revocation's evidence window
    // claims B's chain high-water at seq 3, but B's actually observed at
    // seq 0 with ts 02:00 (AFTER window closes). Contest fires.
    assert(r.contestedRevocations.length >= 1, "contested revocation surfaced");
    const c = r.contestedRevocations[0];
    assertEqual(c.forging_signer, kA.fingerprint, "forging signer named");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
  }
});

test("engine_computes_derived_n_via_derive_n_module", () => {
  // The engine exposes a derived-N helper that wraps lib/derive-n.js,
  // taking the engine's foldState + roster + trustRoot.
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("derived-n");
  try {
    const roster = makeRoster(
      {
        "pid-owner": ownerPerson("owner-A", k.fingerprint, k.pubKey),
      },
      {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "abc123",
        genesis_generation: 0,
      },
    );
    const anchorCore = {
      type: "genesis-anchor",
      verified_id: k.fingerprint,
      person_id: "pid-owner",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "owner-A",
          repo_owner_kind: "user",
          root_commit: "abc123",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "owner-A", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123", verified: true },
      },
    };
    const anchor = signRecord(anchorCore, k.keyPath);
    const r = foldLog([anchor], roster, {});
    assert(r.derivedN, "derivedN computed");
    assertEqual(
      r.derivedN.derived_N,
      1,
      "lone genesis owner counts via R9-A-03 (anchor IS the basis)",
    );
    assert(
      r.derivedN.live_logins.includes("owner-a"),
      "owner-a in live_logins (derive-n lowercases per PR #316 case-norm)",
    );
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 11 — Transport interface typedef export (invariant 9)
// ============================================================================
console.log("\n--- Transport interface contract ---");

test("engine_exports_transport_interface_typedef_doc", () => {
  // The Transport interface is JSDoc-only (typedef). Verify the file
  // documents it for A2b + A3 consumers.
  const src = fs.readFileSync(ENGINE, "utf8");
  assert(
    /@typedef\s+\{Object\}\s+Transport/i.test(src),
    "Transport typedef documented",
  );
  assert(/readAllRecords/.test(src), "readAllRecords method documented");
  assert(/appendRecord/.test(src), "appendRecord method documented");
  assert(/headHash/.test(src), "headHash method documented");
  assert(/peerHighWaterFor/.test(src), "peerHighWaterFor method documented");
});

// ---- summary ----------------------------------------------------------------
console.log(`\n${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
if (FAIL > 0) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
