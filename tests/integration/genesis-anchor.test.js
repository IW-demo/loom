/**
 * Tier-2 integration tests for shard A0b-2a (workspaces/multi-operator-coc,
 * design v11 §2.3 + §2.2 fold rule 9a + §4.3 genesis-anchor-guard.js).
 *
 * Per rules/testing.md 3-Tier: real ssh-keygen + real roster validator +
 * real canonicalSerialize. The ONLY mocked surface is `gh api` — it is an
 * external service that the CI environment cannot reach deterministically,
 * which testing.md Tier-2 permits ("real infrastructure" applies to the
 * substrate we own; `gh` is exogenous). The mock is a wrapper passed as a
 * function parameter (dependency injection), so the ceremony state machine
 * accepts a `ghApi` argument and tests substitute a deterministic fake.
 *
 * Five invariants per the shard contract (workspaces/multi-operator-coc/
 * todos/active/00-todos.md § A0b-2a):
 *   (1) Enrollment ceremony — network-permitted, blocking, fail-CLOSED
 *       on owner mismatch / root-commit unverified / no genesis owner.
 *   (2) Emit signed `genesis-anchor` record, owner-bound, capturing the
 *       raw `gh api` JSON.
 *   (3) `genesis-anchor-guard.js` fail-CLOSED on no anchor / invalid sig.
 *   (4) Fold rule 9a — first-wins by lowest seq, owner-bound, three-pinned-
 *       facts match the roster genesis block; trust-root fork on differing
 *       pinned facts (the §4.5 genesis residual).
 *   (5) `org`-owned anchor variant — R5-S-02 admin-membership check.
 *
 * Run: node tests/integration/genesis-anchor.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const FOLD = path.join(LIB_DIR, "fold-genesis-anchor.js");
const CEREMONY = path.join(LIB_DIR, "genesis-ceremony.js");
const GUARD = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "genesis-anchor-guard.js",
);
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");

// ---- minimal test harness (no external deps; mirrors coc-sign.test.js) ------
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

// ---- ephemeral key fixtures --------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-genesis-${label}-`));
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
    `coc-genesis-test-${label}`,
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  // SSH key fingerprint as the verified_id
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

// ---- gh-api mock factory -----------------------------------------------------
// Returns a function ghApi(endpoint) => {ok, status, body}; tests can override
// per-endpoint by passing `overrides`.
function makeGhApiMock(overrides) {
  const o = overrides || {};
  const defaultOwner = "verified-owner";
  const defaultRootCommit = "abc123def456";
  return function ghApi(endpoint) {
    if (o[endpoint]) return o[endpoint];
    if (endpoint === "repos/verified-owner/test-repo") {
      return {
        ok: true,
        status: 200,
        body: { owner: { login: defaultOwner, type: "User" } },
      };
    }
    if (
      endpoint === `repos/verified-owner/test-repo/commits/${defaultRootCommit}`
    ) {
      return {
        ok: true,
        status: 200,
        body: {
          sha: defaultRootCommit,
          commit: {
            author: { name: "verified-owner" },
            verification: {
              verified: true,
              reason: "valid",
              signature: "...",
              payload: "...",
            },
          },
        },
      };
    }
    if (endpoint === "orgs/test-org/memberships/verified-owner") {
      return {
        ok: true,
        status: 200,
        body: { role: "admin", state: "active", user: { login: defaultOwner } },
      };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

// ---- roster helpers ----------------------------------------------------------
function makeOwnerRoster({
  ownerLogin,
  ownerFingerprint,
  ownerPubkey,
  rootCommit,
  repoOwnerKind,
}) {
  return {
    genesis: {
      repo_owner: ownerLogin,
      repo_owner_kind: repoOwnerKind || "user",
      root_commit: rootCommit,
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-abc12345": {
        display_id: "owner",
        role: "owner",
        github_login: ownerLogin,
        host_role: "human",
        keys: [
          { type: "ssh", fingerprint: ownerFingerprint, pubkey: ownerPubkey },
        ],
      },
    },
  };
}

// ============================================================================
// Suite 1 — fold rule 9a (lib/fold-genesis-anchor.js)
// ============================================================================
console.log("\n--- fold rule 9a (lib/fold-genesis-anchor.js) ---");

test("fold_rule_9a_accepts_first_owner_bound_anchor", () => {
  const { foldGenesisAnchor } = require(FOLD);
  const { canonicalSerialize, sign, verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("a1");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const content = {
      genesis: {
        repo_owner: "verified-owner",
        repo_owner_kind: "user",
        root_commit: "abc123def456",
        genesis_generation: 0,
      },
      gh_api_owner_capture: { login: "verified-owner", type: "User" },
      gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
    };
    const recordCore = {
      type: "genesis-anchor",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content,
    };
    const bytes = canonicalSerialize(recordCore);
    const sigR = sign(bytes, { keyType: "ssh", keyPath: ownerKey.keyPath });
    assert(sigR.ok, "sign should succeed");
    const record = { ...recordCore, sig: sigR.sig };
    const result = foldGenesisAnchor(
      record,
      { trustRoot: null },
      roster,
      verify,
    );
    assert(result.accepted, `expected accepted; got ${result.reason}`);
    assert(result.foldState.trustRoot !== null, "trust root should be set");
    assertEqual(
      result.foldState.trustRoot.verified_id,
      ownerKey.fingerprint,
      "trust-root signer",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("fold_rule_9a_rejects_non_owner_bound_record", () => {
  const { foldGenesisAnchor } = require(FOLD);
  const { canonicalSerialize, sign, verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("a2-owner");
  const impostorKey = mkEphemeralSshKey("a2-impostor");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    // Impostor signs but is NOT in roster's owner person_id (not owner-bound)
    const recordCore = {
      type: "genesis-anchor",
      verified_id: impostorKey.fingerprint,
      person_id: "pid-impostor",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          root_commit: "abc123def456",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
      },
    };
    const bytes = canonicalSerialize(recordCore);
    const sigR = sign(bytes, { keyType: "ssh", keyPath: impostorKey.keyPath });
    assert(sigR.ok, "impostor sign should succeed mechanically");
    const record = { ...recordCore, sig: sigR.sig };
    const result = foldGenesisAnchor(
      record,
      { trustRoot: null },
      roster,
      verify,
    );
    assert(!result.accepted, "non-owner-bound record MUST be rejected");
    assert(
      /not owner-bound|signer not the verified owner|signer not in roster/i.test(
        result.reason || "",
      ),
      `reason should name the owner-bind failure; got: ${result.reason}`,
    );
  } finally {
    cleanup(ownerKey.dir);
    cleanup(impostorKey.dir);
  }
});

test("fold_rule_9a_detects_trust_root_fork_on_differing_pinned_facts", () => {
  const { foldGenesisAnchor } = require(FOLD);
  const { canonicalSerialize, sign, verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("a3-owner");
  const forgerKey = mkEphemeralSshKey("a3-forger");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    // First, fold the legitimate owner-bound anchor.
    const legitCore = {
      type: "genesis-anchor",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          root_commit: "abc123def456",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
      },
    };
    const legitBytes = canonicalSerialize(legitCore);
    const legitSig = sign(legitBytes, {
      keyType: "ssh",
      keyPath: ownerKey.keyPath,
    });
    const legitRecord = { ...legitCore, sig: legitSig.sig };
    const r1 = foldGenesisAnchor(
      legitRecord,
      { trustRoot: null },
      roster,
      verify,
    );
    assert(r1.accepted, "legitimate anchor should fold");

    // Now a forged-by-non-owner anchor with DIFFERENT pinned facts arrives.
    // For trust-root fork detection per fold rule 9a, the conflicting record
    // must also be verifying + owner-bound (otherwise rule 1 rejects first).
    // The §4.5 residual is: a NON-OWNER ENROLLED IN THEIR OWN CLONE produces
    // a structurally-valid anchor that's accepted LOCALLY (in their roster's
    // view); when an honest clone folds BOTH (theirs + the legitimate one
    // via fetch), differing pinned facts → trust-root fork. We model that
    // by submitting a second owner-bound anchor whose pinned facts disagree
    // with the trustRoot already accepted.
    const forkCore = {
      type: "genesis-anchor",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 1, // different seq
      prev_hash: null,
      ts: "2026-05-20T00:01:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          // Different root commit — the divergent pinned fact
          root_commit: "0000000000000000000000000000000000000000",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
        gh_api_root_commit_capture: {
          sha: "0000000000000000000000000000000000000000",
          verified: true,
        },
      },
    };
    const forkBytes = canonicalSerialize(forkCore);
    const forkSig = sign(forkBytes, {
      keyType: "ssh",
      keyPath: ownerKey.keyPath,
    });
    const forkRecord = { ...forkCore, sig: forkSig.sig };
    const r2 = foldGenesisAnchor(forkRecord, r1.foldState, roster, verify);
    assert(!r2.accepted, "fork record MUST NOT be accepted");
    assert(r2.fork === true, "fork flag MUST be set");
    assert(
      typeof r2.forging_signer === "string" && r2.forging_signer.length > 0,
      "forging_signer MUST be set",
    );
    assert(
      /trust-root fork/i.test(r2.reason || ""),
      `reason should name 'trust-root fork'; got: ${r2.reason}`,
    );
  } finally {
    cleanup(ownerKey.dir);
    cleanup(forgerKey.dir);
  }
});

test("fold_rule_9a_reconciles_benign_same_signer_same_facts_different_seq", () => {
  const { foldGenesisAnchor } = require(FOLD);
  const { canonicalSerialize, sign, verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("a4");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const baseContent = {
      genesis: {
        repo_owner: "verified-owner",
        repo_owner_kind: "user",
        root_commit: "abc123def456",
        genesis_generation: 0,
      },
      gh_api_owner_capture: { login: "verified-owner", type: "User" },
      gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
    };
    function makeRec(seq, ts) {
      const core = {
        type: "genesis-anchor",
        verified_id: ownerKey.fingerprint,
        person_id: "pid-owner-abc12345",
        seq,
        prev_hash: null,
        ts,
        content: baseContent,
      };
      const sigR = sign(canonicalSerialize(core), {
        keyType: "ssh",
        keyPath: ownerKey.keyPath,
      });
      return { ...core, sig: sigR.sig };
    }
    // Fold lower-seq first
    const r1 = foldGenesisAnchor(
      makeRec(0, "2026-05-20T00:00:00Z"),
      { trustRoot: null },
      roster,
      verify,
    );
    assert(r1.accepted, "first anchor accepted");
    assertEqual(r1.foldState.trustRoot.seq, 0, "trust-root seq=0");
    // Now a higher-seq same-signer same-facts arrives → benign reconcile,
    // NO fork, trust-root remains lowest-seq.
    const r2 = foldGenesisAnchor(
      makeRec(5, "2026-05-20T00:05:00Z"),
      r1.foldState,
      roster,
      verify,
    );
    assert(r2.accepted, `benign reconcile expected; reason: ${r2.reason}`);
    assert(!r2.fork, "must NOT be flagged as fork");
    assertEqual(r2.foldState.trustRoot.seq, 0, "trust-root remains lowest seq");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ============================================================================
// Suite 2 — enrollment ceremony (lib/genesis-ceremony.js)
// ============================================================================
console.log("\n--- enrollment ceremony (lib/genesis-ceremony.js) ---");

test("enroll_genesis_user_owned_writes_signed_anchor", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("e1");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi: makeGhApiMock(),
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(
      result.ok,
      `ceremony should succeed; error: ${result.error}, reason: ${result.reason}, step: ${result.step}`,
    );
    assertEqual(logged.length, 1, "exactly one record appended");
    const rec = logged[0];
    assertEqual(rec.type, "genesis-anchor", "record type");
    assertEqual(rec.verified_id, ownerKey.fingerprint, "owner-bound signer");
    assertEqual(rec.seq, 0, "seq=0");
    assertEqual(rec.prev_hash, null, "prev_hash=null");
    assert(rec.sig && rec.sig.length > 0, "sig present");
    assert(rec.content.gh_api_owner_capture, "gh_api owner capture present");
    assert(
      rec.content.gh_api_root_commit_capture,
      "gh_api root commit capture present",
    );
    assertEqual(
      rec.content.genesis.repo_owner,
      "verified-owner",
      "captured owner",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("enroll_genesis_org_owned_writes_signed_anchor", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("e2");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner", // login is the admin's login
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    // For org-owned: roster.genesis.repo_owner = org name, but the
    // condition-(c)-resolved owner is a person whose github_login is admin
    // of the org. Override the roster to reflect the org shape.
    roster.genesis.repo_owner = "test-org";
    const logged = [];
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "verified-owner" },
              verification: { verified: true, reason: "valid" },
            },
          },
        };
      }
      if (endpoint === "orgs/test-org/memberships/verified-owner") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "admin",
            state: "active",
            user: { login: "verified-owner" },
          },
        };
      }
      return { ok: false, status: 404, body: { message: "Not Found" } };
    };
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(
      result.ok,
      `org-owned ceremony should succeed; error: ${result.error}, reason: ${result.reason}, step: ${result.step}`,
    );
    assertEqual(logged.length, 1, "exactly one record appended");
    assert(
      logged[0].content.gh_api_org_membership_capture,
      "org membership capture present",
    );
    assertEqual(
      logged[0].content.gh_api_org_membership_capture.role,
      "admin",
      "admin role captured",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("enroll_genesis_fails_closed_if_gh_api_owner_mismatch", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("e3");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    // gh api returns a DIFFERENT owner than the roster declares
    const ghApi = (endpoint) => {
      if (endpoint === "repos/verified-owner/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "someone-else", type: "User" } },
        };
      }
      return makeGhApiMock()(endpoint);
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "ceremony MUST fail closed");
    assert(
      /owner mismatch|owner_mismatch/i.test(
        result.error || result.reason || "",
      ),
      `error should name owner mismatch; got: ${result.error}/${result.reason}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("enroll_genesis_fails_closed_if_root_commit_unverified", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("e4");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const ghApi = (endpoint) => {
      if (endpoint === "repos/verified-owner/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "verified-owner" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        };
      }
      return makeGhApiMock()(endpoint);
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "ceremony MUST fail closed on unverified root commit");
    assert(
      /root.commit|verification|unverified/i.test(
        result.error || result.reason || "",
      ),
      `error should name root-commit verification; got: ${result.error}/${result.reason}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("enroll_genesis_fails_closed_if_no_genesis_owner_in_roster", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("e5");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    // Demote the only owner to contributor — no owner whose github_login
    // resolves to the verified owner remains
    roster.persons["pid-owner-abc12345"].role = "contributor";
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi: makeGhApiMock(),
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "ceremony MUST fail closed when no owner declared");
    // The fail-CLOSED reason can surface as either "no genesis owner
    // declared" (condition-(c) explicit check) or "signing key not
    // owner-role" (the early signing-bind path catches it sooner when
    // the would-be owner was demoted). Both are correct fail-CLOSED
    // behaviors for the "no owner declared" scenario.
    assert(
      /no .*owner|owner not declared|no genesis owner|not owner-role/i.test(
        result.error || result.reason || "",
      ),
      `error should name an owner-bind / no-genesis-owner failure; got: ${result.error}/${result.reason}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ============================================================================
// Suite 2b — issue #358: org-owned bootstrap with unsigned root commit.
//
// Acceptance criteria from issue #358:
//   CASE A: org + unsigned root + admin signer (state=active) → ok=true,
//           record carries verification.verified=false +
//           org_membership.role=admin/state=active.
//   CASE B: user + unsigned root → still hard-blocks at 4-root-commit.
//   CASE C: org + verified root + admin signer → still ok=true (unchanged).
//   CASE D: org + unsigned root + signer role=member → still hard-blocks
//           at 3-org-admin (relaxation conditioned on admin attestation).
//   CASE E: org + unsigned root + admin signer state=pending → hard-blocks
//           at 3-org-admin with new "org membership not active" error.
// ============================================================================
console.log("\n--- issue #358 org-owned bootstrap relaxation ---");

test("issue_358_case_a_org_unsigned_root_admin_active_succeeds", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("358a");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "admin-user",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    roster.genesis.repo_owner = "test-org";
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        // Root commit is UNSIGNED (the issue #358 scenario).
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "some-departed-contributor" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        };
      }
      if (endpoint === "orgs/test-org/memberships/admin-user") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "admin",
            state: "active",
            user: { login: "admin-user" },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-26T00:00:00Z",
    });
    assert(
      result.ok,
      `issue #358 CASE A: org-owned bootstrap with unsigned root + admin signer MUST succeed; error: ${result.error}, reason: ${result.reason}, step: ${result.step}`,
    );
    assertEqual(logged.length, 1, "exactly one record appended");
    const rec = logged[0];
    // The signed record MUST carry the unverified state as evidence.
    const rootCap = rec.content.gh_api_root_commit_capture;
    assertEqual(
      rootCap.commit.verification.verified,
      false,
      "captured verification.verified MUST be false (the unverified state)",
    );
    assertEqual(
      rootCap.commit.verification.reason,
      "unsigned",
      "captured verification.reason MUST be 'unsigned' (the substituting evidence)",
    );
    // The signed record MUST carry the org-admin attestation as the
    // substituting verified-identity anchor.
    const orgCap = rec.content.gh_api_org_membership_capture;
    assert(orgCap, "gh_api_org_membership_capture MUST be present");
    assertEqual(orgCap.role, "admin", "org_membership.role == 'admin'");
    assertEqual(orgCap.state, "active", "org_membership.state == 'active'");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("issue_358_case_b_user_unsigned_root_still_blocks", () => {
  // Regression lock: the user-owned path is UNCHANGED. An unsigned root
  // commit MUST still hard-block at step 4-root-commit.
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("358b");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      // repoOwnerKind defaults to "user"
    });
    const ghApi = (endpoint) => {
      if (endpoint === "repos/verified-owner/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "verified-owner" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        };
      }
      return makeGhApiMock()(endpoint);
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-26T00:00:00Z",
    });
    assert(
      !result.ok,
      "issue #358 CASE B: user-owned + unsigned root MUST still hard-block",
    );
    assertEqual(
      result.step,
      "4-root-commit",
      "block MUST fire at step 4-root-commit",
    );
    assert(
      /root.commit|verification|unverified/i.test(
        result.error || result.reason || "",
      ),
      `error should name root-commit verification; got: ${result.error}/${result.reason}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("issue_358_case_c_org_signed_root_admin_still_succeeds", () => {
  // Regression lock: org-owned with verified root + admin signer remains
  // the canonical happy path. The relaxation MUST NOT regress this case.
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("358c");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "admin-user",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    roster.genesis.repo_owner = "test-org";
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "admin-user" },
              verification: { verified: true, reason: "valid" },
            },
          },
        };
      }
      if (endpoint === "orgs/test-org/memberships/admin-user") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "admin",
            state: "active",
            user: { login: "admin-user" },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-26T00:00:00Z",
    });
    assert(
      result.ok,
      `issue #358 CASE C: org + verified root MUST still succeed; error: ${result.error}, reason: ${result.reason}`,
    );
    assertEqual(logged.length, 1, "exactly one record appended");
    assertEqual(
      logged[0].content.gh_api_root_commit_capture.commit.verification.verified,
      true,
      "captured verification.verified MUST be true on signed-root path",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("issue_358_case_d_org_unsigned_root_non_admin_blocks_at_step_3", () => {
  // Adversarial: the relaxation MUST be conditioned on the admin
  // attestation. A signer who is NOT an org admin MUST still hard-block
  // at step 3, not slip through the relaxation.
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("358d");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "member-user",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    roster.genesis.repo_owner = "test-org";
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        // Unsigned (would relax IF admin attestation passed — but it doesn't).
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "some-contributor" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        };
      }
      if (endpoint === "orgs/test-org/memberships/member-user") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "member", // NOT admin
            state: "active",
            user: { login: "member-user" },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-26T00:00:00Z",
    });
    assert(
      !result.ok,
      "issue #358 CASE D: non-admin signer MUST still hard-block (relaxation conditioned on admin attestation)",
    );
    assertEqual(
      result.step,
      "3-org-admin",
      "block MUST fire at step 3-org-admin, not slip through to step 4 relaxation",
    );
    assert(
      /not an org admin/i.test(result.error || ""),
      `error should name 'not an org admin'; got: ${result.error}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("issue_358_case_e_org_unsigned_root_admin_pending_blocks_at_step_3", () => {
  // New gate: state=="active" is now required at Step 3 (per issue #358's
  // first proposed-fix condition). A pending or suspended admin MUST NOT
  // unlock the Step 4 relaxation — their attestation is not currently in
  // force as a verified-identity anchor.
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("358e");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "admin-user",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    roster.genesis.repo_owner = "test-org";
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "some-contributor" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        };
      }
      if (endpoint === "orgs/test-org/memberships/admin-user") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "admin",
            state: "pending", // NOT active
            user: { login: "admin-user" },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-26T00:00:00Z",
    });
    assert(
      !result.ok,
      "issue #358 CASE E: state=pending admin MUST hard-block (state=active gate)",
    );
    assertEqual(
      result.step,
      "3-org-admin",
      "block MUST fire at step 3-org-admin",
    );
    assert(
      /org membership not active|not 'active'/i.test(
        result.error || result.reason || "",
      ),
      `error should name 'org membership not active'; got: ${result.error}/${result.reason}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("issue_358_case_f_org_unsigned_root_admin_state_missing_blocks_at_step_3", () => {
  // Defense-in-depth (R1 reviewer M1): an old or non-conforming gh-api
  // response that omits the `state` field entirely MUST also block at
  // Step 3. Strict equality (r.body.state !== "active") fail-closes on
  // `undefined` — this test pins that disposition so a future refactor
  // cannot silently relax the check to e.g.
  // `state !== "pending" && state !== "suspended"` (which would accept
  // undefined).
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("358f");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "admin-user",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    roster.genesis.repo_owner = "test-org";
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "some-contributor" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        };
      }
      if (endpoint === "orgs/test-org/memberships/admin-user") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "admin",
            // state field deliberately OMITTED (non-conforming / old API shape)
            user: { login: "admin-user" },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-26T00:00:00Z",
    });
    assert(
      !result.ok,
      "issue #358 CASE F: undefined state MUST hard-block (fail-closed on missing field)",
    );
    assertEqual(
      result.step,
      "3-org-admin",
      "block MUST fire at step 3-org-admin",
    );
    assert(
      /org membership not active|not 'active'/i.test(
        result.error || result.reason || "",
      ),
      `error should name 'org membership not active'; got: ${result.error}/${result.reason}`,
    );
    assertEqual(logged.length, 0, "NO record appended on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ============================================================================
// Suite 3 — genesis-anchor-guard.js
// ============================================================================
console.log("\n--- genesis-anchor-guard.js ---");

function runGuard({ logPath, rosterPath, env, payload }) {
  const r = spawnSync("node", [GUARD], {
    input: JSON.stringify(payload || {}),
    encoding: "utf8",
    env: {
      ...process.env,
      COC_GENESIS_GUARD_LOG_PATH: logPath || "",
      COC_GENESIS_GUARD_ROSTER_PATH: rosterPath || "",
      ...(env || {}),
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function setupGuardFixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-guard-${label}-`));
  return {
    dir,
    logPath: path.join(dir, "coordination-log.jsonl"),
    rosterPath: path.join(dir, "operators.roster.json"),
  };
}

test("genesis_anchor_guard_blocks_if_no_anchor", () => {
  const fx = setupGuardFixture("no-anchor");
  const ownerKey = mkEphemeralSshKey("g1");
  try {
    // Roster present but log empty (no genesis-anchor folded, no enrollment in-progress)
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    fs.writeFileSync(fx.logPath, "");
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(r.exitCode, 2, "exit code 2 = block at PreToolUse");
    // Stderr carries the user_summary (instructAndWait shape)
    assert(
      /genesis|anchor|trust.root/i.test(r.stderr || ""),
      `stderr should mention genesis/anchor/trust-root; got: ${r.stderr}`,
    );
  } finally {
    cleanup(fx.dir);
    cleanup(ownerKey.dir);
  }
});

// F72 (issue #379) — fresh-consumer vs enrolled-then-deleted discrimination.
test("genesis_anchor_guard_advisory_if_fresh_consumer_no_roster_no_log", () => {
  const fx = setupGuardFixture("fresh-consumer");
  try {
    // Fresh USE-template consumer: substrate hooks shipped, but NEVER enrolled.
    // No operators.roster.json AND no coordination-log records = never enrolled.
    // Both paths point at non-existent files (loadRoster → null; loadLogRecords → []).
    const r = runGuard({
      logPath: path.join(fx.dir, "does-not-exist-log.jsonl"),
      rosterPath: path.join(fx.dir, "does-not-exist-roster.json"),
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'first commit'" },
      },
    });
    assertEqual(
      r.exitCode,
      0,
      "exit 0 = advisory pass-through (fresh consumer can commit)",
    );
    assert(
      /fresh.substrate|never.enrolled|advisory/i.test(r.stderr || ""),
      `stderr should mention fresh-substrate/advisory; got: ${r.stderr}`,
    );
  } finally {
    cleanup(fx.dir);
  }
});

test("genesis_anchor_guard_blocks_if_roster_missing_but_log_has_records", () => {
  const fx = setupGuardFixture("enrolled-deleted");
  try {
    // Enrolled-then-deleted: the coordination log carries enrollment records
    // but the roster (a tracked, committed file) was deleted. This is the
    // guard-escape-by-roster-deletion attack — MUST fail-CLOSED (exit 2).
    fs.writeFileSync(
      fx.logPath,
      JSON.stringify({
        type: "genesis-anchor",
        verified_id: "deadbeef",
        seq: 0,
        prev_hash: null,
      }) + "\n",
    );
    // rosterPath intentionally points at a non-existent file (deleted roster).
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: path.join(fx.dir, "deleted-roster.json"),
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'escape attempt'" },
      },
    });
    assertEqual(
      r.exitCode,
      2,
      "exit 2 = block (roster missing on a previously-enrolled repo)",
    );
    assert(
      /previously.enrolled|enrolled.*record|restore|missing/i.test(
        r.stderr || "",
      ),
      `stderr should mention previously-enrolled/restore; got: ${r.stderr}`,
    );
  } finally {
    cleanup(fx.dir);
  }
});

test("genesis_anchor_guard_blocks_if_anchor_signature_invalid", () => {
  const fx = setupGuardFixture("invalid-sig");
  const ownerKey = mkEphemeralSshKey("g2");
  try {
    const { canonicalSerialize, sign } = require(COC_SIGN);
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    // Build a record but TAMPER with the content after signing — sig won't verify
    const core = {
      type: "genesis-anchor",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          root_commit: "abc123def456",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
      },
    };
    const sigR = sign(canonicalSerialize(core), {
      keyType: "ssh",
      keyPath: ownerKey.keyPath,
    });
    // Tamper: change the captured owner to a different name AFTER signing
    const tampered = JSON.parse(JSON.stringify(core));
    tampered.content.gh_api_owner_capture.login = "evil-attacker";
    fs.writeFileSync(
      fx.logPath,
      JSON.stringify({ ...tampered, sig: sigR.sig }) + "\n",
    );
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(r.exitCode, 2, "exit 2 = block on invalid signature");
  } finally {
    cleanup(fx.dir);
    cleanup(ownerKey.dir);
  }
});

test("genesis_anchor_guard_allows_with_valid_anchor", () => {
  const fx = setupGuardFixture("valid-anchor");
  const ownerKey = mkEphemeralSshKey("g3");
  try {
    const { canonicalSerialize, sign } = require(COC_SIGN);
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    const core = {
      type: "genesis-anchor",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          root_commit: "abc123def456",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
      },
    };
    const sigR = sign(canonicalSerialize(core), {
      keyType: "ssh",
      keyPath: ownerKey.keyPath,
    });
    fs.writeFileSync(
      fx.logPath,
      JSON.stringify({ ...core, sig: sigR.sig }) + "\n",
    );
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(
      r.exitCode,
      0,
      `exit 0 = pass-through; stderr was: ${r.stderr}`,
    );
  } finally {
    cleanup(fx.dir);
    cleanup(ownerKey.dir);
  }
});

test("genesis_anchor_guard_halt_and_report_on_local_genesis_generation_below_peer", () => {
  const fx = setupGuardFixture("gen-partition");
  const ownerKey = mkEphemeralSshKey("g4");
  try {
    const { canonicalSerialize, sign } = require(COC_SIGN);
    // Local roster says genesis_generation=0, but the log carries a
    // signature-verifying genesis-migration record at generation 1 → local
    // is BELOW peer-observed high-water → degrade to halt-and-report.
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    roster.genesis.genesis_generation = 0;
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));

    // Write a valid anchor at gen 0 AND a genesis-migration at gen 1
    const anchorCore = {
      type: "genesis-anchor",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          root_commit: "abc123def456",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123def456", verified: true },
      },
    };
    const anchorSig = sign(canonicalSerialize(anchorCore), {
      keyType: "ssh",
      keyPath: ownerKey.keyPath,
    });

    const migrationCore = {
      type: "genesis-migration",
      verified_id: ownerKey.fingerprint,
      person_id: "pid-owner-abc12345",
      seq: 1,
      prev_hash: "deadbeef",
      ts: "2026-05-20T01:00:00Z",
      content: {
        genesis: {
          repo_owner: "verified-owner",
          repo_owner_kind: "user",
          root_commit: "abc123def456",
          genesis_generation: 1, // higher than local roster
        },
        gh_api_owner_capture: { login: "verified-owner", type: "User" },
      },
    };
    const migrationSig = sign(canonicalSerialize(migrationCore), {
      keyType: "ssh",
      keyPath: ownerKey.keyPath,
    });

    fs.writeFileSync(
      fx.logPath,
      JSON.stringify({ ...anchorCore, sig: anchorSig.sig }) +
        "\n" +
        JSON.stringify({ ...migrationCore, sig: migrationSig.sig }) +
        "\n",
    );

    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    // halt-and-report = exit 0 + stderr advisory (not exit 2)
    assertEqual(
      r.exitCode,
      0,
      `halt-and-report should exit 0; stderr: ${r.stderr}`,
    );
    assert(
      /halt|partition|generation|stale.root/i.test(r.stderr || ""),
      `stderr should signal generation partition; got: ${r.stderr}`,
    );
  } finally {
    cleanup(fx.dir);
    cleanup(ownerKey.dir);
  }
});

// ============================================================================
// Suite 4 — M0 security review regression tests (HIGH-1 / HIGH-2 / HIGH-3 +
// LOW-1 smoke exports). Each test pins a structural defense the M0 review
// flagged on PRs #299-#303.
// ============================================================================
console.log("\n--- M0 security review regression tests ---");

test("gh_api_owner_capture_drops_repo_description_and_billing_fields", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi1-owner");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    // Synthetic gh-api response carrying SENSITIVE non-allowlisted fields.
    const ghApi = (endpoint) => {
      if (endpoint === "repos/verified-owner/test-repo") {
        return {
          ok: true,
          status: 200,
          body: {
            owner: {
              login: "verified-owner",
              type: "User",
              avatar_url: "https://example.com/avatar.png",
              site_admin: false,
            },
            name: "test-repo",
            full_name: "verified-owner/test-repo",
            description: "MY SECRET DESCRIPTION",
            homepage: "https://internal.example.com",
            private: true,
            billing_email: "owner@example.com",
            permissions: { admin: true, push: true, pull: true },
          },
        };
      }
      return makeGhApiMock()(endpoint);
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(result.ok, `ceremony should succeed; got ${result.error}`);
    const capture = logged[0].content.gh_api_owner_capture;
    // Allowlisted fields present
    assertEqual(capture.owner.login, "verified-owner", "owner.login retained");
    assertEqual(capture.owner.type, "User", "owner.type retained");
    assertEqual(capture.name, "test-repo", "name retained");
    assertEqual(
      capture.full_name,
      "verified-owner/test-repo",
      "full_name retained",
    );
    // Non-allowlisted fields DROPPED
    assert(capture.description === undefined, "description MUST be dropped");
    assert(capture.homepage === undefined, "homepage MUST be dropped");
    assert(capture.private === undefined, "private MUST be dropped");
    assert(
      capture.billing_email === undefined,
      "billing_email MUST be dropped",
    );
    assert(capture.permissions === undefined, "permissions MUST be dropped");
    assert(
      capture.owner.avatar_url === undefined,
      "owner.avatar_url MUST be dropped",
    );
    assert(
      capture.owner.site_admin === undefined,
      "owner.site_admin MUST be dropped",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("gh_api_commit_capture_drops_internal_ids", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi1-commit");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const ghApi = (endpoint) => {
      if (endpoint === "repos/verified-owner/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            node_id: "MDQ6Q29tbWl0SU5URVJOQUw=",
            url: "https://api.github.com/...",
            commit: {
              author: {
                name: "verified-owner",
                email: "owner@example.com",
                date: "2026-05-20T00:00:00Z",
              },
              tree: { sha: "treesha", url: "..." },
              committer: { name: "x", email: "x@y" },
              message: "INTERNAL COMMIT MESSAGE",
              verification: {
                verified: true,
                reason: "valid",
                signature: "sig-armor",
                payload: "payload-bytes",
              },
            },
            author: {
              login: "verified-owner",
              id: 12345,
              avatar_url: "https://example.com/avatar.png",
            },
            stats: { total: 100, additions: 50, deletions: 50 },
            parents: [{ sha: "parent" }],
          },
        };
      }
      return makeGhApiMock()(endpoint);
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(result.ok, `ceremony should succeed; got ${result.error}`);
    const cap = logged[0].content.gh_api_root_commit_capture;
    // Allowlisted fields retained
    assertEqual(cap.sha, "abc123def456", "sha retained");
    assertEqual(
      cap.commit.verification.verified,
      true,
      "verification.verified retained",
    );
    assertEqual(
      cap.commit.verification.signature,
      "sig-armor",
      "verification.signature retained",
    );
    assertEqual(
      cap.commit.author.email,
      "owner@example.com",
      "commit.author.email retained",
    );
    assertEqual(cap.author.login, "verified-owner", "author.login retained");
    // Non-allowlisted fields dropped
    assert(cap.node_id === undefined, "node_id MUST be dropped");
    assert(cap.url === undefined, "url MUST be dropped");
    assert(cap.commit.tree === undefined, "commit.tree MUST be dropped");
    assert(
      cap.commit.committer === undefined,
      "commit.committer MUST be dropped",
    );
    assert(cap.commit.message === undefined, "commit.message MUST be dropped");
    assert(cap.stats === undefined, "stats MUST be dropped");
    assert(cap.parents === undefined, "parents MUST be dropped");
    assert(cap.author.id === undefined, "author.id MUST be dropped");
    assert(
      cap.author.avatar_url === undefined,
      "author.avatar_url MUST be dropped",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("gh_api_org_membership_capture_drops_non_allowlisted_fields", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi1-org");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "test-org",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    // Person's github_login MUST resolve to admin
    roster.persons["pid-owner-abc12345"].github_login = "admin-user";
    const ghApi = (endpoint) => {
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      if (endpoint === "orgs/test-org/memberships/admin-user") {
        return {
          ok: true,
          status: 200,
          body: {
            role: "admin",
            state: "active",
            url: "https://api.github.com/orgs/test-org/memberships/admin-user",
            user: {
              login: "admin-user",
              id: 99999,
              site_admin: false,
              email: "admin@org.example",
            },
            organization: {
              login: "test-org",
              id: 11111,
              description: "INTERNAL ORG DESCRIPTION",
              billing_email: "ops@org.example",
            },
          },
        };
      }
      if (endpoint === "repos/test-org/test-repo/commits/abc123def456") {
        return {
          ok: true,
          status: 200,
          body: {
            sha: "abc123def456",
            commit: {
              author: { name: "admin-user" },
              verification: { verified: true, reason: "valid" },
            },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    };
    const logged = [];
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: (rec) => {
        logged.push(rec);
        return { ok: true };
      },
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(result.ok, `org ceremony should succeed; got ${result.error}`);
    const m = logged[0].content.gh_api_org_membership_capture;
    assertEqual(m.role, "admin", "role retained");
    assertEqual(m.user.login, "admin-user", "user.login retained");
    assertEqual(
      m.organization.login,
      "test-org",
      "organization.login retained",
    );
    assert(m.url === undefined, "url MUST be dropped");
    assert(m.user.id === undefined, "user.id MUST be dropped");
    assert(m.user.email === undefined, "user.email MUST be dropped");
    assert(
      m.organization.description === undefined,
      "organization.description MUST be dropped",
    );
    assert(
      m.organization.billing_email === undefined,
      "organization.billing_email MUST be dropped",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

// HIGH-3: GitHub-login + repo-name validation BEFORE endpoint construction.
test("ceremony_rejects_repo_owner_with_path_traversal", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi3-trav");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "../../etc/passwd", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi: () => {
        throw new Error("ghApi MUST NOT be called when input fails validation");
      },
      transportAppend: () => ({ ok: true }),
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "path-traversal in repo.owner MUST be rejected");
    assert(
      /invalid|valid GitHub login/i.test(result.error || result.reason || ""),
      `error should name input validation; got: ${result.error}/${result.reason}`,
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("ceremony_rejects_repo_name_with_shell_metachars", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi3-shell");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "verified-owner", name: "test-repo;rm -rf /" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi: () => {
        throw new Error("ghApi MUST NOT be called when input fails validation");
      },
      transportAppend: () => ({ ok: true }),
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "shell metachars in repo.name MUST be rejected");
    assert(
      /invalid|valid repo name/i.test(result.error || result.reason || ""),
      `error should name input validation; got: ${result.error}/${result.reason}`,
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("ceremony_rejects_admin_login_with_url_query_injection", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi3-url");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "test-org",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
      repoOwnerKind: "org",
    });
    // Corrupt the signing person's github_login with URL query injection
    roster.persons["pid-owner-abc12345"].github_login =
      "admin?token=stolen&path=/x";
    let ghApiCalls = 0;
    const ghApi = (endpoint) => {
      ghApiCalls += 1;
      // First call is repos/test-org/test-repo (valid declaredOwner pre-check
      // passes). Step 3 should reject before calling the orgs endpoint.
      if (endpoint === "repos/test-org/test-repo") {
        return {
          ok: true,
          status: 200,
          body: { owner: { login: "test-org", type: "Organization" } },
        };
      }
      throw new Error(`ghApi called with corrupt admin login: ${endpoint}`);
    };
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "test-org", name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi,
      transportAppend: () => ({ ok: true }),
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "URL query injection in adminLogin MUST be rejected");
    assert(
      /invalid|valid GitHub login|github_login/i.test(
        result.error || result.reason || "",
      ),
      `error should name admin-login validation; got: ${result.error}/${result.reason}`,
    );
    // The orgs/ endpoint MUST NOT be called.
    assert(ghApiCalls === 1, "only repos/{owner}/{repo} called before reject");
  } finally {
    cleanup(ownerKey.dir);
  }
});

test("ceremony_rejects_overlong_repo_owner", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("hi3-long");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    // 40 chars — exceeds GitHub's 39-char login cap
    const overlong = "a".repeat(40);
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: overlong, name: "test-repo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      ghApi: () => {
        throw new Error("ghApi MUST NOT be called when input fails validation");
      },
      transportAppend: () => ({ ok: true }),
      now: () => "2026-05-20T00:00:00Z",
    });
    assert(!result.ok, "overlong repo.owner MUST be rejected");
    assert(
      /invalid|valid GitHub login/i.test(result.error || result.reason || ""),
      `error should name input validation; got: ${result.error}/${result.reason}`,
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

// HIGH-2: enrollment-marker authentication.
test("enrollment_marker_unsigned_file_does_not_bypass_guard", () => {
  const fx = setupGuardFixture("h2-unsigned");
  const ownerKey = mkEphemeralSshKey("h2u");
  try {
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    fs.writeFileSync(fx.logPath, "");
    // Empty marker file — pre-HIGH-2 this would pass-through.
    const markerPath = path.join(fx.dir, "marker");
    fs.writeFileSync(markerPath, "x");
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      env: { COC_GENESIS_GUARD_ENROLLMENT_MARKER: markerPath },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(
      r.exitCode,
      2,
      "unsigned marker MUST NOT bypass guard (fail-CLOSED)",
    );
  } finally {
    cleanup(fx.dir);
    cleanup(ownerKey.dir);
  }
});

test("enrollment_marker_signed_by_wrong_key_does_not_bypass_guard", () => {
  const fx = setupGuardFixture("h2-wrongkey");
  const ownerKey = mkEphemeralSshKey("h2w-owner");
  const otherKey = mkEphemeralSshKey("h2w-other");
  try {
    const { canonicalSerialize, sign } = require(COC_SIGN);
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: ownerKey.fingerprint,
      ownerPubkey: ownerKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    fs.writeFileSync(fx.logPath, "");
    // Marker signed by a key NOT in the roster.
    const markerCore = {
      ceremony_start_ts: "2026-05-20T00:00:00Z",
      candidate_signer_fingerprint: otherKey.fingerprint,
      target_repo_owner: "verified-owner",
      target_root_commit: "abc123def456",
    };
    const sigR = sign(canonicalSerialize(markerCore), {
      keyType: "ssh",
      keyPath: otherKey.keyPath,
    });
    assert(sigR.ok, "wrong-key sign should succeed mechanically");
    const markerPath = path.join(fx.dir, "marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ ...markerCore, sig: sigR.sig }),
    );
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      env: { COC_GENESIS_GUARD_ENROLLMENT_MARKER: markerPath },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(
      r.exitCode,
      2,
      "wrong-key marker MUST NOT bypass guard (fail-CLOSED)",
    );
  } finally {
    cleanup(fx.dir);
    cleanup(ownerKey.dir);
    cleanup(otherKey.dir);
  }
});

test("enrollment_marker_signed_by_candidate_signer_bypasses_guard", () => {
  const fx = setupGuardFixture("h2-candidate");
  const candidateKey = mkEphemeralSshKey("h2c");
  try {
    const { canonicalSerialize, sign } = require(COC_SIGN);
    // Roster has the candidate signer's key (as a PLACEHOLDER-prefixed
    // person for the fresh-genesis case AND a normal entry).
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: candidateKey.fingerprint,
      ownerPubkey: candidateKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    fs.writeFileSync(fx.logPath, "");
    const markerCore = {
      ceremony_start_ts: "2026-05-20T00:00:00Z",
      candidate_signer_fingerprint: candidateKey.fingerprint,
      target_repo_owner: "verified-owner",
      target_root_commit: "abc123def456",
    };
    const sigR = sign(canonicalSerialize(markerCore), {
      keyType: "ssh",
      keyPath: candidateKey.keyPath,
    });
    assert(sigR.ok, "candidate sign should succeed");
    const markerPath = path.join(fx.dir, "marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ ...markerCore, sig: sigR.sig }),
    );
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      env: { COC_GENESIS_GUARD_ENROLLMENT_MARKER: markerPath },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(
      r.exitCode,
      0,
      `candidate-signed marker MUST bypass guard (pass-through); stderr: ${r.stderr}`,
    );
  } finally {
    cleanup(fx.dir);
    cleanup(candidateKey.dir);
  }
});

test("enrollment_marker_with_tampered_content_does_not_bypass_guard", () => {
  const fx = setupGuardFixture("h2-tampered");
  const candidateKey = mkEphemeralSshKey("h2t");
  try {
    const { canonicalSerialize, sign } = require(COC_SIGN);
    const roster = makeOwnerRoster({
      ownerLogin: "verified-owner",
      ownerFingerprint: candidateKey.fingerprint,
      ownerPubkey: candidateKey.pubKey,
      rootCommit: "abc123def456",
    });
    fs.writeFileSync(fx.rosterPath, JSON.stringify(roster, null, 2));
    fs.writeFileSync(fx.logPath, "");
    const markerCore = {
      ceremony_start_ts: "2026-05-20T00:00:00Z",
      candidate_signer_fingerprint: candidateKey.fingerprint,
      target_repo_owner: "verified-owner",
      target_root_commit: "abc123def456",
    };
    const sigR = sign(canonicalSerialize(markerCore), {
      keyType: "ssh",
      keyPath: candidateKey.keyPath,
    });
    // Tamper AFTER signing — change target_repo_owner.
    const tampered = {
      ...markerCore,
      target_repo_owner: "evil-attacker",
      sig: sigR.sig,
    };
    const markerPath = path.join(fx.dir, "marker.json");
    fs.writeFileSync(markerPath, JSON.stringify(tampered));
    const r = runGuard({
      logPath: fx.logPath,
      rosterPath: fx.rosterPath,
      env: { COC_GENESIS_GUARD_ENROLLMENT_MARKER: markerPath },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
      },
    });
    assertEqual(
      r.exitCode,
      2,
      "tampered marker MUST NOT bypass guard (fail-CLOSED)",
    );
  } finally {
    cleanup(fx.dir);
    cleanup(candidateKey.dir);
  }
});

// LOW-1: smoke tests for extension-point exports
test("ssh_namespace_constant_is_non_empty_string", () => {
  const cocSign = require(COC_SIGN);
  assert(
    typeof cocSign.SSH_NAMESPACE === "string" &&
      cocSign.SSH_NAMESPACE.length > 0,
    "SSH_NAMESPACE MUST be a non-empty string export",
  );
});

// ---- summary ----------------------------------------------------------------
console.log(`\n${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
if (FAIL > 0) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
