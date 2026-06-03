/**
 * Tier-2 integration tests for shard A0b-2c (workspaces/multi-operator-coc,
 * design v11 §2.3 owner-departure recovery + R9-S-02 fence + R5-S-04
 * deploy-key-exclusion + clone-init signed first-fold witness).
 *
 * Real ephemeral SSH keys + real coc-sign canonicalSerialize/sign/verify.
 * Only fold-rule-10's isSettled and derive-n.js::computeDerivedN are used as
 * upstream predicates (already shipped by A0b-2b on main).
 *
 * The 4 shard invariants:
 *   (1) Owner-departure recovery degenerate-fallback (R8-S-01 removal-only).
 *   (2) R9-S-02 fence — revocation-induced N=1 blocks self-signed
 *       compaction-checkpoint + generation-rotation; genuine-genesis N=1
 *       does NOT.
 *   (3) R5-S-04 deploy-key-exclusion predicate — host_role:ci is NEVER
 *       eligible across the 5 signing contexts.
 *   (4) clone-init signed first-fold witness — append-once per clone,
 *       hash-chained, checkpoint-exempt by rule 6 generic.
 *
 * Run: node tests/integration/recovery-and-clone-init.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const ELIGIBILITY = path.join(LIB_DIR, "eligibility.js");
const CLONE_INIT = path.join(LIB_DIR, "clone-init.js");
const R9S02_FENCE = path.join(LIB_DIR, "r9s02-fence.js");
const RECOVERY_FALLBACK = path.join(LIB_DIR, "recovery-fallback.js");

// ---- minimal test harness (matches distinctness-and-rule10.test.js) ----------
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
function assertTrue(cond, msg) {
  if (cond !== true) throw new Error(msg || "expected true");
}
function assertFalse(cond, msg) {
  if (cond !== false) throw new Error(msg || "expected false");
}

// ---- ephemeral key fixtures --------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-a0b2c-${label}-`));
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
    `coc-a0b2c-test-${label}`,
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fpOut = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    encoding: "utf8",
  });
  const m = fpOut.match(/SHA256:[A-Za-z0-9+\/=]+/);
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

// ---- roster builder ---------------------------------------------------------
function makePerson({ role, github_login, host_role, fingerprint, pubKey }) {
  return {
    display_id: github_login,
    role,
    github_login,
    host_role: host_role || "human",
    keys: [{ type: "ssh", fingerprint, pubkey: pubKey }],
  };
}

function makeRoster(persons, opts = {}) {
  return {
    genesis: {
      repo_owner: opts.repo_owner || "alice",
      repo_owner_kind: opts.repo_owner_kind || "user",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons,
  };
}

// =============================================================================
// Suite 1 — R5-S-04 deploy-key-exclusion eligibility (lib/eligibility.js)
// =============================================================================
console.log(
  "\n--- R5-S-04 deploy-key-exclusion eligibility (lib/eligibility.js) ---",
);

const CI_CTX = [
  "owner-quorum",
  "distinctness",
  "gate-approval",
  "genesis",
  "migration",
];

for (const ctx of CI_CTX) {
  test(`ci_host_blocked_for_${ctx.replace(/-/g, "_")}`, () => {
    const { isEligibleSigner } = require(ELIGIBILITY);
    const person = {
      role: "owner",
      github_login: "ci-deploy",
      host_role: "ci",
    };
    const r = isEligibleSigner(person, ctx);
    assertFalse(r.eligible, `ci host MUST NOT be eligible for ${ctx}`);
    assert(
      /R5-S-04/.test(r.reason || ""),
      `reason MUST cite R5-S-04 (got: ${r.reason})`,
    );
  });
}

test("human_host_eligible_for_appropriate_context_with_role_match", () => {
  const { isEligibleSigner } = require(ELIGIBILITY);
  const owner = {
    role: "owner",
    github_login: "alice",
    host_role: "human",
  };
  // Owner is eligible for every owner-grade context.
  for (const ctx of CI_CTX) {
    const r = isEligibleSigner(owner, ctx);
    assertTrue(
      r.eligible,
      `owner-human MUST be eligible for ${ctx} (got reason: ${r.reason})`,
    );
  }
});

test("eligibility_module_exports_ci_forever_ineligible_contexts", () => {
  const mod = require(ELIGIBILITY);
  assert(
    Array.isArray(mod.CI_FOREVER_INELIGIBLE_CONTEXTS),
    "CI_FOREVER_INELIGIBLE_CONTEXTS MUST be an array",
  );
  // All 5 contexts MUST be in the constant.
  for (const ctx of CI_CTX) {
    assert(
      mod.CI_FOREVER_INELIGIBLE_CONTEXTS.includes(ctx),
      `CI_FOREVER_INELIGIBLE_CONTEXTS MUST include ${ctx}`,
    );
  }
});

test("eligibility_rejects_contributor_for_owner_quorum", () => {
  const { isEligibleSigner } = require(ELIGIBILITY);
  const contributor = {
    role: "contributor",
    github_login: "carol",
    host_role: "human",
  };
  const r = isEligibleSigner(contributor, "owner-quorum");
  assertFalse(r.eligible, "contributor MUST NOT be eligible for owner-quorum");
});

test("eligibility_rejects_unknown_signing_context", () => {
  const { isEligibleSigner } = require(ELIGIBILITY);
  const owner = {
    role: "owner",
    github_login: "alice",
    host_role: "human",
  };
  const r = isEligibleSigner(owner, "random-context");
  assertFalse(r.eligible, "unknown signing context MUST raise loud error");
});

// =============================================================================
// Suite 2 — Clone-init signed first-fold witness (lib/clone-init.js)
// =============================================================================
console.log(
  "\n--- clone-init signed first-fold witness (lib/clone-init.js) ---",
);

test("should_emit_clone_init_when_no_prior_record_signed_by_verified_id", () => {
  const { shouldEmitCloneInit } = require(CLONE_INIT);
  const verifiedId = "SHA256:abcde-this-clone-fp";
  const roster = makeRoster({
    "pid-alice": makePerson({
      role: "owner",
      github_login: "alice",
      fingerprint: "SHA256:other-fp",
      pubKey: "ssh-ed25519 OTHER",
    }),
  });
  const foldedState = { records: [] };
  assertTrue(
    shouldEmitCloneInit(roster, foldedState, verifiedId),
    "empty folded state MUST require clone-init emission",
  );
});

test("should_not_emit_clone_init_when_prior_record_exists", () => {
  const { shouldEmitCloneInit } = require(CLONE_INIT);
  const verifiedId = "SHA256:abcde-this-clone-fp";
  const roster = makeRoster({});
  const foldedState = {
    records: [
      {
        type: "clone-init",
        verified_id: verifiedId,
        seq: 0,
        content: {
          fingerprint_evidence: { first_fold_ts: "2026-05-19T00:00:00Z" },
        },
      },
    ],
  };
  assertFalse(
    shouldEmitCloneInit(roster, foldedState, verifiedId),
    "prior clone-init by same verified_id MUST suppress emission",
  );
});

test("should_emit_clone_init_when_prior_record_signed_by_different_verified_id", () => {
  const { shouldEmitCloneInit } = require(CLONE_INIT);
  // Another clone (Bob's) ran clone-init; our clone (Alice's) still owes its
  // own first-fold witness — clones do not share clone-init records.
  const ourVerifiedId = "SHA256:alice-fp";
  const otherVerifiedId = "SHA256:bob-fp";
  const roster = makeRoster({});
  const foldedState = {
    records: [
      {
        type: "clone-init",
        verified_id: otherVerifiedId,
        seq: 0,
        content: { fingerprint_evidence: {} },
      },
    ],
  };
  assertTrue(
    shouldEmitCloneInit(roster, foldedState, ourVerifiedId),
    "another clone's clone-init MUST NOT suppress our emission",
  );
});

test("emit_clone_init_writes_signed_record", () => {
  const { emitCloneInit } = require(CLONE_INIT);
  const cocSign = require(COC_SIGN);
  const k = mkEphemeralSshKey("emit-1");
  try {
    const appended = [];
    const transportAppend = (record) => {
      appended.push(record);
      return { ok: true };
    };
    const fingerprintEvidence = {
      first_fold_ts: "2026-05-19T01:23:45Z",
      coordination_log_head_at_first_fold:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    const result = emitCloneInit({
      cocSign,
      transportAppend,
      verifiedId: k.fingerprint,
      personId: "pid-alice",
      seq: 7,
      prevHash:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      ts: "2026-05-19T01:23:45Z",
      signer: { keyPath: k.keyPath, keyType: "ssh" },
      fingerprintEvidence,
    });
    assertTrue(result.ok, `emit MUST succeed (got: ${JSON.stringify(result)})`);
    assert(result.record, "emit MUST return the record");
    assertEqual(result.record.type, "clone-init", "type MUST be clone-init");
    assertEqual(
      result.record.verified_id,
      k.fingerprint,
      "verified_id MUST match signer",
    );
    assertEqual(result.record.person_id, "pid-alice", "person_id MUST match");
    assertEqual(result.record.seq, 7, "seq MUST be carried");
    assert(
      typeof result.record.sig === "string" && result.record.sig.length > 0,
      "record MUST be signed",
    );
    assert(
      result.record.content && result.record.content.fingerprint_evidence,
      "fingerprint_evidence MUST be on the record",
    );
    // The same record MUST have been passed to the transport.
    assertEqual(appended.length, 1, "transport MUST be called once");
    assertEqual(
      appended[0].sig,
      result.record.sig,
      "transport MUST receive the same signed record",
    );

    // Round-trip: the signature MUST verify against the signer's pubkey.
    const { canonicalSerialize, verify } = cocSign;
    const { sig, ...core } = result.record;
    const bytes = canonicalSerialize(core);
    const v = verify(bytes, sig, k.pubKey, { keyType: "ssh" });
    assertTrue(v.ok, "verify call MUST succeed");
    assertTrue(v.valid, "signature MUST verify against signer's pubkey");
  } finally {
    cleanup(k.dir);
  }
});

test("clone_init_record_is_hash_chained", () => {
  const { emitCloneInit } = require(CLONE_INIT);
  const cocSign = require(COC_SIGN);
  const k = mkEphemeralSshKey("chain-1");
  try {
    const appended = [];
    const transportAppend = (record) => {
      appended.push(record);
      return { ok: true };
    };
    const fingerprintEvidence = {
      first_fold_ts: "2026-05-19T01:23:45Z",
    };
    const prevHash =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const result = emitCloneInit({
      cocSign,
      transportAppend,
      verifiedId: k.fingerprint,
      personId: "pid-alice",
      seq: 3,
      prevHash,
      ts: "2026-05-19T01:23:45Z",
      signer: { keyPath: k.keyPath, keyType: "ssh" },
      fingerprintEvidence,
    });
    assertTrue(result.ok, "emit MUST succeed");
    assertEqual(
      result.record.prev_hash,
      prevHash,
      "prev_hash MUST be carried through",
    );
    assertEqual(result.record.seq, 3, "seq MUST be carried through");
    assertTrue(Number.isInteger(result.record.seq), "seq MUST be an integer");
  } finally {
    cleanup(k.dir);
  }
});

test("emit_clone_init_fails_loudly_on_missing_signer", () => {
  const { emitCloneInit } = require(CLONE_INIT);
  const cocSign = require(COC_SIGN);
  const transportAppend = () => ({ ok: true });
  const result = emitCloneInit({
    cocSign,
    transportAppend,
    verifiedId: "SHA256:x",
    personId: "pid-x",
    seq: 0,
    prevHash: null,
    ts: "2026-05-19T01:23:45Z",
    signer: null,
    fingerprintEvidence: {},
  });
  assertFalse(result.ok, "missing signer MUST fail-closed");
});

// =============================================================================
// Suite 3 — R9-S-02 fence (lib/r9s02-fence.js)
// =============================================================================
console.log(
  "\n--- R9-S-02 fence: revocation-induced N=1 vs genuine-genesis N=1 (lib/r9s02-fence.js) ---",
);

test("r9s02_genuine_genesis_n1_passes_fence", () => {
  const {
    isRevocationInducedSingleton,
    gateEligibleForSelfSignedCheckpointOrRotation,
  } = require(R9S02_FENCE);
  // Genuine genesis N=1: one owner in roster, NO settled attestations have
  // ever existed. The genesis-anchor IS the distinctness basis (R9-A-03).
  const k = mkEphemeralSshKey("fence-1");
  try {
    const roster = makeRoster({
      "pid-alice": makePerson({
        role: "owner",
        github_login: "alice",
        fingerprint: k.fingerprint,
        pubKey: k.pubKey,
      }),
    });
    const foldedState = { records: [], derived_N: 1 };
    assertFalse(
      isRevocationInducedSingleton(roster, foldedState),
      "no attestation history MUST mean genuine-genesis N=1",
    );
    const gate = gateEligibleForSelfSignedCheckpointOrRotation(
      roster,
      foldedState,
    );
    assertTrue(
      gate.eligible,
      `genuine-genesis N=1 MUST permit self-signed checkpoint/rotation (got reason: ${gate.reason})`,
    );
  } finally {
    cleanup(k.dir);
  }
});

test("r9s02_revocation_induced_n1_blocked", () => {
  const {
    isRevocationInducedSingleton,
    gateEligibleForSelfSignedCheckpointOrRotation,
  } = require(R9S02_FENCE);
  // Had owner-add history (a settled attestation exists in the log), now
  // back to N=1 via a settled revocation. The fence MUST block.
  const k1 = mkEphemeralSshKey("fence-2a");
  const k2 = mkEphemeralSshKey("fence-2b");
  try {
    const roster = makeRoster({
      "pid-alice": makePerson({
        role: "owner",
        github_login: "alice",
        fingerprint: k1.fingerprint,
        pubKey: k1.pubKey,
      }),
      "pid-bob": makePerson({
        role: "owner",
        github_login: "bob",
        fingerprint: k2.fingerprint,
        pubKey: k2.pubKey,
      }),
    });
    const foldedState = {
      derived_N: 1,
      records: [
        {
          type: "collaborator-distinctness-attestation",
          verified_id: k1.fingerprint,
          person_id: "pid-alice",
          seq: 5,
          content: { github_login: "bob" },
        },
        {
          type: "collaborator-distinctness-revocation",
          verified_id: k1.fingerprint,
          person_id: "pid-alice",
          seq: 10,
          content: { github_login: "bob" },
        },
      ],
    };
    assertTrue(
      isRevocationInducedSingleton(roster, foldedState),
      "settled attestation in log + N=1 derived MUST be revocation-induced",
    );
    const gate = gateEligibleForSelfSignedCheckpointOrRotation(
      roster,
      foldedState,
    );
    assertFalse(
      gate.eligible,
      "revocation-induced N=1 MUST block self-signed checkpoint/rotation (R9-S-02)",
    );
    assert(
      /R9-S-02/.test(gate.reason || ""),
      `reason MUST cite R9-S-02 (got: ${gate.reason})`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("r9s02_n_above_1_passes_fence", () => {
  const { gateEligibleForSelfSignedCheckpointOrRotation } = require(
    R9S02_FENCE,
  );
  // N=2+: the question of "degenerate self-sign" doesn't even apply, but the
  // fence MUST NOT spuriously block.
  const k1 = mkEphemeralSshKey("fence-3a");
  const k2 = mkEphemeralSshKey("fence-3b");
  try {
    const roster = makeRoster({
      "pid-alice": makePerson({
        role: "owner",
        github_login: "alice",
        fingerprint: k1.fingerprint,
        pubKey: k1.pubKey,
      }),
      "pid-bob": makePerson({
        role: "owner",
        github_login: "bob",
        fingerprint: k2.fingerprint,
        pubKey: k2.pubKey,
      }),
    });
    const foldedState = {
      derived_N: 2,
      records: [
        {
          type: "collaborator-distinctness-attestation",
          verified_id: k1.fingerprint,
          person_id: "pid-alice",
          seq: 5,
          content: { github_login: "bob" },
        },
      ],
    };
    const gate = gateEligibleForSelfSignedCheckpointOrRotation(
      roster,
      foldedState,
    );
    assertTrue(
      gate.eligible,
      `N=2 MUST pass the fence (got reason: ${gate.reason})`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

// =============================================================================
// Suite 4 — Recovery fallback (lib/recovery-fallback.js)
// =============================================================================
console.log(
  "\n--- R8-S-01 owner-departure removal-only recovery (lib/recovery-fallback.js) ---",
);

// Helper: build a folded state with attestation + (optionally) settled revocation.
function buildAttestedThenRevokedState(k1, k2, revocationContested) {
  const records = [
    {
      type: "collaborator-distinctness-attestation",
      verified_id: k1.fingerprint,
      person_id: "pid-alice",
      seq: 5,
      content: { github_login: "bob" },
    },
    {
      type: "collaborator-distinctness-revocation",
      verified_id: k1.fingerprint,
      person_id: "pid-alice",
      seq: 10,
      ts: "2026-05-19T00:00:00Z",
      content: {
        github_login: "bob",
        evidence_window: {
          opens_at: "2026-05-18T00:00:00Z",
          closes_at: "2026-05-19T00:00:00Z",
          victim_chain_high_water_seq: 100,
        },
      },
      rule10_contested: !!revocationContested,
    },
  ];
  return { records };
}

function makeAliceBobRoster(k1, k2) {
  return makeRoster({
    "pid-alice": makePerson({
      role: "owner",
      github_login: "alice",
      fingerprint: k1.fingerprint,
      pubKey: k1.pubKey,
    }),
    "pid-bob": makePerson({
      role: "owner",
      github_login: "bob",
      fingerprint: k2.fingerprint,
      pubKey: k2.pubKey,
    }),
  });
}

test("recovery_fallback_not_eligible_until_revocation_settles", () => {
  const { eligibleForRecoveryFallback } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rec-1a");
  const k2 = mkEphemeralSshKey("rec-1b");
  try {
    const roster = makeAliceBobRoster(k1, k2);
    const foldedState = buildAttestedThenRevokedState(k1, k2, false);
    // peerHighWaterFor returns null → rule-10 cannot settle (R10-S-01).
    const peerHighWaterFor = () => null;
    const r = eligibleForRecoveryFallback(
      roster,
      foldedState,
      peerHighWaterFor,
    );
    assertFalse(
      r.eligible,
      "unsettled revocation MUST NOT unlock recovery fallback",
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("recovery_fallback_eligible_when_settled_revocation_drops_derived_n_to_one", () => {
  const { eligibleForRecoveryFallback } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rec-2a");
  const k2 = mkEphemeralSshKey("rec-2b");
  try {
    const roster = makeAliceBobRoster(k1, k2);
    const foldedState = buildAttestedThenRevokedState(k1, k2, false);
    // peerHighWaterFor returns the local fold's seq → settles per R10-S-01.
    const peerHighWaterFor = () => 10;
    const r = eligibleForRecoveryFallback(
      roster,
      foldedState,
      peerHighWaterFor,
    );
    assertTrue(
      r.eligible,
      `settled revocation MUST unlock recovery fallback (got: ${r.reason})`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("recovery_fallback_names_eligible_remover", () => {
  const { eligibleForRecoveryFallback } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rec-3a");
  const k2 = mkEphemeralSshKey("rec-3b");
  try {
    const roster = makeAliceBobRoster(k1, k2);
    const foldedState = buildAttestedThenRevokedState(k1, k2, false);
    const peerHighWaterFor = () => 10;
    const r = eligibleForRecoveryFallback(
      roster,
      foldedState,
      peerHighWaterFor,
    );
    assertTrue(r.eligible, "eligible");
    assertEqual(
      r.eligible_remover,
      "pid-alice",
      "sole remaining owner pid-alice MUST be named as remover",
    );
    assertEqual(
      r.departed_logins,
      ["bob"],
      "departed login MUST be named as bob",
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("removal_only_edit_accepts_pure_removal", () => {
  const { validateRemovalOnlyEdit } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rem-1a");
  const k2 = mkEphemeralSshKey("rem-1b");
  try {
    const oldRoster = makeAliceBobRoster(k1, k2);
    const newRoster = makeRoster({
      "pid-alice": makePerson({
        role: "owner",
        github_login: "alice",
        fingerprint: k1.fingerprint,
        pubKey: k1.pubKey,
      }),
    });
    const r = validateRemovalOnlyEdit(oldRoster, newRoster, "pid-alice", [
      "bob",
    ]);
    assertTrue(
      r.valid,
      `pure removal of pid-bob MUST be valid (got: ${r.reason})`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("removal_only_edit_rejects_owner_addition_in_same_edit", () => {
  // R8-S-01: MUST NOT add any new owner person_id in the same self-signed
  // removal-only edit.
  const { validateRemovalOnlyEdit } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rem-2a");
  const k2 = mkEphemeralSshKey("rem-2b");
  const k3 = mkEphemeralSshKey("rem-2c");
  try {
    const oldRoster = makeAliceBobRoster(k1, k2);
    const newRoster = makeRoster({
      "pid-alice": makePerson({
        role: "owner",
        github_login: "alice",
        fingerprint: k1.fingerprint,
        pubKey: k1.pubKey,
      }),
      // Alice tries to add a brand new owner (carol) in the same edit.
      "pid-carol": makePerson({
        role: "owner",
        github_login: "carol",
        fingerprint: k3.fingerprint,
        pubKey: k3.pubKey,
      }),
    });
    const r = validateRemovalOnlyEdit(oldRoster, newRoster, "pid-alice", [
      "bob",
    ]);
    assertFalse(
      r.valid,
      "owner-add in same removal-only edit MUST be rejected (R8-S-01)",
    );
    assert(
      /R8-S-01/.test(r.reason || "") || /owner/.test(r.reason || ""),
      `reason MUST cite R8-S-01 / owner-add (got: ${r.reason})`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
    cleanup(k3.dir);
  }
});

test("removal_only_edit_rejects_key_array_growth_for_existing_owner", () => {
  const { validateRemovalOnlyEdit } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rem-3a");
  const k2 = mkEphemeralSshKey("rem-3b");
  const k1prime = mkEphemeralSshKey("rem-3a-extra");
  try {
    const oldRoster = makeAliceBobRoster(k1, k2);
    // Alice's keys array grows from [k1] to [k1, k1prime] while removing bob.
    const aliceWithExtraKey = makePerson({
      role: "owner",
      github_login: "alice",
      fingerprint: k1.fingerprint,
      pubKey: k1.pubKey,
    });
    aliceWithExtraKey.keys.push({
      type: "ssh",
      fingerprint: k1prime.fingerprint,
      pubkey: k1prime.pubKey,
    });
    const newRoster = makeRoster({
      "pid-alice": aliceWithExtraKey,
    });
    const r = validateRemovalOnlyEdit(oldRoster, newRoster, "pid-alice", [
      "bob",
    ]);
    assertFalse(
      r.valid,
      "key-array growth in removal-only edit MUST be rejected",
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
    cleanup(k1prime.dir);
  }
});

test("removal_only_edit_rejects_genesis_block_modification", () => {
  const { validateRemovalOnlyEdit } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("rem-4a");
  const k2 = mkEphemeralSshKey("rem-4b");
  try {
    const oldRoster = makeAliceBobRoster(k1, k2);
    const newRoster = makeRoster(
      {
        "pid-alice": makePerson({
          role: "owner",
          github_login: "alice",
          fingerprint: k1.fingerprint,
          pubKey: k1.pubKey,
        }),
      },
      // genesis_generation bumped — MUST NOT happen in removal-only edit.
      { repo_owner: "alice" },
    );
    newRoster.genesis.genesis_generation = 999;
    const r = validateRemovalOnlyEdit(oldRoster, newRoster, "pid-alice", [
      "bob",
    ]);
    assertFalse(
      r.valid,
      "genesis-block modification in removal-only edit MUST be rejected",
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

// =============================================================================
// Suite 5 — M0 security review regression tests (HIGH-4 wall-clock injection)
// =============================================================================
console.log("\n--- M0 security review HIGH-4 regression tests ---");

// Helper: build folded state with a revocation whose ts is `tsString`.
function buildRevocationAt(k1, k2, tsString) {
  return {
    records: [
      {
        type: "collaborator-distinctness-attestation",
        verified_id: k1.fingerprint,
        person_id: "pid-alice",
        seq: 5,
        content: { github_login: "bob" },
      },
      {
        type: "collaborator-distinctness-revocation",
        verified_id: k1.fingerprint,
        person_id: "pid-alice",
        seq: 10,
        ts: tsString,
        content: {
          github_login: "bob",
          evidence_window: {
            opens_at: "2025-01-01T00:00:00Z",
            closes_at: tsString,
            victim_chain_high_water_seq: 100,
          },
        },
      },
    ],
  };
}

test("eligibility_blocked_when_revocation_too_recent_to_be_settled", () => {
  const { eligibleForRecoveryFallback } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("h4-1a");
  const k2 = mkEphemeralSshKey("h4-1b");
  try {
    const roster = makeAliceBobRoster(k1, k2);
    // Inject a synthetic now; revocation ts = now - 5min (under 20min TTL)
    const now = Date.parse("2026-05-20T12:00:00Z");
    const recentTs = new Date(now - 5 * 60 * 1000).toISOString();
    const foldedState = buildRevocationAt(k1, k2, recentTs);
    const r = eligibleForRecoveryFallback(roster, foldedState, () => 10, {
      now,
    });
    assert(
      !r.eligible,
      `HIGH-4: revocation 5min old MUST stay unsettled under LIVENESS_TTL (20min); got eligible=${r.eligible}`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("eligibility_allowed_when_revocation_aged_past_liveness_ttl", () => {
  const { eligibleForRecoveryFallback } = require(RECOVERY_FALLBACK);
  const k1 = mkEphemeralSshKey("h4-2a");
  const k2 = mkEphemeralSshKey("h4-2b");
  try {
    const roster = makeAliceBobRoster(k1, k2);
    // Inject synthetic now; revocation ts = now - 25min (past TTL)
    const now = Date.parse("2026-05-20T12:00:00Z");
    const oldTs = new Date(now - 25 * 60 * 1000).toISOString();
    const foldedState = buildRevocationAt(k1, k2, oldTs);
    const r = eligibleForRecoveryFallback(roster, foldedState, () => 10, {
      now,
    });
    assertTrue(
      r.eligible,
      `HIGH-4: revocation 25min old MUST settle past LIVENESS_TTL (20min); got reason: ${r.reason}`,
    );
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

// =============================================================================
// Summary
// =============================================================================
console.log(`\nResults: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
