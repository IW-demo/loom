/**
 * Tier-2 integration tests for shard C1 (workspaces/multi-operator-coc,
 * design v11 §6.1 + §6.2 + §6.3). Per `rules/testing.md` 3-Tier: real
 * ssh-keygen + real coc-sign + real roster lookup. No mocking of those
 * internals.
 *
 * Five invariants per the shard contract (workspaces/multi-operator-coc/
 * todos/active/00-todos.md § C1):
 *
 *   (1) `posture.json` v2 schema (repo_floor + operators + transition log)
 *       + operative posture = min(operator, floor); ladder + min helpers.
 *   (2) trust_root surfacing — folded cache of latest cached owner-bound
 *       genesis-anchor-or-migration (R6-S-06 latest-wins).
 *   (3) 5-case corrupt-state discrimination (read-only structural).
 *   (4) Genesis-generation partition signal — when fold-rule-9d reports
 *       partitioned, operative posture degrades to L3_SHARED_PLANNING.
 *   (5) `posture-event` predicate (engine-registered): upgrade requires
 *       distinct signer (anti-self-upgrade per trust-posture.md MUST-3);
 *       downgrade self-allowed; floor-set owner-only; violation advisory.
 *
 * Run: node tests/integration/posture-v2.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const POSTURE_V2 = path.join(LIB_DIR, "posture-v2.js");
const FOLD_POSTURE_EVENT = path.join(LIB_DIR, "fold-posture-event.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const COORDINATION_LOG = path.join(LIB_DIR, "coordination-log.js");

// ---- minimal test harness (mirrors sibling test files) -----------------------
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
function assertThrows(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg || "expected throw");
}

// ---- fixtures ----------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-c1-${label}-`));
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
    `coc-c1-test-${label}`,
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

function makeRoster({
  ownerKey,
  ownerLogin,
  otherKey,
  otherLogin,
  contributorKey,
  contributorLogin,
}) {
  const roster = {
    genesis: {
      repo_owner: ownerLogin,
      repo_owner_kind: "user",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-a": {
        display_id: "owner",
        role: "owner",
        github_login: ownerLogin,
        host_role: "human",
        keys: [
          {
            type: "ssh",
            fingerprint: ownerKey.fingerprint,
            pubkey: ownerKey.pubKey,
          },
        ],
      },
    },
  };
  if (otherKey) {
    roster.persons["pid-owner-b"] = {
      display_id: "owner-b",
      role: "owner",
      github_login: otherLogin,
      host_role: "human",
      keys: [
        {
          type: "ssh",
          fingerprint: otherKey.fingerprint,
          pubkey: otherKey.pubKey,
        },
      ],
    };
  }
  if (contributorKey) {
    roster.persons["pid-contrib-c"] = {
      display_id: "contributor",
      role: "contributor",
      github_login: contributorLogin,
      host_role: "human",
      keys: [
        {
          type: "ssh",
          fingerprint: contributorKey.fingerprint,
          pubkey: contributorKey.pubKey,
        },
      ],
    };
  }
  return roster;
}

// ============================================================================
// Suite 1 — `posture.json` v2 schema + operative-posture formula
// ============================================================================
console.log("\n--- posture-v2 schema + operative formula ---");

test("posture_v2_schema_validates_minimal_valid_shape", () => {
  const { validatePostureV2Schema } = require(POSTURE_V2);
  const valid = {
    schema_version: 2,
    repo_floor: {
      posture: "L5_DELEGATED",
      since: "2026-05-21T00:00:00Z",
      set_by: "pid-owner-a",
    },
    operators: {},
    _initialized: true,
    transition_history: [],
  };
  const r = validatePostureV2Schema(valid);
  assertEqual(r.valid, true, "minimal valid shape should validate");
  assertEqual(r.errors, [], "no errors expected");
});

test("posture_v2_schema_rejects_missing_schema_version", () => {
  const { validatePostureV2Schema } = require(POSTURE_V2);
  const r = validatePostureV2Schema({
    repo_floor: {
      posture: "L5_DELEGATED",
      since: "2026-05-21T00:00:00Z",
      set_by: "pid-owner-a",
    },
    operators: {},
  });
  assertEqual(r.valid, false, "missing schema_version must fail");
  assert(
    r.errors.some((e) => /schema_version/i.test(e)),
    "expected schema_version error",
  );
});

test("posture_v2_schema_rejects_missing_repo_floor", () => {
  const { validatePostureV2Schema } = require(POSTURE_V2);
  const r = validatePostureV2Schema({
    schema_version: 2,
    operators: {},
  });
  assertEqual(r.valid, false, "missing repo_floor must fail");
  assert(
    r.errors.some((e) => /repo_floor/i.test(e)),
    "expected repo_floor error",
  );
});

test("posture_v2_schema_rejects_unknown_posture_value", () => {
  const { validatePostureV2Schema } = require(POSTURE_V2);
  const r = validatePostureV2Schema({
    schema_version: 2,
    repo_floor: {
      posture: "L9_INVALID",
      since: "2026-05-21T00:00:00Z",
      set_by: "pid-owner-a",
    },
    operators: {},
  });
  assertEqual(r.valid, false, "unknown posture value must fail");
  assert(
    r.errors.some((e) => /unknown posture|invalid posture/i.test(e)),
    "expected posture-value error",
  );
});

test("compute_operative_posture_returns_min_of_operator_and_floor", () => {
  const { computeOperativePosture } = require(POSTURE_V2);
  const posture = {
    schema_version: 2,
    repo_floor: {
      posture: "L4_CONTINUOUS_INSIGHT",
      since: "x",
      set_by: "pid-owner-a",
    },
    operators: {
      "pid-owner-a": {
        posture: "L5_DELEGATED",
        since: "x",
        set_by: "pid-owner-b",
      },
    },
  };
  const r = computeOperativePosture(posture, "pid-owner-a");
  assertEqual(r.posture, "L4_CONTINUOUS_INSIGHT", "floor wins as min");
  assertEqual(r.source, "floor", "source must be floor (more restrictive)");
});

test("compute_operative_posture_defaults_new_operator_to_l2_supervised", () => {
  const { computeOperativePosture } = require(POSTURE_V2);
  const posture = {
    schema_version: 2,
    repo_floor: {
      posture: "L5_DELEGATED",
      since: "x",
      set_by: "pid-owner-a",
    },
    operators: {},
  };
  const r = computeOperativePosture(posture, "pid-new-operator");
  assertEqual(
    r.posture,
    "L2_SUPERVISED",
    "new operator defaults to L2_SUPERVISED",
  );
});

test("compute_operative_posture_defaults_floor_to_l5_delegated", () => {
  const { computeOperativePosture } = require(POSTURE_V2);
  const posture = {
    schema_version: 2,
    repo_floor: {},
    operators: {
      "pid-owner-a": {
        posture: "L4_CONTINUOUS_INSIGHT",
        since: "x",
        set_by: "pid-owner-a",
      },
    },
  };
  const r = computeOperativePosture(posture, "pid-owner-a");
  // Operator L4 vs default floor L5 → operator wins (L4 is more restrictive).
  assertEqual(r.posture, "L4_CONTINUOUS_INSIGHT", "operator wins as min");
});

test("min_posture_l1_l5_returns_l1", () => {
  const { minPosture } = require(POSTURE_V2);
  assertEqual(
    minPosture("L1_PSEUDO_AGENT", "L5_DELEGATED"),
    "L1_PSEUDO_AGENT",
    "L1 is the floor",
  );
});

test("min_posture_l3_l4_returns_l3", () => {
  const { minPosture } = require(POSTURE_V2);
  assertEqual(
    minPosture("L3_SHARED_PLANNING", "L4_CONTINUOUS_INSIGHT"),
    "L3_SHARED_PLANNING",
    "L3 < L4",
  );
});

// ============================================================================
// Suite 2 — V1 → V2 migration
// ============================================================================
console.log("\n--- v1 → v2 migration ---");

test("migrate_v1_to_v2_preserves_v1_posture_as_floor", () => {
  const { migrateV1ToV2 } = require(POSTURE_V2);
  const v1 = {
    posture: "L4_CONTINUOUS_INSIGHT",
    since: "2026-05-05T04:03:33.512Z",
    transition_history: [
      { from: null, to: "L5_DELEGATED", ts: "2026-05-05T00:00:00Z" },
    ],
    pending_verification: [],
    violation_window_30d: {},
    _initialized: true,
  };
  const v2 = migrateV1ToV2(v1);
  assertEqual(v2.schema_version, 2, "schema_version is 2");
  assertEqual(
    v2.repo_floor.posture,
    "L4_CONTINUOUS_INSIGHT",
    "v1 posture becomes repo_floor",
  );
  assertEqual(v2._initialized, true, "_initialized preserved");
});

test("migrate_v1_to_v2_initializes_empty_operators_map", () => {
  const { migrateV1ToV2 } = require(POSTURE_V2);
  const v1 = {
    posture: "L5_DELEGATED",
    since: "2026-05-05T04:03:33.512Z",
    _initialized: true,
  };
  const v2 = migrateV1ToV2(v1);
  assertEqual(v2.operators, {}, "operators map starts empty");
});

// ============================================================================
// Suite 3 — Trust-root surfacing
// ============================================================================
console.log("\n--- trust_root surfacing (R6-S-06 latest-wins) ---");

test("resolve_trust_root_returns_latest_owner_bound_anchor", () => {
  const { resolveTrustRoot } = require(POSTURE_V2);
  const ownerKey = mkEphemeralSshKey("trust-root-a");
  try {
    const acceptedRecords = [
      {
        type: "genesis-anchor",
        seq: 0,
        ts: "2026-05-20T00:00:00Z",
        verified_id: ownerKey.fingerprint,
        content: {
          pinned: { repo_owner: "owner-login", root_commit: "abc123def456" },
          genesis_generation: 0,
        },
      },
    ];
    const roster = makeRoster({
      ownerKey,
      ownerLogin: "owner-login",
    });
    const r = resolveTrustRoot(acceptedRecords, roster);
    assert(r !== null, "trust_root must resolve");
    assertEqual(r.verified_id, ownerKey.fingerprint, "verified_id matches");
    assertEqual(r.genesis_generation, 0, "genesis_generation matches");
    assertEqual(r.anchor_record_seq, 0, "anchor_record_seq matches");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("resolve_trust_root_returns_null_when_no_anchor", () => {
  const { resolveTrustRoot } = require(POSTURE_V2);
  const ownerKey = mkEphemeralSshKey("no-anchor");
  try {
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const r = resolveTrustRoot([], roster);
    assertEqual(r, null, "no anchor → null trust_root");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("resolve_trust_root_supersedes_genesis_anchor_with_migration_per_r6_s_06", () => {
  const { resolveTrustRoot } = require(POSTURE_V2);
  const ownerKey = mkEphemeralSshKey("r6s06");
  try {
    const acceptedRecords = [
      {
        type: "genesis-anchor",
        seq: 0,
        ts: "2026-05-20T00:00:00Z",
        verified_id: ownerKey.fingerprint,
        content: { genesis_generation: 0 },
      },
      {
        type: "genesis-migration",
        seq: 5,
        ts: "2026-05-21T00:00:00Z",
        verified_id: ownerKey.fingerprint,
        content: {
          to_genesis_generation: 1,
        },
      },
    ];
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const r = resolveTrustRoot(acceptedRecords, roster);
    assert(r !== null, "trust_root resolves to latest");
    assertEqual(
      r.genesis_generation,
      1,
      "latest migration's genesis_generation wins",
    );
    assertEqual(r.anchor_record_seq, 5, "latest seq wins");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ============================================================================
// Suite 4 — 5-case corrupt-state discrimination
// ============================================================================
console.log("\n--- 5-case corrupt-state discrimination ---");

function withTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-c1-repo-"));
  try {
    fn(dir);
  } finally {
    cleanup(dir);
  }
}

test("discriminate_state_corrupt_cache_intact_log_refold", () => {
  const { discriminateState } = require(POSTURE_V2);
  withTempRepo((dir) => {
    const cachePath = path.join(dir, "posture.json");
    const logPath = path.join(dir, "log.jsonl");
    const initMarker = path.join(dir, ".initialized");
    // Corrupt cache, but log exists and is non-empty.
    fs.writeFileSync(cachePath, "{ not valid json");
    fs.writeFileSync(logPath, '{"type":"genesis-anchor","seq":0}\n');
    fs.writeFileSync(initMarker, "");
    const r = discriminateState({
      postureCachePath: cachePath,
      logPath,
      initializedMarkerPath: initMarker,
    });
    assertEqual(r.disposition, "refold", "corrupt cache + intact log → refold");
  });
});

test("discriminate_state_missing_log_no_initialized_fresh_repo_l5", () => {
  const { discriminateState } = require(POSTURE_V2);
  withTempRepo((dir) => {
    const cachePath = path.join(dir, "posture.json");
    const logPath = path.join(dir, "log.jsonl");
    const initMarker = path.join(dir, ".initialized");
    // No log, no cache, no init marker.
    const r = discriminateState({
      postureCachePath: cachePath,
      logPath,
      initializedMarkerPath: initMarker,
    });
    assertEqual(
      r.disposition,
      "fresh-repo-L5",
      "no log + no init marker → fresh repo L5",
    );
  });
});

test("discriminate_state_missing_log_initialized_no_clone_init_fresh_clone_l2", () => {
  const { discriminateState } = require(POSTURE_V2);
  withTempRepo((dir) => {
    const cachePath = path.join(dir, "posture.json");
    const logPath = path.join(dir, "log.jsonl");
    const initMarker = path.join(dir, ".initialized");
    // Init marker present but no log (and thus no clone-init chain).
    fs.writeFileSync(initMarker, "");
    const r = discriminateState({
      postureCachePath: cachePath,
      logPath,
      initializedMarkerPath: initMarker,
    });
    assertEqual(
      r.disposition,
      "fresh-clone-L2",
      "init marker + no log (no clone-init) → benign fresh clone",
    );
  });
});

test("discriminate_state_missing_log_initialized_with_clone_init_chain_corrupt_l1", () => {
  const { discriminateState } = require(POSTURE_V2);
  withTempRepo((dir) => {
    const cachePath = path.join(dir, "posture.json");
    const logPath = path.join(dir, "log.jsonl");
    const initMarker = path.join(dir, ".initialized");
    const cloneInitMarker = path.join(dir, ".clone-init-witness");
    fs.writeFileSync(initMarker, "");
    fs.writeFileSync(cloneInitMarker, JSON.stringify({ type: "clone-init" }));
    const r = discriminateState({
      postureCachePath: cachePath,
      logPath,
      initializedMarkerPath: initMarker,
      cloneInitWitnessPath: cloneInitMarker,
    });
    assertEqual(
      r.disposition,
      "corrupt-L1",
      "log gone but clone-init witness survives → fail-closed L1",
    );
  });
});

test("discriminate_state_fold_integrity_failure_corrupt_l1", () => {
  const { discriminateState } = require(POSTURE_V2);
  withTempRepo((dir) => {
    const cachePath = path.join(dir, "posture.json");
    const logPath = path.join(dir, "log.jsonl");
    const initMarker = path.join(dir, ".initialized");
    fs.writeFileSync(cachePath, JSON.stringify({ schema_version: 2 }));
    fs.writeFileSync(logPath, "this is not a record\n");
    fs.writeFileSync(initMarker, "");
    const r = discriminateState({
      postureCachePath: cachePath,
      logPath,
      initializedMarkerPath: initMarker,
      foldIntegrityFailed: true,
    });
    assertEqual(
      r.disposition,
      "corrupt-L1",
      "fold integrity failure → fail-closed L1",
    );
  });
});

// ============================================================================
// Suite 5 — Genesis-generation partition signal
// ============================================================================
console.log("\n--- genesis-generation partition signal ---");

test("partition_adjusted_posture_degrades_to_l3_when_partitioned", () => {
  const { partitionAdjustedPosture } = require(POSTURE_V2);
  const partitionResult = {
    partitioned: true,
    local_genesis_generation: 0,
    peer_high_water_generation: 1,
    reason: "local below peer",
  };
  const r = partitionAdjustedPosture("L5_DELEGATED", partitionResult);
  assertEqual(
    r,
    "L3_SHARED_PLANNING",
    "partitioned → degrade to L3_SHARED_PLANNING",
  );
});

test("partition_adjusted_posture_passthrough_when_not_partitioned", () => {
  const { partitionAdjustedPosture } = require(POSTURE_V2);
  const partitionResult = {
    partitioned: false,
    local_genesis_generation: 1,
    peer_high_water_generation: 1,
  };
  const r = partitionAdjustedPosture("L5_DELEGATED", partitionResult);
  assertEqual(r, "L5_DELEGATED", "not partitioned → passthrough");
});

test("partition_adjusted_posture_respects_more_restrictive_local_posture", () => {
  const { partitionAdjustedPosture } = require(POSTURE_V2);
  // Local already L1 (more restrictive than L3). Partition should not LOOSEN.
  const r = partitionAdjustedPosture("L1_PSEUDO_AGENT", {
    partitioned: true,
    local_genesis_generation: 0,
    peer_high_water_generation: 5,
  });
  assertEqual(
    r,
    "L1_PSEUDO_AGENT",
    "more-restrictive local posture survives partition cap",
  );
});

// ============================================================================
// Suite 6 — `posture-event` predicate
// ============================================================================
console.log("\n--- posture-event predicate ---");

function makePostureEventRecord({
  verifiedId,
  personId,
  seq,
  prevHash,
  ts,
  content,
  signKey,
}) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const base = {
    type: "posture-event",
    verified_id: verifiedId,
    person_id: personId,
    seq,
    prev_hash: prevHash || null,
    ts,
    content,
  };
  const sigResult = sign(canonicalSerialize(base), {
    keyType: "ssh",
    keyPath: signKey,
  });
  if (!sigResult.ok) throw new Error("sign failed: " + sigResult.reason);
  return Object.assign({}, base, { sig: sigResult.sig });
}

test("fold_posture_event_accepts_owner_upgrading_other_operator", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("upg-owner");
  const otherKey = mkEphemeralSshKey("upg-other");
  try {
    const roster = makeRoster({
      ownerKey,
      ownerLogin: "owner-login",
      otherKey,
      otherLogin: "other-login",
    });
    const record = makePostureEventRecord({
      verifiedId: ownerKey.fingerprint,
      personId: "pid-owner-a",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "upgrade",
        target_person_id: "pid-owner-b",
        from_posture: "L2_SUPERVISED",
        to_posture: "L4_CONTINUOUS_INSIGHT",
        reason: "human-approval-nonce-xyz",
        challenge_nonce: "paste-back-nonce",
      },
      signKey: ownerKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, true, "owner upgrading other operator → accept");
  } finally {
    cleanup(ownerKey.dir);
    cleanup(otherKey.dir);
  }
});

test("fold_posture_event_rejects_self_upgrade_per_trust_posture_must_3", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("self-upg");
  try {
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const record = makePostureEventRecord({
      verifiedId: ownerKey.fingerprint,
      personId: "pid-owner-a",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "upgrade",
        target_person_id: "pid-owner-a", // same as signer
        from_posture: "L3_SHARED_PLANNING",
        to_posture: "L4_CONTINUOUS_INSIGHT",
        reason: "self approval attempt",
        challenge_nonce: "nonce-q",
      },
      signKey: ownerKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, false, "self-upgrade rejected per MUST-3");
    assert(
      /self-upgrade|distinct/i.test(r.reason || ""),
      "reason cites self-upgrade",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("fold_posture_event_accepts_self_downgrade", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("self-dwn");
  try {
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const record = makePostureEventRecord({
      verifiedId: ownerKey.fingerprint,
      personId: "pid-owner-a",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "downgrade",
        target_person_id: "pid-owner-a",
        from_posture: "L5_DELEGATED",
        to_posture: "L4_CONTINUOUS_INSIGHT",
        reason: "voluntary self-step-down",
        challenge_nonce: null,
      },
      signKey: ownerKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, true, "self-downgrade is allowed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("fold_posture_event_requires_owner_role_for_floor_set", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("floor-owner");
  try {
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const record = makePostureEventRecord({
      verifiedId: ownerKey.fingerprint,
      personId: "pid-owner-a",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "floor-set",
        target_person_id: null,
        from_posture: "L5_DELEGATED",
        to_posture: "L4_CONTINUOUS_INSIGHT",
        reason: "tightened floor",
        challenge_nonce: null,
      },
      signKey: ownerKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, true, "owner can set repo_floor");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("fold_posture_event_rejects_floor_set_by_non_owner", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("nonowner-floor-o");
  const contribKey = mkEphemeralSshKey("nonowner-floor-c");
  try {
    const roster = makeRoster({
      ownerKey,
      ownerLogin: "owner-login",
      contributorKey: contribKey,
      contributorLogin: "contrib-login",
    });
    const record = makePostureEventRecord({
      verifiedId: contribKey.fingerprint,
      personId: "pid-contrib-c",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "floor-set",
        target_person_id: null,
        from_posture: "L5_DELEGATED",
        to_posture: "L1_PSEUDO_AGENT",
        reason: "rogue contributor",
        challenge_nonce: null,
      },
      signKey: contribKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, false, "non-owner cannot set floor");
    assert(/owner/i.test(r.reason || ""), "reason cites owner-only floor-set");
  } finally {
    cleanup(ownerKey.dir);
    cleanup(contribKey.dir);
  }
});

test("fold_posture_event_records_violation_as_advisory", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("violation");
  try {
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const record = makePostureEventRecord({
      verifiedId: ownerKey.fingerprint,
      personId: "pid-owner-a",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "violation",
        target_person_id: "pid-owner-a",
        from_posture: null,
        to_posture: null,
        reason: "rule_id=zero-tolerance/MUST-1",
        challenge_nonce: null,
      },
      signKey: ownerKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, true, "violation record accepted as advisory");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("fold_posture_event_unknown_event_rejected", () => {
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  const ownerKey = mkEphemeralSshKey("unknown-event");
  try {
    const roster = makeRoster({ ownerKey, ownerLogin: "owner-login" });
    const record = makePostureEventRecord({
      verifiedId: ownerKey.fingerprint,
      personId: "pid-owner-a",
      seq: 0,
      ts: "2026-05-21T00:00:00Z",
      content: {
        event: "transmogrify",
        target_person_id: "pid-owner-a",
        from_posture: null,
        to_posture: null,
        reason: "not a real event",
        challenge_nonce: null,
      },
      signKey: ownerKey.keyPath,
    });
    const r = foldPostureEvent(record, {
      foldState: {},
      roster,
      acceptedSoFar: [],
    });
    assertEqual(r.accepted, false, "unknown event rejected");
    assert(
      /unknown event|allowlist/i.test(r.reason || ""),
      "reason cites unknown event",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("engine_dispatches_posture_event_to_fold_predicate", () => {
  const { createEngine } = require(COORDINATION_LOG);
  const { foldPostureEvent } = require(FOLD_POSTURE_EVENT);
  // Use a sandbox engine; replace the default no-op for posture-event.
  const engine = createEngine({ inheritDefaults: true });
  engine.registerFoldPredicate("posture-event", foldPostureEvent, {
    checkpoint_exempt: true,
    authoritative_for_record: true,
    authoritative_for_aggregate: false,
  });
  const meta = engine.predicateMetadataFor("posture-event");
  assert(meta !== null, "posture-event registered");
  assertEqual(
    meta.checkpoint_exempt,
    true,
    "posture-event exempt from checkpoints",
  );
  assertEqual(
    meta.authoritative_for_record,
    true,
    "authoritative_for_record true",
  );
});

// ============================================================================
// Report
// ============================================================================
console.log("\n========================================");
console.log(`Posture-V2 (C1)  PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP}`);
if (FAILS.length) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log("  - " + f);
}
process.exit(FAIL === 0 ? 0 : 1);
