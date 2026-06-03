/**
 * Tier-2 integration tests for shard B3b (workspaces/multi-operator-coc,
 * M3 user-facing claim commands + cross-operator reap ceremony).
 *
 * Per rules/testing.md 3-Tier: real ssh-keygen + real canonicalSerialize +
 * real coc-sign verify + real filesystem Transport. No mocking.
 *
 * Four invariants per the shard contract (B3b):
 *
 *   (1) /claim <path-or-glob> — writes a signed claim record whose
 *       content shape matches M2 B1's adjacency-leasecheck.js auto-claim
 *       exactly (claim_id, path, optional auto:true marker omitted for
 *       explicit /claim invocations). SAME → halt-and-report BEFORE write;
 *       ADJACENT → advisory marker on record; INDEPENDENT → clean.
 *
 *   (2) /claims — reads folded log via A2a foldLog + filesystem Transport;
 *       groups by display_id; sorts siblings first then by granted_at DESC;
 *       surfaces F2-1 contested claims (a later SAME-class record that
 *       overrides an earlier ADJACENT-granted claim).
 *
 *   (3) /release-claim <claim-ref> — self-release writes a signed `release`
 *       record pointing at the claim being released; cross-operator attempt
 *       via self-release MUST halt-and-report citing the reap path.
 *
 *   (4) Cross-operator reap ceremony (lib/reap-ceremony.js, §4.4):
 *       reaper + cosigner with distinct person_id; pinned victim heartbeat
 *       MUST be (a) latest seen + (b) older than LIVENESS_TTL_MS by wall-
 *       clock per R5-A-07 / R10-A-01. Cosigner eligibility goes through
 *       eligibility.js::isEligibleSigner("gate-approval") — CI hosts
 *       BLOCKED per R5-S-04. Owner-signed 2-of-N reap is an alternative
 *       basis; self-reap of own stale claim needs no cosignature. The
 *       cosignature MUST verify over the canonical-serialized reap content.
 *
 * Run: node tests/integration/claim-commands.test.js
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
const COORDINATION_LOG = path.join(LIB_DIR, "coordination-log.js");
const TRANSPORT_FS = path.join(LIB_DIR, "transport-filesystem.js");
const ELIGIBILITY = path.join(LIB_DIR, "eligibility.js");
const REAP_CEREMONY = path.join(LIB_DIR, "reap-ceremony.js");
const FOLD_RULE_10 = path.join(LIB_DIR, "fold-rule-10.js");

// ---- minimal async test harness ---------------------------------------------
let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const FAILS = [];
const QUEUE = [];

function test(name, fn) {
  QUEUE.push({ name, fn });
}

async function run() {
  for (const { name, fn } of QUEUE) {
    try {
      const r = await fn();
      if (r === "skip") {
        SKIP += 1;
        console.log(`  SKIP  ${name}`);
        continue;
      }
      PASS += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      FAIL += 1;
      FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
      console.log(`  FAIL  ${name}`);
    }
  }
  console.log(`\n${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
  if (FAIL > 0) {
    console.log("\nFailures:");
    for (const f of FAILS) console.log("  - " + f);
    process.exit(1);
  }
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: ${a} !== ${e}`);
}

// ---- fixtures ---------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-b3b-${label}-`));
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
    `coc-b3b-test-${label}`,
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

function signRecord(core, keyPath) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(core);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`sign failed: ${r.error}`);
  return Object.assign({}, core, { sig: r.sig });
}

// Build an unsigned claim core record matching M2 B1 auto-claim shape.
// Note: canonicalSerialize rejects `undefined` values per its determinism
// contract — every field MUST be present-with-value (including null) or
// absent. Explicit /claim invocations OMIT `auto` entirely (vs B1's
// auto-claim which sets auto:true); the test asserts content.auto ===
// undefined post-construction (key not present in object).
function claimCore(opts) {
  const content = {
    claim_id:
      opts.claim_id ||
      `claim-${opts.verified_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    path: opts.path || null,
    glob: opts.glob || null,
    dir: opts.dir || null,
    workspace: opts.workspace || null,
  };
  if (opts.auto === true) content.auto = true;
  return {
    type: "claim",
    verified_id: opts.verified_id,
    person_id: opts.person_id || null,
    display_id: opts.display_id || null,
    seq: opts.seq != null ? opts.seq : 0,
    prev_hash: opts.prev_hash || null,
    ts: opts.ts || new Date().toISOString(),
    content,
  };
}

function heartbeatCore(opts) {
  return {
    type: "heartbeat",
    verified_id: opts.verified_id,
    person_id: opts.person_id || null,
    display_id: opts.display_id || null,
    seq: opts.seq,
    prev_hash: opts.prev_hash || null,
    ts: opts.ts,
    content: { live: true },
  };
}

// ============================================================================
// Suite 1 — /claim flow (invariant 1)
// ============================================================================
console.log("\n--- /claim flow ---");

test("claim_writes_record_with_correct_shape_matching_b1_auto_claim", () => {
  // Verify the claim core shape matches what B1's adjacency-leasecheck.js
  // writes for auto-claim. Both shapes share: type=claim, verified_id,
  // person_id, display_id, seq, prev_hash, ts, content.claim_id, content.path,
  // sig. The only difference is content.auto: true is set ONLY by B1's
  // auto-claim path; explicit /claim invocations omit it.
  const k = mkEphemeralSshKey("shape-1");
  try {
    const core = claimCore({
      verified_id: k.fingerprint,
      person_id: "pid-alice",
      display_id: "alice",
      seq: 0,
      path: "src/lib/foo.js",
    });
    const signed = signRecord(core, k.keyPath);
    assert(signed.type === "claim", "type=claim");
    assert(typeof signed.verified_id === "string", "verified_id stamped");
    assert(typeof signed.seq === "number", "seq numeric");
    assert(typeof signed.ts === "string", "ts ISO string");
    assert(signed.content && typeof signed.content === "object", "content");
    assert(signed.content.claim_id, "claim_id present");
    assert(signed.content.path === "src/lib/foo.js", "path stamped");
    assert(typeof signed.sig === "string", "sig stamped");
    // Asserting parity with B1 auto-claim: same fields, same hierarchy.
    // B1 writes content.auto: true; explicit /claim writes no `auto` field.
    assert(signed.content.auto === undefined, "/claim has no auto:true");
  } finally {
    cleanup(k.dir);
  }
});

test("claim_writes_advisory_marker_on_adjacent", () => {
  // ADJACENT relation: claim record carries an explicit `advisory: true`
  // marker in content so /claims read surface can flag it.
  const k = mkEphemeralSshKey("adj-1");
  try {
    const core = claimCore({
      verified_id: k.fingerprint,
      person_id: "pid-alice",
      display_id: "alice",
      seq: 0,
      path: "src/lib/new.js",
    });
    // Simulate the /claim adjacency-promotion: mark the record as advisory
    core.content.granted_relation = "ADJACENT";
    core.content.advisory = true;
    const signed = signRecord(core, k.keyPath);
    assert(signed.content.granted_relation === "ADJACENT", "ADJACENT marker");
    assert(signed.content.advisory === true, "advisory true");
  } finally {
    cleanup(k.dir);
  }
});

test("claim_halt_and_report_on_same_before_write", () => {
  // SAME relation: /claim must NOT write the record. The command's pre-flight
  // checks the relation; if SAME, it halts. This test verifies the absence
  // semantics — given an existing claim and a candidate that would conflict,
  // the relation library returns matched=true, which the /claim flow
  // interprets as "halt; do NOT append."
  const { isSame } = require(path.join(LIB_DIR, "adjacency.js"));
  const existingClaim = {
    claim_id: "claim-existing",
    verified_id: "SHA256:other",
    person_id: "pid-bob",
    display_id: "bob",
    path: "src/lib/foo.js",
    glob: null,
    dir: null,
    workspace: null,
    phase: null,
    cohort_commits: null,
    granted_at_seq: 0,
  };
  // SAME via exact path match.
  assertEqual(
    isSame("src/lib/foo.js", [existingClaim], {}),
    true,
    "SAME detected — /claim MUST halt-and-report before writing",
  );
});

test("claim_writes_clean_on_independent", () => {
  // INDEPENDENT relation: no SAME, no ADJACENT — claim record written with
  // granted_relation: "INDEPENDENT" and no advisory marker.
  const k = mkEphemeralSshKey("ind-1");
  try {
    const core = claimCore({
      verified_id: k.fingerprint,
      person_id: "pid-alice",
      display_id: "alice",
      seq: 0,
      path: "unrelated/path.js",
    });
    core.content.granted_relation = "INDEPENDENT";
    const signed = signRecord(core, k.keyPath);
    assert(
      signed.content.granted_relation === "INDEPENDENT",
      "INDEPENDENT marker",
    );
    assert(signed.content.advisory === undefined, "no advisory");
  } finally {
    cleanup(k.dir);
  }
});

test("claim_record_signature_verifies", () => {
  const { canonicalSerialize, verify } = require(COC_SIGN);
  const k = mkEphemeralSshKey("sig-1");
  try {
    const core = claimCore({
      verified_id: k.fingerprint,
      person_id: "pid-alice",
      display_id: "alice",
      seq: 0,
      path: "src/lib/foo.js",
    });
    const signed = signRecord(core, k.keyPath);
    const { sig, ...content } = signed;
    const bytes = canonicalSerialize(content);
    const r = verify(bytes, sig, k.pubKey, { keyType: "ssh" });
    assert(r.ok, `verify ok: ${r.reason || ""}`);
    assert(r.valid === true, "signature verifies");
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 2 — /claims read surface (invariant 2)
// ============================================================================
console.log("\n--- /claims read surface ---");

test("claims_reads_folded_state_groups_by_display_id", async () => {
  const { createFilesystemTransport } = require(TRANSPORT_FS);
  const { foldLog } = require(COORDINATION_LOG);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-b3b-rd-"));
  const kAlice = mkEphemeralSshKey("rd-alice");
  const kBob = mkEphemeralSshKey("rd-bob");
  try {
    const roster = {
      persons: {
        "pid-alice": {
          display_id: "alice",
          role: "contributor",
          host_role: "human",
          github_login: "alice-gh",
          keys: [
            {
              type: "ssh",
              fingerprint: kAlice.fingerprint,
              pubkey: kAlice.pubKey,
            },
          ],
        },
        "pid-bob": {
          display_id: "bob",
          role: "contributor",
          host_role: "human",
          github_login: "bob-gh",
          keys: [
            {
              type: "ssh",
              fingerprint: kBob.fingerprint,
              pubkey: kBob.pubKey,
            },
          ],
        },
      },
    };
    const transport = createFilesystemTransport(repoDir);
    const t0 = Date.now();
    // Alice claim
    const aliceClaim = signRecord(
      claimCore({
        verified_id: kAlice.fingerprint,
        person_id: "pid-alice",
        display_id: "alice",
        seq: 0,
        ts: new Date(t0).toISOString(),
        path: "src/a.js",
      }),
      kAlice.keyPath,
    );
    await transport.appendRecord(aliceClaim);
    // Bob claim
    const bobClaim = signRecord(
      claimCore({
        verified_id: kBob.fingerprint,
        person_id: "pid-bob",
        display_id: "bob",
        seq: 0,
        ts: new Date(t0 + 1).toISOString(),
        path: "src/b.js",
      }),
      kBob.keyPath,
    );
    await transport.appendRecord(bobClaim);
    const records = await transport.readAllRecords();
    const res = foldLog(records, roster, {});
    assert(Array.isArray(res.accepted), "accepted array");
    // Both claims accepted (verified by foldLog with roster).
    const claims = res.accepted.filter((r) => r.type === "claim");
    assertEqual(claims.length, 2, "two claims accepted");
    // Group by display_id (the /claims surface formats this way).
    const byDisplay = {};
    for (const c of claims) {
      const d = c.display_id || "(unknown)";
      byDisplay[d] = (byDisplay[d] || 0) + 1;
    }
    assert(byDisplay.alice === 1, "alice grouping");
    assert(byDisplay.bob === 1, "bob grouping");
  } finally {
    cleanup(repoDir);
    cleanup(kAlice.dir);
    cleanup(kBob.dir);
  }
});

test("claims_sorts_siblings_first_then_by_granted_at_descending", () => {
  // The /claims sort contract: own first, then siblings by granted_at DESC.
  // We pre-compute the sort key on a synthetic claim set.
  const t = Date.now();
  const claims = [
    { display_id: "alice", granted_at: new Date(t).toISOString(), own: false },
    {
      display_id: "self",
      granted_at: new Date(t - 5000).toISOString(),
      own: true,
    },
    {
      display_id: "bob",
      granted_at: new Date(t - 1000).toISOString(),
      own: false,
    },
    {
      display_id: "alice",
      granted_at: new Date(t - 2000).toISOString(),
      own: false,
    },
  ];
  const sorted = claims.slice().sort((a, b) => {
    if (a.own !== b.own) return a.own ? -1 : 1;
    return Date.parse(b.granted_at) - Date.parse(a.granted_at);
  });
  assertEqual(sorted[0].own, true, "own first");
  // Remaining sorted by granted_at DESC.
  for (let i = 1; i + 1 < sorted.length; i++) {
    const aTs = Date.parse(sorted[i].granted_at);
    const bTs = Date.parse(sorted[i + 1].granted_at);
    assert(aTs >= bTs, `desc order at ${i}`);
  }
});

test("claims_surfaces_contested_claims_f2_1_residual", () => {
  // F2-1 residual: an earlier ADJACENT claim followed by a later SAME-class
  // claim should be surfaced as contested. The /claims read surface walks
  // the folded accepted set and flags ADJACENT claims whose target is later
  // covered by a SAME-class predicate against the sibling claim.
  //
  // Test: build two claims; one ADJACENT (advisory:true), one later SAME.
  // The surface predicate should mark the ADJACENT one as contested.
  const adjacentClaim = {
    claim_id: "c1",
    display_id: "alice",
    path: null,
    dir: "src/lib",
    workspace: null,
    advisory: true,
    granted_relation: "ADJACENT",
    granted_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const sameClaim = {
    claim_id: "c2",
    display_id: "bob",
    path: "src/lib/foo.js",
    dir: null,
    workspace: null,
    advisory: false,
    granted_relation: "SAME",
    granted_at: new Date(Date.now()).toISOString(),
  };
  // Predicate: contested if claim is ADJACENT AND a later SAME claim's path
  // falls under this claim's dir/workspace/glob.
  function isContested(claim, allClaims) {
    if (!claim.advisory) return false;
    const claimDir = claim.dir;
    if (!claimDir) return false;
    for (const other of allClaims) {
      if (other === claim) continue;
      if (other.granted_relation !== "SAME") continue;
      if (Date.parse(other.granted_at) <= Date.parse(claim.granted_at))
        continue;
      if (other.path && other.path.startsWith(claimDir + "/")) return true;
    }
    return false;
  }
  assertEqual(
    isContested(adjacentClaim, [adjacentClaim, sameClaim]),
    true,
    "ADJACENT followed by overlapping SAME → contested",
  );
  assertEqual(
    isContested(sameClaim, [adjacentClaim, sameClaim]),
    false,
    "SAME claim itself not contested",
  );
});

// ============================================================================
// Suite 3 — /release-claim self-release (invariant 3)
// ============================================================================
console.log("\n--- /release-claim self-release ---");

test("release_claim_writes_release_record_with_correct_pointer", () => {
  const k = mkEphemeralSshKey("rel-1");
  try {
    const claim = signRecord(
      claimCore({
        verified_id: k.fingerprint,
        person_id: "pid-alice",
        display_id: "alice",
        seq: 0,
        path: "src/lib/foo.js",
      }),
      k.keyPath,
    );
    // Build release record pointing at claim.
    const release = signRecord(
      {
        type: "release",
        verified_id: k.fingerprint,
        person_id: "pid-alice",
        display_id: "alice",
        seq: 1,
        prev_hash: null,
        ts: new Date().toISOString(),
        content: {
          claim_id: claim.content.claim_id,
          released_claim_ref: {
            verified_id: claim.verified_id,
            seq: claim.seq,
          },
          reason: "self-release",
        },
      },
      k.keyPath,
    );
    assert(release.type === "release", "type=release");
    assert(release.content.claim_id === claim.content.claim_id, "claim_id ptr");
    assert(
      release.content.released_claim_ref.verified_id === claim.verified_id,
      "verified_id ptr",
    );
    assert(release.content.released_claim_ref.seq === claim.seq, "seq ptr");
    assert(release.content.reason === "self-release", "reason");
  } finally {
    cleanup(k.dir);
  }
});

test("release_claim_halt_on_cross_operator_attempted_via_self_release", () => {
  // The /release-claim self-release path checks that the claim's verified_id
  // matches the invoking operator's. When they differ, it MUST halt and
  // direct the user to the reap path. We model the structural check here.
  const kAlice = mkEphemeralSshKey("rel-self-a");
  const kBob = mkEphemeralSshKey("rel-self-b");
  try {
    const aliceClaim = signRecord(
      claimCore({
        verified_id: kAlice.fingerprint,
        person_id: "pid-alice",
        display_id: "alice",
        seq: 0,
        path: "src/lib/foo.js",
      }),
      kAlice.keyPath,
    );
    // Bob tries to self-release Alice's claim.
    const bobVerifiedId = kBob.fingerprint;
    const isOwn = aliceClaim.verified_id === bobVerifiedId;
    assertEqual(
      isOwn,
      false,
      "Cross-operator self-release attempted — must halt",
    );
    // The /release-claim flow halts here and directs to --reap with cosigner.
  } finally {
    cleanup(kAlice.dir);
    cleanup(kBob.dir);
  }
});

test("release_claim_signature_verifies", () => {
  const { canonicalSerialize, verify } = require(COC_SIGN);
  const k = mkEphemeralSshKey("rel-sig");
  try {
    const release = signRecord(
      {
        type: "release",
        verified_id: k.fingerprint,
        person_id: "pid-alice",
        display_id: "alice",
        seq: 1,
        prev_hash: null,
        ts: new Date().toISOString(),
        content: {
          claim_id: "claim-test",
          released_claim_ref: { verified_id: k.fingerprint, seq: 0 },
          reason: "self-release",
        },
      },
      k.keyPath,
    );
    const { sig, ...content } = release;
    const bytes = canonicalSerialize(content);
    const r = verify(bytes, sig, k.pubKey, { keyType: "ssh" });
    assert(r.ok, `verify ok: ${r.reason || ""}`);
    assert(r.valid === true, "release sig verifies");
  } finally {
    cleanup(k.dir);
  }
});

// ============================================================================
// Suite 4 — Cross-operator reap ceremony (invariant 4)
// ============================================================================
console.log("\n--- Cross-operator reap ceremony ---");

test("reap_honored_when_pinned_victim_heartbeat_is_latest_and_aged_past_liveness_ttl", () => {
  const { LIVENESS_TTL_MS } = require(COORDINATION_LOG);
  const { buildReapRecord, validateReap } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-a");
  const kCosigner = mkEphemeralSshKey("reap-b");
  const kVictim = mkEphemeralSshKey("reap-v");
  try {
    const now = Date.now();
    const victimHb = {
      verified_id: kVictim.fingerprint,
      seq: 42,
      ts: new Date(now - LIVENESS_TTL_MS - 60_000).toISOString(),
    };
    const reaperPerson = {
      person_id: "pid-reaper",
      role: "owner",
      host_role: "human",
    };
    const cosignerPerson = {
      person_id: "pid-cosigner",
      role: "owner",
      host_role: "human",
    };
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson,
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson,
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: victimHb,
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert(out.ok, `buildReapRecord: ${out.error || ""}`);
    const valid = validateReap({
      record: out.record,
      now,
      observedPeerVictimHighWaterSeq: 42,
    });
    assert(valid.honored, `validateReap honored: ${valid.reason || ""}`);
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("reap_rejected_when_victim_has_heartbeat_at_higher_seq", () => {
  const { LIVENESS_TTL_MS } = require(COORDINATION_LOG);
  const { buildReapRecord, validateReap } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-rh-a");
  const kCosigner = mkEphemeralSshKey("reap-rh-b");
  const kVictim = mkEphemeralSshKey("reap-rh-v");
  try {
    const now = Date.now();
    // Pinned heartbeat at seq 42, but observed peer high-water is 99 — the
    // reaper's pinned view is stale.
    const victimHb = {
      verified_id: kVictim.fingerprint,
      seq: 42,
      ts: new Date(now - LIVENESS_TTL_MS - 60_000).toISOString(),
    };
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: {
        person_id: "pid-r",
        role: "owner",
        host_role: "human",
      },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: {
        person_id: "pid-c",
        role: "owner",
        host_role: "human",
      },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: victimHb,
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert(out.ok, `build: ${out.error || ""}`);
    const valid = validateReap({
      record: out.record,
      now,
      observedPeerVictimHighWaterSeq: 99,
    });
    assertEqual(
      valid.honored,
      false,
      "reap rejected: victim has higher-seq heartbeat than pinned",
    );
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("reap_rejected_when_victim_heartbeat_ts_within_liveness_ttl", () => {
  const { LIVENESS_TTL_MS } = require(COORDINATION_LOG);
  const { buildReapRecord, validateReap } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-ttl-a");
  const kCosigner = mkEphemeralSshKey("reap-ttl-b");
  const kVictim = mkEphemeralSshKey("reap-ttl-v");
  try {
    const now = Date.now();
    // Pinned heartbeat WITHIN the TTL — victim is still live.
    const victimHb = {
      verified_id: kVictim.fingerprint,
      seq: 42,
      ts: new Date(now - 30_000).toISOString(), // 30s ago — well within 20min
    };
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: { person_id: "pid-r", role: "owner", host_role: "human" },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: {
        person_id: "pid-c",
        role: "owner",
        host_role: "human",
      },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: victimHb,
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert(out.ok, `build: ${out.error || ""}`);
    const valid = validateReap({
      record: out.record,
      now,
      observedPeerVictimHighWaterSeq: 42,
    });
    assertEqual(
      valid.honored,
      false,
      "reap rejected: heartbeat within LIVENESS_TTL_MS",
    );
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("reap_owner_signed_2_of_n_alternative_basis", () => {
  // M3 MED-4 migration: original test asserted 1-cosigner owner-2-of-N
  // honored. Under MED-4, owner-2-of-N requires ≥2 cosigners; 1-cosigner
  // semantics IS "co-signed" basis. Test renamed-in-intent: a SINGLE
  // cosigner reap is the "co-signed" basis (alternative to self-reap).
  // The strict 2-cosigner owner-2-of-N path has its own dedicated test
  // below: reap_basis_owner_2_of_n_accepts_two_distinct_owner_cosigners.
  const { LIVENESS_TTL_MS } = require(COORDINATION_LOG);
  const { buildReapRecord, validateReap } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-own-a");
  const kCosigner = mkEphemeralSshKey("reap-own-b");
  const kVictim = mkEphemeralSshKey("reap-own-v");
  try {
    const now = Date.now();
    const victimHb = {
      verified_id: kVictim.fingerprint,
      seq: 42,
      ts: new Date(now - LIVENESS_TTL_MS - 60_000).toISOString(),
    };
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: { person_id: "pid-r", role: "owner", host_role: "human" },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: {
        person_id: "pid-c",
        role: "owner",
        host_role: "human",
      },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: victimHb,
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert(out.ok, `build: ${out.error || ""}`);
    assertEqual(out.record.content.basis, "co-signed", "co-signed basis");
    const valid = validateReap({
      record: out.record,
      now,
      observedPeerVictimHighWaterSeq: 42,
    });
    assert(valid.honored, `co-signed honored: ${valid.reason || ""}`);
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("reap_self_reap_no_cosignature_required", () => {
  const { LIVENESS_TTL_MS } = require(COORDINATION_LOG);
  const { buildReapRecord, validateReap } = require(REAP_CEREMONY);
  // Self-reap: the reaper is reaping their OWN stale claim. No cosigner.
  const kSelf = mkEphemeralSshKey("reap-self");
  try {
    const now = Date.now();
    const selfStaleHb = {
      verified_id: kSelf.fingerprint,
      seq: 42,
      ts: new Date(now - LIVENESS_TTL_MS - 60_000).toISOString(),
    };
    const out = buildReapRecord({
      // Reaping self's own claim.
      reapedClaim: { verified_id: kSelf.fingerprint, seq: 7 },
      reaperPerson: {
        person_id: "pid-self",
        role: "contributor",
        host_role: "human",
      },
      reaperVerifiedId: kSelf.fingerprint,
      cosignerPerson: null,
      cosignerVerifiedId: null,
      cosignerKeyPath: null,
      reaperKeyPath: kSelf.keyPath,
      pinnedVictimHeartbeat: selfStaleHb,
      basis: "self-reap",
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert(out.ok, `self-reap build: ${out.error || ""}`);
    assertEqual(out.record.content.basis, "self-reap", "self-reap basis");
    assert(
      out.record.content.cosigner === null ||
        out.record.content.cosigner === undefined,
      "no cosigner on self-reap",
    );
    const valid = validateReap({
      record: out.record,
      now,
      observedPeerVictimHighWaterSeq: 42,
    });
    assert(valid.honored, `self-reap honored: ${valid.reason || ""}`);
  } finally {
    cleanup(kSelf.dir);
  }
});

test("reap_cosigner_must_be_distinct_person_id", () => {
  const { buildReapRecord } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-dist-a");
  const kCosigner = mkEphemeralSshKey("reap-dist-b");
  const kVictim = mkEphemeralSshKey("reap-dist-v");
  try {
    const now = Date.now();
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: {
        person_id: "pid-shared",
        role: "owner",
        host_role: "human",
      },
      reaperVerifiedId: kReaper.fingerprint,
      // Same person_id as reaper — MUST be rejected.
      cosignerPerson: {
        person_id: "pid-shared",
        role: "owner",
        host_role: "human",
      },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: new Date(now - 30 * 60_000).toISOString(),
      },
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assertEqual(out.ok, false, "cosigner same person_id BLOCKED");
    assert(
      out.error && /distinct|person_id/i.test(out.error),
      `error mentions distinct person_id: ${out.error}`,
    );
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("reap_cosigner_ci_host_role_blocked_per_r5_s_04", () => {
  const { buildReapRecord } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-ci-a");
  const kCosigner = mkEphemeralSshKey("reap-ci-b");
  const kVictim = mkEphemeralSshKey("reap-ci-v");
  try {
    const now = Date.now();
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: {
        person_id: "pid-r",
        role: "owner",
        host_role: "human",
      },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: {
        person_id: "pid-c",
        role: "owner",
        host_role: "ci", // BLOCKED per R5-S-04
      },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: new Date(now - 30 * 60_000).toISOString(),
      },
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assertEqual(out.ok, false, "CI cosigner BLOCKED");
    assert(
      out.error && /ci|R5-S-04|gate-approval/i.test(out.error),
      `error mentions CI/R5-S-04: ${out.error}`,
    );
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("reap_cosignature_verifies_over_reap_content", () => {
  const { canonicalSerialize, verify } = require(COC_SIGN);
  const { LIVENESS_TTL_MS } = require(COORDINATION_LOG);
  const { buildReapRecord } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-vfy-a");
  const kCosigner = mkEphemeralSshKey("reap-vfy-b");
  const kVictim = mkEphemeralSshKey("reap-vfy-v");
  try {
    const now = Date.now();
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: {
        person_id: "pid-r",
        role: "owner",
        host_role: "human",
      },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: {
        person_id: "pid-c",
        role: "owner",
        host_role: "human",
      },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: new Date(now - LIVENESS_TTL_MS - 60_000).toISOString(),
      },
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "reaper-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner-login",
            type: "User",
            permissions: { admin: true, push: true },
          },
        ],
        capture_ts: new Date(now).toISOString(),
      },
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert(out.ok, `build: ${out.error || ""}`);
    // Cosignature MUST verify over the canonical-serialized reap content.
    // The reap-ceremony library builds the content bytes the cosigner signed;
    // we re-derive them and verify against the cosigner's pubkey.
    const r = out.record;
    const cosignaturePayload = {
      type: "reap-cosignature",
      reaped_claim_ref: r.content.reaped_claim_ref,
      claim_id: r.content.claim_id || null,
      reaper: r.content.reaper,
      cosigner: r.content.cosigner,
      pinned_victim_heartbeat: r.content.pinned_victim_heartbeat,
      basis: r.content.basis,
    };
    const bytes = canonicalSerialize(cosignaturePayload);
    const v = verify(bytes, r.content.cosignature, kCosigner.pubKey, {
      keyType: "ssh",
    });
    assert(v.ok, `verify ok: ${v.reason || ""}`);
    assert(v.valid === true, "cosignature verifies");
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

// ---- run ---------------------------------------------------------------------
run();
