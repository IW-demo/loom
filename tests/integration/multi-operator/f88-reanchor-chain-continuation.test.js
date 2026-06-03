"use strict";
/**
 * F88 — end-to-end fold test for the genesis-migration re-anchor path.
 *
 * The F86 test suite mocked transportAppend (`() => ({ ok: true })`) and thus
 * verified the produced record's SHAPE + fold-rule-9c's accept-in-isolation,
 * but NEVER folded the produced record through the real engine against an
 * existing genesis-anchor. That gap hid TWO defects (journal/0172):
 *
 *   1. performMigration stamped seq:0/prev_hash:null — a CONTINUATION record
 *      on an emitter that already anchored a genesis-anchor at seq:0 forks
 *      under fold rule-3 (keyed on (verified_id, seq)), flagging the owner as
 *      an equivocator and never re-anchoring.
 *   2. foldGenesisMigration inherited root_commit from the prior trust root,
 *      so even a clean fold left the re-anchor's trust root pinned at the OLD
 *      SHA — a generation bump that achieved nothing.
 *
 * This suite seeds a REAL ssh-signed genesis-anchor, runs the re-anchor
 * ceremony, and folds the resulting log through the REAL coordination-log
 * engine — the user-flow walk that the F86 mock-transport tests skipped.
 *
 * Per rules/probe-driven-verification.md: every assertion is a STRUCTURAL
 * probe (fold-engine verdicts, record fields, exit shapes) — no regex over
 * prose.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const { runEnrollmentCeremony, performMigration } = require(
  path.join(LIB, "genesis-ceremony.js"),
);
const coordinationLog = require(path.join(LIB, "coordination-log.js"));

// Realistic hex SHAs so makeGhApiMock's commits regex (/[a-f0-9]+/) matches.
const OLD_ROOT = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const NEW_ROOT = "d98da8b8088ad5afe1e1a0232c18aa41e2db99d9";

// ---------------------------------------------------------------------------
// Fixtures (parity with f86-must-7-single-owner.test.js helpers)
// ---------------------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `f88-${label}-`));
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
    `f88-test-${label}`,
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

function makeGhApiMock() {
  return function ghApi(endpoint) {
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      const owner = endpoint.split("/")[1];
      return { ok: true, status: 200, body: { owner: { login: owner } } };
    }
    if (/^orgs\/[^/]+\/memberships\/[^/]+$/.test(endpoint)) {
      const parts = endpoint.split("/");
      return {
        ok: true,
        status: 200,
        body: {
          role: "admin",
          state: "active",
          user: { login: parts[3] },
          organization: { login: parts[1] },
        },
      };
    }
    if (/^repos\/[^/]+\/[^/]+\/commits\/[a-f0-9]+$/.test(endpoint)) {
      const sha = endpoint.split("/").pop();
      return {
        ok: true,
        status: 200,
        body: {
          sha,
          commit: {
            author: { name: "any-author" },
            verification: { verified: false, reason: "unsigned" },
          },
        },
      };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

function makeGitMock(overrides) {
  const o = overrides || {};
  return function git({ args }) {
    const key = args.join(" ");
    if (o[key] !== undefined) return o[key];
    return { ok: true, stdout: "", stderr: "", status: 0 };
  };
}

function makeOrgN1Roster(ownerKey) {
  return {
    genesis: {
      repo_owner: "myorg",
      repo_owner_kind: "org",
      root_commit: OLD_ROOT,
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-f88": {
        display_id: "owner",
        role: "owner",
        github_login: "alice",
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
}

function setupFixtureRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f88-repo-"));
  fs.mkdirSync(path.join(tmp, ".claude", "learning"), { recursive: true });
  return tmp;
}
const logPathFor = (tmp) =>
  path.join(tmp, ".claude", "learning", "coordination-log.jsonl");
const appendTo = (logPath) => (rec) => {
  fs.appendFileSync(logPath, JSON.stringify(rec) + "\n");
  return { ok: true };
};
const readRecords = (logPath) =>
  fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));

function seedSignedAnchor(key, roster, ghApi, append) {
  const enroll = runEnrollmentCeremony({
    roster,
    repo: { owner: "myorg", name: "kailash" },
    signingKeyPath: key.keyPath,
    signingKeyFingerprint: key.fingerprint,
    ghApi,
    transportAppend: append,
    keyType: "ssh",
  });
  assert.equal(enroll.ok, true, `enroll failed: ${JSON.stringify(enroll)}`);
  assert.equal(enroll.record.type, "genesis-anchor");
  assert.equal(enroll.record.seq, 0);
  return enroll.record;
}

// ---------------------------------------------------------------------------
// Scenario 1 — the fix: re-anchor chain-continues + re-points the trust root
// ---------------------------------------------------------------------------
test("F88: re-anchor chain-continues off the genesis-anchor, folds clean, re-points the trust root", () => {
  const key = mkEphemeralSshKey("e2e");
  const tmp = setupFixtureRepo();
  const logPath = logPathFor(tmp);
  try {
    const roster = makeOrgN1Roster(key);
    const ghApi = makeGhApiMock();
    const append = appendTo(logPath);

    const anchor = seedSignedAnchor(key, roster, ghApi, append);

    // Compute the expected chain head the migration MUST extend.
    const anchorFold = coordinationLog.foldLog([anchor], roster, {});
    const head = coordinationLog.computeOwnChainHead(
      anchorFold,
      key.fingerprint,
    );
    assert.ok(head, "anchor must fold + yield a chain head");
    assert.equal(head.lastSeq, 0);

    const git = makeGitMock({
      "rev-list --max-parents=0 HEAD": {
        ok: true,
        stdout: NEW_ROOT,
        stderr: "",
        status: 0,
      },
      "rev-list --max-parents=0 origin/main": {
        ok: true,
        stdout: NEW_ROOT,
        stderr: "",
        status: 0,
      },
    });

    const mig = performMigration({
      roster,
      repo: { owner: "myorg", name: "kailash" },
      signingKeyPath: key.keyPath,
      signingKeyFingerprint: key.fingerprint,
      ghApi,
      transportAppend: append,
      git,
      keyType: "ssh",
      kind: "re-anchor",
      newRootCommit: NEW_ROOT,
      preCorrectionRootCommit: OLD_ROOT,
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      cwd: tmp, // default readChainHead reads tmp/.claude/learning/coordination-log.jsonl
    });
    assert.equal(mig.ok, true, `migration failed: ${JSON.stringify(mig)}`);

    // (a) Chain-continuation — NOT the pre-F88 seq:0 fork.
    assert.equal(mig.record.seq, 1, "re-anchor MUST chain-continue at seq:1");
    assert.equal(
      mig.record.prev_hash,
      head.lastContentHash,
      "prev_hash MUST equal the genesis-anchor's content hash",
    );

    // (b) Fold BOTH records through the REAL engine.
    const records = readRecords(logPath);
    assert.equal(records.length, 2);
    const folded = coordinationLog.foldLog(records, roster, {});
    assert.equal(
      folded.forks.length,
      0,
      `expected no forks, got ${JSON.stringify(folded.forks)}`,
    );
    assert.equal(
      folded.accepted.length,
      2,
      `expected both accepted; rejected=${JSON.stringify(folded.rejected)}`,
    );

    // (c) Trust root re-pointed to the NEW root (Shard 1b) + generation bumped.
    assert.equal(
      folded.foldState.trustRoot.pinnedFacts.root_commit,
      NEW_ROOT,
      "re-anchor MUST re-point the trust root to the corrected root commit",
    );
    assert.equal(
      folded.foldState.trustRoot.genesis_generation,
      1,
      "genesis_generation MUST increment to 1",
    );
  } finally {
    cleanup(key.dir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 2 — regression lock: the pre-F88 seq:0 shape forks
// ---------------------------------------------------------------------------
test("F88 regression: a seq:0 migration (pre-fix shape) folded after the anchor IS detected as a fork", () => {
  const key = mkEphemeralSshKey("fork");
  const tmp = setupFixtureRepo();
  const logPath = logPathFor(tmp);
  try {
    const roster = makeOrgN1Roster(key);
    const ghApi = makeGhApiMock();
    const append = appendTo(logPath);

    seedSignedAnchor(key, roster, ghApi, append);

    const git = makeGitMock({
      "rev-list --max-parents=0 HEAD": {
        ok: true,
        stdout: NEW_ROOT,
        stderr: "",
        status: 0,
      },
      "rev-list --max-parents=0 origin/main": {
        ok: true,
        stdout: NEW_ROOT,
        stderr: "",
        status: 0,
      },
    });

    // Force the pre-F88 shape by injecting readChainHead → null (which yields
    // seq:0/prev_hash:null) — the exact bug F88 fixes.
    const mig = performMigration({
      roster,
      repo: { owner: "myorg", name: "kailash" },
      signingKeyPath: key.keyPath,
      signingKeyFingerprint: key.fingerprint,
      ghApi,
      transportAppend: append,
      git,
      keyType: "ssh",
      kind: "re-anchor",
      newRootCommit: NEW_ROOT,
      preCorrectionRootCommit: OLD_ROOT,
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      cwd: tmp,
      readChainHead: () => null, // simulate the pre-fix "always first record" bug
    });
    assert.equal(mig.ok, true);
    assert.equal(mig.record.seq, 0, "injected pre-fix shape → seq:0");

    const folded = coordinationLog.foldLog(readRecords(logPath), roster, {});
    assert.equal(
      folded.forks.length,
      1,
      "seq:0 migration MUST fork against the seq:0 anchor",
    );
    assert.equal(
      folded.forks[0].verified_id,
      key.fingerprint,
      "the fork names the emitter (the legitimate owner falsely flagged as equivocator pre-fix)",
    );
    // The migration is NOT accepted; the trust root is NOT re-anchored.
    assert.equal(
      folded.foldState.trustRoot.pinnedFacts.root_commit,
      OLD_ROOT,
      "pre-fix: trust root stays at the OLD root (re-anchor failed)",
    );
  } finally {
    cleanup(key.dir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 3 — malformed re-anchor (capture without sha) is REJECTED, not
// silently degraded to inherit the old root (zero-tolerance.md Rule 3).
// ---------------------------------------------------------------------------
test("F88: re-anchor with a capture lacking .sha is rejected by fold-rule-9c (no silent inherit)", () => {
  const key = mkEphemeralSshKey("malformed");
  const tmp = setupFixtureRepo();
  const logPath = logPathFor(tmp);
  try {
    const roster = makeOrgN1Roster(key);
    const ghApi = makeGhApiMock();
    const append = appendTo(logPath);
    const anchor = seedSignedAnchor(key, roster, ghApi, append);

    const head = coordinationLog.computeOwnChainHead(
      coordinationLog.foldLog([anchor], roster, {}),
      key.fingerprint,
    );

    // Hand-build a re-anchor migration whose gh_api_root_commit_capture has no
    // usable .sha, signed as a clean chain-continuation (seq:1) so it passes
    // rule-2/rule-3 and reaches fold-rule-9c — isolating the Shard-1b guard.
    const cocSign = require(path.join(LIB, "coc-sign.js"));
    const content = {
      new_repo_owner: "myorg",
      new_repo_owner_kind: "org",
      from_genesis_generation: 0,
      to_genesis_generation: 1,
      co_signers: [],
      co_sign_anchor_kind: "gh_api_org_membership_capture",
      gh_api_owner_capture: {
        owner: { login: "myorg" },
        name: "kailash",
        capture_ts: anchor.ts,
      },
      gh_api_org_membership_capture: {
        role: "admin",
        state: "active",
        user: { login: "alice" },
        organization: { login: "myorg" },
        capture_ts: anchor.ts,
      },
      pre_correction_root_commit: OLD_ROOT,
      gh_api_root_commit_capture: { commit: {} }, // ← no .sha
    };
    const core = {
      type: "genesis-migration",
      verified_id: key.fingerprint,
      person_id: "pid-owner-f88",
      seq: head.lastSeq + 1,
      prev_hash: head.lastContentHash,
      ts: new Date().toISOString(),
      content,
    };
    const signed = cocSign.sign(cocSign.canonicalSerialize(core), {
      keyType: "ssh",
      keyPath: key.keyPath,
    });
    assert.equal(signed.ok, true, `sign failed: ${JSON.stringify(signed)}`);
    append(Object.assign({}, core, { sig: signed.sig }));

    const folded = coordinationLog.foldLog(readRecords(logPath), roster, {});
    assert.equal(folded.forks.length, 0, "no fork (clean chain-continuation)");
    const migRejected = folded.rejected.find(
      (r) => r.record && r.record.type === "genesis-migration",
    );
    assert.ok(
      migRejected,
      `malformed re-anchor MUST be rejected; rejected=${JSON.stringify(folded.rejected)}`,
    );
    assert.match(migRejected.reason, /usable \.sha|root_commit_capture/);
    // Trust root unchanged — NOT silently inherited-and-accepted.
    assert.equal(folded.foldState.trustRoot.pinnedFacts.root_commit, OLD_ROOT);
  } finally {
    cleanup(key.dir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Helper for the hand-built malformed/stale re-anchor scenarios (4, 5):
// builds + signs a re-anchor migration record as a clean chain-continuation
// (seq:1, valid prev_hash) so rule-2/rule-3 pass and the record reaches the
// fold-rule-9c re-anchor block, with FRESH org/owner captures so the only
// rejection axis under test is the root capture itself.
function buildSignedReanchor(key, head, recordTs, rootCaptureOverride) {
  const cocSign = require(path.join(LIB, "coc-sign.js"));
  const content = {
    new_repo_owner: "myorg",
    new_repo_owner_kind: "org",
    from_genesis_generation: 0,
    to_genesis_generation: 1,
    co_signers: [],
    co_sign_anchor_kind: "gh_api_org_membership_capture",
    gh_api_owner_capture: {
      owner: { login: "myorg" },
      name: "kailash",
      capture_ts: recordTs, // FRESH relative to recordTs
    },
    gh_api_org_membership_capture: {
      role: "admin",
      state: "active",
      user: { login: "alice" },
      organization: { login: "myorg" },
      capture_ts: recordTs, // FRESH relative to recordTs
    },
    pre_correction_root_commit: OLD_ROOT,
    gh_api_root_commit_capture: rootCaptureOverride,
  };
  const core = {
    type: "genesis-migration",
    verified_id: key.fingerprint,
    person_id: "pid-owner-f88",
    seq: head.lastSeq + 1,
    prev_hash: head.lastContentHash,
    ts: recordTs,
    content,
  };
  const signed = cocSign.sign(cocSign.canonicalSerialize(core), {
    keyType: "ssh",
    keyPath: key.keyPath,
  });
  assert.equal(signed.ok, true, `sign failed: ${JSON.stringify(signed)}`);
  return Object.assign({}, core, { sig: signed.sig });
}

// ---------------------------------------------------------------------------
// Scenario 4 — asymmetric replay: a STALE root capture is rejected by its OWN
// fold-time freshness gate, even when the org/owner captures are FRESH. This
// proves the re-anchor root capture does not rely on the sibling captures'
// TTL gates for replay defense (security-reviewer MEDIUM-1).
// ---------------------------------------------------------------------------
test("F88: re-anchor with a STALE root capture is rejected even when org/owner captures are fresh", () => {
  const key = mkEphemeralSshKey("stale-root");
  const tmp = setupFixtureRepo();
  const logPath = logPathFor(tmp);
  try {
    const roster = makeOrgN1Roster(key);
    const append = appendTo(logPath);
    const anchor = seedSignedAnchor(key, roster, makeGhApiMock(), append);
    const head = coordinationLog.computeOwnChainHead(
      coordinationLog.foldLog([anchor], roster, {}),
      key.fingerprint,
    );

    const recordTs = new Date().toISOString();
    // Root capture_ts 20 min before the record → beyond MIGRATION_LIVENESS_TTL
    // (15 min). Org/owner captures use recordTs (fresh), isolating the root gate.
    const staleTs = new Date(
      Date.parse(recordTs) - 20 * 60 * 1000,
    ).toISOString();
    const rec = buildSignedReanchor(key, head, recordTs, {
      sha: NEW_ROOT,
      capture_ts: staleTs,
    });
    append(rec);

    const folded = coordinationLog.foldLog(readRecords(logPath), roster, {});
    assert.equal(folded.forks.length, 0, "no fork (clean chain-continuation)");
    const migRejected = folded.rejected.find(
      (r) => r.record && r.record.type === "genesis-migration",
    );
    assert.ok(
      migRejected,
      `stale-root re-anchor MUST be rejected; rejected=${JSON.stringify(folded.rejected)}`,
    );
    assert.match(migRejected.reason, /stale gh_api_root_commit_capture/);
    assert.equal(folded.foldState.trustRoot.pinnedFacts.root_commit, OLD_ROOT);
  } finally {
    cleanup(key.dir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 5 — a root capture whose .sha is not a valid commit-SHA shape is
// rejected (no junk pinned as the trust root) (security-reviewer LOW-1).
// ---------------------------------------------------------------------------
test("F88: re-anchor with a non-hex .sha is rejected by the commit-SHA shape gate", () => {
  const key = mkEphemeralSshKey("badsha");
  const tmp = setupFixtureRepo();
  const logPath = logPathFor(tmp);
  try {
    const roster = makeOrgN1Roster(key);
    const append = appendTo(logPath);
    const anchor = seedSignedAnchor(key, roster, makeGhApiMock(), append);
    const head = coordinationLog.computeOwnChainHead(
      coordinationLog.foldLog([anchor], roster, {}),
      key.fingerprint,
    );

    const recordTs = new Date().toISOString();
    const rec = buildSignedReanchor(key, head, recordTs, {
      sha: "not-a-real-commit-sha", // non-hex
      capture_ts: recordTs,
    });
    append(rec);

    const folded = coordinationLog.foldLog(readRecords(logPath), roster, {});
    const migRejected = folded.rejected.find(
      (r) => r.record && r.record.type === "genesis-migration",
    );
    assert.ok(
      migRejected,
      `non-hex sha re-anchor MUST be rejected; rejected=${JSON.stringify(folded.rejected)}`,
    );
    assert.match(migRejected.reason, /valid commit SHA shape/);
    assert.equal(folded.foldState.trustRoot.pinnedFacts.root_commit, OLD_ROOT);
  } finally {
    cleanup(key.dir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
