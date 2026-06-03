/**
 * Tier-2 integration tests for shard A0b-2b (workspaces/multi-operator-coc,
 * design v11 §2.1 + §2.2 fold rule 10 + R9-A-02 + R9-A-03 + R10-A-02 +
 * R10-A-03 + R10-A-01 + R10-S-01).
 *
 * Real ephemeral SSH keys + real coc-sign canonicalSerialize/sign/verify;
 * the ONLY external service that is dependency-injected is `gh api`
 * (the architecture explicitly captures it AS a self-produced signed fact,
 * §1.1 general structural-residual law). That injection follows the
 * pattern A0b-2a established for genesis-ceremony.
 *
 * Seven invariants per the shard contract:
 *   (1) collaborator-distinctness-attestation ceremony (owner-add).
 *   (2) collaborator-distinctness-revocation ceremony (owner-departure)
 *       with the R10-A-02 evidence window.
 *   (3) Fold rule 10 — liveness-contradiction contest naming the forger.
 *   (4) Settlement via LIVENESS_TTL wall-clock quiescence (R10-A-01).
 *   (5) Fetch-bounded settlement via peerHighWaterFor (R10-S-01).
 *   (6) Derived-N latest-by-seq per github_login, R9-A-02 + R9-A-03.
 *   (7) R10-A-03 contested-exclusion from latest-by-seq computation.
 *
 * Run: node tests/integration/distinctness-and-rule10.test.js
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
const FOLD_RULE_10 = path.join(LIB_DIR, "fold-rule-10.js");
const DERIVE_N = path.join(LIB_DIR, "derive-n.js");
const OWNER_ADD = path.join(LIB_DIR, "owner-add-ceremony.js");
const OWNER_DEPART = path.join(LIB_DIR, "owner-depart-ceremony.js");

// ---- minimal test harness (no external deps; mirrors coc-sign.test.js) ------
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

// ---- ephemeral key fixtures --------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-distinct-${label}-`));
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
    `coc-distinct-test-${label}`,
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

// ---- gh-api injection factory ------------------------------------------------
// The architecture says collaborator-distinctness ceremonies capture a `gh api
// repos/.../collaborators` body. We inject a deterministic ghApi(endpoint)
// function the ceremony consumes — same pattern A0b-2a used.
function makeGhApiMock(state) {
  return function ghApi(endpoint) {
    const m = endpoint.match(/^repos\/[^\/]+\/[^\/]+\/collaborators$/);
    if (m) {
      return {
        ok: true,
        status: 200,
        body: state.collaborators.map((login) => ({ login })),
      };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

// ---- roster builder ---------------------------------------------------------
function makeRoster({ owners, contributors }) {
  const persons = {};
  for (const o of owners) {
    persons[o.person_id] = {
      display_id: o.display_id,
      role: "owner",
      github_login: o.github_login,
      host_role: o.host_role || "human",
      keys: [{ type: "ssh", fingerprint: o.fingerprint, pubkey: o.pubKey }],
    };
  }
  for (const c of contributors || []) {
    persons[c.person_id] = {
      display_id: c.display_id,
      role: "contributor",
      github_login: c.github_login,
      host_role: c.host_role || "human",
      keys: [{ type: "ssh", fingerprint: c.fingerprint, pubkey: c.pubKey }],
    };
  }
  return {
    genesis: {
      repo_owner: owners[0].github_login,
      repo_owner_kind: "user",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons,
  };
}

// =============================================================================
// Suite 1 — derived-N computation (lib/derive-n.js)
// =============================================================================
console.log(
  "\n--- derived-N computation (lib/derive-n.js) — R9-A-02 + R9-A-03 + R10-A-03 ---",
);

test("derived_n_genesis_owner_counts_as_attestation", () => {
  const { computeDerivedN } = require(DERIVE_N);
  // R9-A-03: the genesis owner has NO collaborator-distinctness-attestation;
  // their genesis-anchor binding IS their distinctness basis and counts.
  const k = mkEphemeralSshKey("dn-1");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-owner-1",
          display_id: "alice",
          github_login: "alice",
          fingerprint: k.fingerprint,
          pubKey: k.pubKey,
        },
      ],
    });
    // No distinctness records at all — only the genesis-owner binding via roster.
    const result = computeDerivedN({
      roster,
      log: [],
      trustRoot: { person_id: "pid-owner-1" },
    });
    assertEqual(result.live_logins.sort(), ["alice"], "alice must count");
    assertEqual(result.derived_N, 1, "derived_N = 1 for sole genesis owner");
  } finally {
    cleanup(k.dir);
  }
});

test("derived_n_counts_attestation_latest", () => {
  const { computeDerivedN } = require(DERIVE_N);
  const k1 = mkEphemeralSshKey("dn-2a");
  const k2 = mkEphemeralSshKey("dn-2b");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-alice",
          display_id: "alice",
          github_login: "alice",
          fingerprint: k1.fingerprint,
          pubKey: k1.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: k2.fingerprint,
          pubKey: k2.pubKey,
        },
      ],
    });
    const log = [
      {
        type: "collaborator-distinctness-attestation",
        verified_id: k1.fingerprint,
        person_id: "pid-alice",
        seq: 5,
        content: { github_login: "bob" },
      },
    ];
    const result = computeDerivedN({
      roster,
      log,
      trustRoot: { person_id: "pid-alice" },
    });
    assertEqual(
      result.live_logins.sort(),
      ["alice", "bob"],
      "alice (genesis) + bob (attested) count",
    );
    assertEqual(result.derived_N, 2);
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("derived_n_suppresses_revocation_latest", () => {
  const { computeDerivedN } = require(DERIVE_N);
  const k1 = mkEphemeralSshKey("dn-3a");
  const k2 = mkEphemeralSshKey("dn-3b");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-alice",
          display_id: "alice",
          github_login: "alice",
          fingerprint: k1.fingerprint,
          pubKey: k1.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: k2.fingerprint,
          pubKey: k2.pubKey,
        },
      ],
    });
    const log = [
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
    ];
    const result = computeDerivedN({
      roster,
      log,
      trustRoot: { person_id: "pid-alice" },
    });
    assertEqual(
      result.live_logins.sort(),
      ["alice"],
      "revocation suppresses bob",
    );
    assertEqual(result.derived_N, 1);
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("derived_n_attestation_re_admits_after_contested_revocation", () => {
  const { computeDerivedN } = require(DERIVE_N);
  // R9-A-02: a later verifying attestation re-admits.
  const k1 = mkEphemeralSshKey("dn-4a");
  const k2 = mkEphemeralSshKey("dn-4b");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-alice",
          display_id: "alice",
          github_login: "alice",
          fingerprint: k1.fingerprint,
          pubKey: k1.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: k2.fingerprint,
          pubKey: k2.pubKey,
        },
      ],
    });
    const log = [
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
      // Later re-attestation (e.g. bob re-added).
      {
        type: "collaborator-distinctness-attestation",
        verified_id: k1.fingerprint,
        person_id: "pid-alice",
        seq: 20,
        content: { github_login: "bob" },
      },
    ];
    const result = computeDerivedN({
      roster,
      log,
      trustRoot: { person_id: "pid-alice" },
    });
    assertEqual(
      result.live_logins.sort(),
      ["alice", "bob"],
      "re-attestation re-admits",
    );
    assertEqual(result.derived_N, 2);
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("derived_n_excludes_contested_revocation_uses_next_latest", () => {
  const { computeDerivedN } = require(DERIVE_N);
  // R10-A-03: a contested revocation is EXCLUDED from latest-by-seq.
  // Next-latest verifying record for that login wins.
  const k1 = mkEphemeralSshKey("dn-5a");
  const k2 = mkEphemeralSshKey("dn-5b");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-alice",
          display_id: "alice",
          github_login: "alice",
          fingerprint: k1.fingerprint,
          pubKey: k1.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: k2.fingerprint,
          pubKey: k2.pubKey,
        },
      ],
    });
    const log = [
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
        // The contested flag is set by fold rule 10 (Suite 2 below) — here
        // we directly mark the record to test derive-n's exclusion path.
        rule10_contested: true,
        rule10_contested_by_record_ref: {
          verified_id: k2.fingerprint,
          seq: 11,
        },
      },
    ];
    const result = computeDerivedN({
      roster,
      log,
      trustRoot: { person_id: "pid-alice" },
    });
    assertEqual(
      result.live_logins.sort(),
      ["alice", "bob"],
      "contested revocation excluded; next-latest is bob's attestation at seq 5",
    );
    assertEqual(result.derived_N, 2);
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

test("derived_n_host_role_ci_never_counts", () => {
  const { computeDerivedN } = require(DERIVE_N);
  const k1 = mkEphemeralSshKey("dn-6a");
  const k2 = mkEphemeralSshKey("dn-6b");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-alice",
          display_id: "alice",
          github_login: "alice",
          fingerprint: k1.fingerprint,
          pubKey: k1.pubKey,
        },
        {
          person_id: "pid-ci",
          display_id: "ci",
          github_login: "ci-bot",
          fingerprint: k2.fingerprint,
          pubKey: k2.pubKey,
          host_role: "ci",
        },
      ],
    });
    // Even an attestation for the ci login MUST NOT make it count.
    const log = [
      {
        type: "collaborator-distinctness-attestation",
        verified_id: k1.fingerprint,
        person_id: "pid-alice",
        seq: 5,
        content: { github_login: "ci-bot" },
      },
    ];
    const result = computeDerivedN({
      roster,
      log,
      trustRoot: { person_id: "pid-alice" },
    });
    assertEqual(
      result.live_logins.sort(),
      ["alice"],
      "host_role:ci never counts (R5-S-04)",
    );
    assertEqual(result.derived_N, 1);
  } finally {
    cleanup(k1.dir);
    cleanup(k2.dir);
  }
});

// =============================================================================
// Suite 2 — fold rule 10 (lib/fold-rule-10.js)
// =============================================================================
console.log(
  "\n--- fold rule 10 — liveness-contradiction (lib/fold-rule-10.js) ---",
);

function makeRevocationRecord({
  revokerKey,
  victimLogin,
  seq,
  ts,
  evidenceWindow,
  ghCaptureLogins,
}) {
  return {
    type: "collaborator-distinctness-revocation",
    verified_id: revokerKey.fingerprint,
    person_id: "pid-revoker",
    seq,
    ts,
    content: {
      github_login: victimLogin,
      gh_api_collaborators_capture: (ghCaptureLogins || []).map((l) => ({
        login: l,
      })),
      captured_at_ts: ts,
      evidence_window: evidenceWindow,
    },
  };
}

test("fold_rule_10_accepts_uncontested_revocation", () => {
  const { foldRevocation } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("r10-1");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    // No X-activity records to contest.
    const result = foldRevocation(revocation, {
      victimChainEntries: [],
      state: { revocations: {} },
    });
    assert(result.accepted === true, "uncontested revocation accepts");
    assert(!result.contested, "no contest flag");
  } finally {
    cleanup(revoker.dir);
  }
});

test("fold_rule_10_contests_revocation_when_x_activity_within_evidence_window", () => {
  const { foldRevocation } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("r10-2a");
  const victim = mkEphemeralSshKey("r10-2b");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    // Victim emitted a heartbeat AFTER the evidence window opens.
    const victimChainEntries = [
      {
        type: "heartbeat",
        verified_id: victim.fingerprint,
        seq: 50,
        ts: "2026-05-20T11:00:00Z",
      },
    ];
    const result = foldRevocation(revocation, {
      victimChainEntries,
      state: { revocations: {} },
    });
    assert(result.accepted === false, "contested revocation rejected");
    assert(result.contested === true, "contested flag set");
    assertEqual(result.forging_signer, revoker.fingerprint, "names the forger");
    assert(
      result.contested_by_record &&
        result.contested_by_record.type === "heartbeat",
      "contested_by_record is the X-signed heartbeat",
    );
  } finally {
    cleanup(revoker.dir);
    cleanup(victim.dir);
  }
});

test("fold_rule_10_does_not_contest_revocation_when_x_activity_strictly_prior_to_evidence_window", () => {
  const { foldRevocation } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("r10-3a");
  const victim = mkEphemeralSshKey("r10-3b");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
        // Per M0 MED-1: a conformant revocation MUST carry the high-water
        // seq. Original test used a missing field which the permissive
        // branch silently allowed; MED-1 tightens that and conformant
        // revocations now declare the high-water explicitly.
        victim_chain_high_water_seq: 50,
      },
    });
    // Strictly prior (well before opens_at AND seq <= high-water).
    const victimChainEntries = [
      {
        type: "heartbeat",
        verified_id: victim.fingerprint,
        seq: 1,
        ts: "2026-05-20T09:00:00Z",
      },
    ];
    const result = foldRevocation(revocation, {
      victimChainEntries,
      state: { revocations: {} },
    });
    assert(
      result.accepted === true,
      "strictly prior activity does not contest",
    );
    assert(!result.contested, "no contest flag");
  } finally {
    cleanup(revoker.dir);
    cleanup(victim.dir);
  }
});

test("fold_rule_10_contested_advisory_names_revocation_signer", () => {
  const { foldRevocation } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("r10-4a");
  const victim = mkEphemeralSshKey("r10-4b");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    const victimChainEntries = [
      {
        type: "gate-approval",
        verified_id: victim.fingerprint,
        seq: 200,
        ts: "2026-05-20T11:30:00Z",
      },
    ];
    const result = foldRevocation(revocation, {
      victimChainEntries,
      state: { revocations: {} },
    });
    assert(result.contested === true, "contested");
    assertEqual(
      result.forging_signer,
      revoker.fingerprint,
      "advisory names the forger",
    );
    assert(result.reason && result.reason.includes("revocation contested"));
  } finally {
    cleanup(revoker.dir);
    cleanup(victim.dir);
  }
});

test("fold_rule_10_x_backdated_ts_cannot_un_contest_on_honest_clone", () => {
  // R10-A-01: the quiescence window is measured by the FOLDING CLONE'S
  // wall-clock now, NOT by X's self-stamped ts. A forger backdating X's
  // ts cannot un-fold a real X record on an honest clone — the clone's
  // wall-clock determines settlement; X's ts only orders X's own chain.
  // Here: even if we deliberately set X's ts to BEFORE the evidence window
  // (a "backdating" attempt), the CLONE's observation that the X record
  // exists at a seq inconsistent with the revocation still contests.
  const { foldRevocation } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("r10-5a");
  const victim = mkEphemeralSshKey("r10-5b");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    // Forger backdates X's ts to BEFORE opens_at, but X's seq exceeds
    // the seq the revoker had folded — i.e. the clone observes X-activity
    // the revoker did NOT include in its evidence window. Per the
    // architecture: the contest fires on seq OR ts not strictly prior.
    const victimChainEntries = [
      {
        type: "heartbeat",
        verified_id: victim.fingerprint,
        // Backdated ts strictly prior to opens_at — but seq inside the
        // evidence window's seq range.
        ts: "2026-05-20T08:00:00Z",
        seq: 99,
      },
    ];
    // The revoker's evidence window also carries the highest VICTIM SEQ
    // it had folded — backdating ts cannot reduce that observed seq on
    // an honest clone that observes the higher seq.
    revocation.content.evidence_window.victim_chain_high_water_seq = 50;
    const result = foldRevocation(revocation, {
      victimChainEntries,
      state: { revocations: {} },
    });
    assert(
      result.contested === true,
      "backdated ts cannot un-contest when victim seq is higher than revoker's evidence-window-claimed high-water",
    );
  } finally {
    cleanup(revoker.dir);
    cleanup(victim.dir);
  }
});

// =============================================================================
// Suite 3 — settlement (R10-A-01 wall-clock + R10-S-01 fetch-bounded)
// =============================================================================
console.log(
  "\n--- settlement — R10-A-01 (wall-clock quiescence) + R10-S-01 (fetch-bounded) ---",
);

test("settlement_blocked_until_liveness_ttl_quiescence", () => {
  const { isSettled, LIVENESS_TTL_MS } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("st-1");
  const victim = mkEphemeralSshKey("st-1v");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    // Clone's wall-clock now is BEFORE LIVENESS_TTL has elapsed since
    // the most recent observed X-activity (a heartbeat in this case).
    const lastX = {
      verified_id: victim.fingerprint,
      seq: 49,
      ts: "2026-05-20T09:30:00Z",
    };
    const settled = isSettled(revocation, {
      foldedHighWaterSeq: 60,
      peerHighWaterFor: () => 60,
      lastXActivity: lastX,
      now: Date.parse("2026-05-20T12:10:00Z"), // only 10min after revocation, less than 20min TTL
    });
    assert(settled.settled === false, "not yet settled within LIVENESS_TTL");
    assert(settled.reason.includes("quiescence"), "reason cites quiescence");
    // sanity-check the constant is the documented 20 minutes
    assertEqual(LIVENESS_TTL_MS, 20 * 60 * 1000, "LIVENESS_TTL is 20 minutes");
  } finally {
    cleanup(revoker.dir);
    cleanup(victim.dir);
  }
});

test("settlement_blocked_when_peer_high_water_unknown", () => {
  // R10-S-01: clone MAY treat revocation as settled only if it has fetched
  // X's per-emitter chain peer-high-water. Unknown high-water → NOT settled.
  const { isSettled } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("st-2");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    const settled = isSettled(revocation, {
      foldedHighWaterSeq: 60,
      peerHighWaterFor: () => null, // unknown / not fetched
      lastXActivity: null,
      now: Date.parse("2026-05-21T12:00:00Z"), // a full day later (well past TTL)
    });
    assert(settled.settled === false, "peer high-water unknown → not settled");
    assert(
      settled.reason && settled.reason.includes("peer high-water"),
      "reason cites peer high-water",
    );
  } finally {
    cleanup(revoker.dir);
  }
});

test("settlement_blocked_when_local_high_water_below_peer_high_water", () => {
  // R10-S-01: settlement = false until local fold catches up to peer.
  const { isSettled } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("st-3");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    const settled = isSettled(revocation, {
      foldedHighWaterSeq: 60, // local fold seq for X
      peerHighWaterFor: () => 80, // peer reports X has emitted up to seq 80
      lastXActivity: null,
      now: Date.parse("2026-05-21T12:00:00Z"),
    });
    assert(
      settled.settled === false,
      "local fold below peer high-water → not settled",
    );
    assert(
      settled.reason && settled.reason.includes("catch up"),
      "reason cites catch-up",
    );
  } finally {
    cleanup(revoker.dir);
  }
});

test("settlement_proceeds_when_quiescence_and_fetch_complete", () => {
  const { isSettled } = require(FOLD_RULE_10);
  const revoker = mkEphemeralSshKey("st-4");
  const victim = mkEphemeralSshKey("st-4v");
  try {
    const revocation = makeRevocationRecord({
      revokerKey: revoker,
      victimLogin: "bob",
      seq: 100,
      ts: "2026-05-20T12:00:00Z",
      evidenceWindow: {
        opens_at: "2026-05-20T10:00:00Z",
        closes_at: "2026-05-20T12:00:00Z",
      },
    });
    // Quiescence complete: last X-activity well over 20 min ago by clone's
    // wall-clock. Fetch complete: local high-water >= peer high-water.
    const settled = isSettled(revocation, {
      foldedHighWaterSeq: 80,
      peerHighWaterFor: () => 80,
      lastXActivity: {
        verified_id: victim.fingerprint,
        seq: 50,
        ts: "2026-05-20T11:30:00Z",
      },
      now: Date.parse("2026-05-20T13:00:00Z"), // 60min after revocation, well past TTL
    });
    assert(settled.settled === true, "quiescence + fetch complete → settled");
  } finally {
    cleanup(revoker.dir);
    cleanup(victim.dir);
  }
});

// =============================================================================
// Suite 4 — ceremonies (lib/owner-add-ceremony.js + lib/owner-depart-ceremony.js)
// =============================================================================
console.log(
  "\n--- attestation + revocation ceremonies (R10-A-02 evidence window) ---",
);

test("attestation_ceremony_writes_signed_record_with_gh_api_capture", () => {
  const { runAttestationCeremony } = require(OWNER_ADD);
  const owner = mkEphemeralSshKey("att-1o");
  const newCollab = mkEphemeralSshKey("att-1n");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-owner",
          display_id: "alice",
          github_login: "alice",
          fingerprint: owner.fingerprint,
          pubKey: owner.pubKey,
        },
      ],
      contributors: [
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: newCollab.fingerprint,
          pubKey: newCollab.pubKey,
        },
      ],
    });
    const ghApi = makeGhApiMock({ collaborators: ["alice", "bob"] });
    const result = runAttestationCeremony({
      roster,
      repoOwner: "alice",
      repo: "test-repo",
      newOwnerLogin: "bob",
      signer: {
        person_id: "pid-owner",
        verified_id: owner.fingerprint,
        keyPath: owner.keyPath,
        keyType: "ssh",
      },
      seq: 5,
      prevHash: null,
      now: () => "2026-05-20T12:00:00Z",
      ghApi,
    });
    assert(result.ok === true, `ceremony ok: ${result.error || ""}`);
    assertEqual(result.record.type, "collaborator-distinctness-attestation");
    assertEqual(result.record.content.github_login, "bob");
    // M3 HIGH-2/HIGH-4 (post-hardening): shape is
    // { collaborators: Array<...>, capture_ts: ISO }
    const cap0 = result.record.content.gh_api_collaborators_capture;
    assert(
      cap0 && Array.isArray(cap0.collaborators),
      "captures gh api body (collaborators array wrapped with capture_ts)",
    );
    assert(
      typeof cap0.capture_ts === "string" && cap0.capture_ts.length > 0,
      "capture_ts is present",
    );
    assert(result.record.sig, "record is signed");
  } finally {
    cleanup(owner.dir);
    cleanup(newCollab.dir);
  }
});

test("revocation_ceremony_writes_signed_record_with_evidence_window", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const owner = mkEphemeralSshKey("rev-1o");
  const departing = mkEphemeralSshKey("rev-1d");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-owner",
          display_id: "alice",
          github_login: "alice",
          fingerprint: owner.fingerprint,
          pubKey: owner.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: departing.fingerprint,
          pubKey: departing.pubKey,
        },
      ],
    });
    // After departure, bob is no longer a collaborator on the live gh api.
    const ghApi = makeGhApiMock({ collaborators: ["alice"] });
    // The revoker has folded bob's chain up to seq=42 / ts=11:00
    const result = runRevocationCeremony({
      roster,
      repoOwner: "alice",
      repo: "test-repo",
      departingLogin: "bob",
      signer: {
        person_id: "pid-owner",
        verified_id: owner.fingerprint,
        keyPath: owner.keyPath,
        keyType: "ssh",
      },
      seq: 100,
      prevHash: null,
      now: () => "2026-05-20T12:00:00Z",
      ghApi,
      mostRecentVictimChainEntry: {
        verified_id: departing.fingerprint,
        seq: 42,
        ts: "2026-05-20T11:00:00Z",
      },
    });
    assert(result.ok === true, `ceremony ok: ${result.error || ""}`);
    assertEqual(result.record.type, "collaborator-distinctness-revocation");
    assertEqual(result.record.content.github_login, "bob");
    const w = result.record.content.evidence_window;
    assertEqual(
      w.opens_at,
      "2026-05-20T11:00:00Z",
      "opens_at = most recent X chain ts",
    );
    assertEqual(
      w.closes_at,
      "2026-05-20T12:00:00Z",
      "closes_at = revocation ts",
    );
    assertEqual(
      w.victim_chain_high_water_seq,
      42,
      "captures victim chain high-water",
    );
    assert(result.record.sig, "record is signed");
  } finally {
    cleanup(owner.dir);
    cleanup(departing.dir);
  }
});

test("revocation_ceremony_fails_closed_if_gh_api_shows_login_still_collaborator", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const owner = mkEphemeralSshKey("rev-2o");
  const departing = mkEphemeralSshKey("rev-2d");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-owner",
          display_id: "alice",
          github_login: "alice",
          fingerprint: owner.fingerprint,
          pubKey: owner.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: departing.fingerprint,
          pubKey: departing.pubKey,
        },
      ],
    });
    // bob IS still a collaborator — revocation MUST fail closed.
    const ghApi = makeGhApiMock({ collaborators: ["alice", "bob"] });
    const result = runRevocationCeremony({
      roster,
      repoOwner: "alice",
      repo: "test-repo",
      departingLogin: "bob",
      signer: {
        person_id: "pid-owner",
        verified_id: owner.fingerprint,
        keyPath: owner.keyPath,
        keyType: "ssh",
      },
      seq: 100,
      prevHash: null,
      now: () => "2026-05-20T12:00:00Z",
      ghApi,
      mostRecentVictimChainEntry: null,
    });
    assert(
      result.ok === false,
      "ceremony fails closed when bob still a collaborator",
    );
    assert(
      result.error && result.error.includes("still a collaborator"),
      `error names the failure: ${result.error}`,
    );
  } finally {
    cleanup(owner.dir);
    cleanup(departing.dir);
  }
});

test("revocation_ceremony_evidence_window_opens_at_most_recent_x_chain_entry_ts", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const owner = mkEphemeralSshKey("rev-3o");
  const departing = mkEphemeralSshKey("rev-3d");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-owner",
          display_id: "alice",
          github_login: "alice",
          fingerprint: owner.fingerprint,
          pubKey: owner.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: departing.fingerprint,
          pubKey: departing.pubKey,
        },
      ],
    });
    const ghApi = makeGhApiMock({ collaborators: ["alice"] });
    const result = runRevocationCeremony({
      roster,
      repoOwner: "alice",
      repo: "test-repo",
      departingLogin: "bob",
      signer: {
        person_id: "pid-owner",
        verified_id: owner.fingerprint,
        keyPath: owner.keyPath,
        keyType: "ssh",
      },
      seq: 100,
      prevHash: null,
      now: () => "2026-05-20T14:00:00Z",
      ghApi,
      mostRecentVictimChainEntry: {
        verified_id: departing.fingerprint,
        seq: 17,
        ts: "2026-05-20T09:00:00Z",
      },
    });
    assert(result.ok === true, `ceremony ok: ${result.error || ""}`);
    assertEqual(
      result.record.content.evidence_window.opens_at,
      "2026-05-20T09:00:00Z",
    );
  } finally {
    cleanup(owner.dir);
    cleanup(departing.dir);
  }
});

test("revocation_ceremony_evidence_window_closes_at_revocation_ts", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const owner = mkEphemeralSshKey("rev-4o");
  const departing = mkEphemeralSshKey("rev-4d");
  try {
    const roster = makeRoster({
      owners: [
        {
          person_id: "pid-owner",
          display_id: "alice",
          github_login: "alice",
          fingerprint: owner.fingerprint,
          pubKey: owner.pubKey,
        },
        {
          person_id: "pid-bob",
          display_id: "bob",
          github_login: "bob",
          fingerprint: departing.fingerprint,
          pubKey: departing.pubKey,
        },
      ],
    });
    const ghApi = makeGhApiMock({ collaborators: ["alice"] });
    const result = runRevocationCeremony({
      roster,
      repoOwner: "alice",
      repo: "test-repo",
      departingLogin: "bob",
      signer: {
        person_id: "pid-owner",
        verified_id: owner.fingerprint,
        keyPath: owner.keyPath,
        keyType: "ssh",
      },
      seq: 100,
      prevHash: null,
      now: () => "2026-05-20T15:30:00Z",
      ghApi,
      mostRecentVictimChainEntry: {
        verified_id: departing.fingerprint,
        seq: 17,
        ts: "2026-05-20T09:00:00Z",
      },
    });
    assert(result.ok === true);
    assertEqual(
      result.record.content.evidence_window.closes_at,
      "2026-05-20T15:30:00Z",
    );
    assertEqual(result.record.ts, "2026-05-20T15:30:00Z");
  } finally {
    cleanup(owner.dir);
    cleanup(departing.dir);
  }
});

// =============================================================================
// Suite 5 — M0 security review regression tests (MED-1 + HIGH-1 + HIGH-3 +
// LOW-5).
// =============================================================================
console.log("\n--- M0 security review regression tests ---");

test("fold_rule_10_rejects_revocation_with_missing_high_water_field", () => {
  const foldRule10 = require(FOLD_RULE_10);
  // Hand-build a revocation MISSING victim_chain_high_water_seq in the
  // evidence window. Pre-MED-1 the permissive branch let this through and
  // a forger could backdate-ts contest-bypass.
  const revocation = {
    type: "collaborator-distinctness-revocation",
    verified_id: "fingerprint-revoker",
    person_id: "pid-revoker",
    seq: 50,
    ts: "2026-05-20T01:00:00Z",
    sig: "sig",
    content: {
      github_login: "victim",
      evidence_window: {
        opens_at: "2026-05-20T00:00:00Z",
        closes_at: "2026-05-20T01:00:00Z",
        // victim_chain_high_water_seq INTENTIONALLY ABSENT
      },
    },
  };
  // Any X-signed entry whose TS is AFTER the window should contest. But
  // pre-MED-1 the seq-half passed permissively when the field was absent
  // — so an entry with TS strictly prior to opens_at would NOT contest.
  // MED-1: a missing high-water MUST force contest regardless of ts.
  const entries = [
    {
      verified_id: "fingerprint-victim",
      seq: 1,
      ts: "2026-05-19T00:00:00Z", // BEFORE opens_at
    },
  ];
  const result = foldRule10.foldRevocation(revocation, {
    victimChainEntries: entries,
    state: { revocations: {} },
  });
  assert(
    !result.accepted && result.contested === true,
    `MED-1: revocation with missing victim_chain_high_water_seq MUST contest (got accepted=${result.accepted}, reason=${result.reason})`,
  );
});

test("ceremony_owner_add_rejects_repo_owner_with_metachars", () => {
  const { runAttestationCeremony } = require(OWNER_ADD);
  const signerKey = mkEphemeralSshKey("ho3-add");
  try {
    const result = runAttestationCeremony({
      roster: { genesis: {}, persons: {} },
      repoOwner: "valid-owner; rm -rf /",
      repo: "test-repo",
      newOwnerLogin: "newowner",
      signer: {
        person_id: "pid-x",
        verified_id: signerKey.fingerprint,
        keyPath: signerKey.keyPath,
      },
      seq: 0,
      prevHash: null,
      now: () => "2026-05-20T00:00:00Z",
      ghApi: () => {
        throw new Error("ghApi MUST NOT be called when input fails validation");
      },
    });
    assert(!result.ok, "shell metachars in repoOwner MUST be rejected");
    assert(
      /invalid|valid GitHub login/i.test(result.error || ""),
      `error should name validation; got: ${result.error}`,
    );
  } finally {
    cleanup(signerKey.dir);
  }
});

test("ceremony_owner_depart_allowlists_collaborators_capture", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const signerKey = mkEphemeralSshKey("hi1-depart");
  try {
    // gh-api returns collaborators with non-allowlisted fields.
    const ghApi = (endpoint) => {
      if (endpoint === "repos/owner/test-repo/collaborators") {
        return {
          ok: true,
          status: 200,
          body: [
            {
              login: "alice",
              id: 12345,
              type: "User",
              avatar_url: "https://example.com/a.png",
              site_admin: false,
              email: "alice@example.com",
              permissions: {
                admin: true,
                push: true,
                pull: true,
                maintain: true,
                triage: true,
              },
            },
          ],
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const result = runRevocationCeremony({
      roster: { genesis: {}, persons: {} },
      repoOwner: "owner",
      repo: "test-repo",
      departingLogin: "departing",
      signer: {
        person_id: "pid-x",
        verified_id: signerKey.fingerprint,
        keyPath: signerKey.keyPath,
      },
      seq: 0,
      prevHash: null,
      now: () => "2026-05-20T00:00:00Z",
      ghApi,
      mostRecentVictimChainEntry: null,
    });
    assert(result.ok, `revocation should succeed; got ${result.error}`);
    // M3 HIGH-2/HIGH-4 (post-hardening): shape is
    // { collaborators: [...], capture_ts: ISO }
    const wrappedCap = result.record.content.gh_api_collaborators_capture;
    assert(
      wrappedCap && Array.isArray(wrappedCap.collaborators),
      "capture is wrapped {collaborators, capture_ts}",
    );
    assert(
      typeof wrappedCap.capture_ts === "string" &&
        wrappedCap.capture_ts.length > 0,
      "capture_ts is present (HIGH-4 freshness predicate input)",
    );
    const cap = wrappedCap.collaborators;
    assertEqual(cap.length, 1, "one collaborator captured");
    assertEqual(cap[0].login, "alice", "login retained");
    assertEqual(cap[0].type, "User", "type retained");
    assertEqual(
      cap[0].permissions,
      { admin: true, push: true },
      "permissions allowlisted to {admin, push}",
    );
    assert(cap[0].id === undefined, "id MUST be dropped");
    assert(cap[0].avatar_url === undefined, "avatar_url MUST be dropped");
    assert(cap[0].site_admin === undefined, "site_admin MUST be dropped");
    assert(cap[0].email === undefined, "email MUST be dropped");
  } finally {
    cleanup(signerKey.dir);
  }
});

// =============================================================================
// Summary
// =============================================================================
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
