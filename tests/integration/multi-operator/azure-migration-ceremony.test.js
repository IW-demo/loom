"use strict";
/**
 * Shard 2b — Azure DevOps migration vertical (genesis-migration ceremony + fold).
 *
 * Covers the ADO genesis-migration MUST-7 N=1 org-admin path end-to-end:
 *   genesis-ceremony.js::performMigration (provider="azure-devops" dispatch
 *     → _runAdoMigration) → signed genesis-migration record (content.provider +
 *     co_sign_anchor_kind="ado_api_org_admin_capture" + ado_api_* captures)
 *   → fold-rule-9c.js::foldGenesisMigration (provider dispatch → _foldAdoN1OrgAdmin
 *     → accept + R6-S-06 latest-wins supersession).
 *
 * The load-bearing invariants under test:
 *   1. ADO migration anchors via the PCA org-admin attestation (role=admin +
 *      state=active) — the structural-equivalent anchor to GitHub's
 *      gh_api_org_membership_capture under N=1 (MUST-7).
 *   2. GitHub byte-identity at the migration surface: a github migration through
 *      the SAME (now provider-dispatching) performMigration emits NO
 *      content.provider field + NO ado_api_* captures (the #1 port invariant;
 *      f86/f88 are the broader regression lock).
 *   3. The fold dispatches on content.provider + the provider-consistent
 *      co_sign_anchor_kind discriminator; a cross-provider discriminator is a
 *      forgery and rejected.
 *   4. The ADO OWNER capture is validated by reading owner.login DIRECTLY (the
 *      ado owner allowlist is non-idempotent at fold time); the ORG-ADMIN
 *      capture is re-run through the idempotent _allowlistAdoOrgAdmin.
 *   5. Fold-time freshness (MIGRATION_LIVENESS_TTL) + owner-principal binding
 *      hold identically to the GitHub path.
 *
 * Tier-2: dependency-injected fakes for the ADO transport + git (per the
 * performMigration contract); REAL ephemeral SSH keys + REAL coc-sign
 * sign/verify (no signing mock). Every assertion is a STRUCTURAL probe per
 * rules/probe-driven-verification.md (exit code / record shape / typed-error
 * identity / fold boolean verdict — no regex over semantic prose).
 *
 * Per rules/orphan-detection.md MUST-1+2: this file IS the production wiring
 * test for genesis-ceremony.js::_runAdoMigration + fold-rule-9c.js
 * ::_foldAdoN1OrgAdmin.
 *
 * Run: node --test tests/integration/multi-operator/azure-migration-ceremony.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const CEREMONY = path.join(LIB_DIR, "genesis-ceremony.js");
const FOLD = path.join(LIB_DIR, "fold-rule-9c.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const GHAPI_ALLOWLIST = path.join(LIB_DIR, "gh-api-allowlist.js");

// ---------------------------------------------------------------------------
// Ephemeral SSH key fixture
// ---------------------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ado-migr-${label}-`));
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
    `ado-migr-test-${label}`,
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

// Re-sign a (mutated) record core with the owner key — for fold-level negative
// probes that must alter signed content without going through the ceremony.
function resign(record, ownerKey) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const { sig: _drop, ...core } = record;
  const bytes = canonicalSerialize(core);
  const s = sign(bytes, { keyType: "ssh", keyPath: ownerKey.keyPath });
  if (!s || !s.ok) throw new Error(`resign failed: ${s && s.reason}`);
  return Object.assign({}, core, { sig: s.sig });
}

// ---------------------------------------------------------------------------
// ADO transport mock — keyed on { service, path, meta }. overrides force a
// non-admin / non-active PCA determination.
// ---------------------------------------------------------------------------
function makeAdoApiMock(overrides) {
  const o = overrides || {};
  return function adoApi(req) {
    const { service, path: p, meta } = req || {};
    if (service === "core" && /\/_apis\/git\/repositories\//.test(p)) {
      if (/\/commits\//.test(p)) {
        const sha = p.split("/commits/")[1].split("?")[0];
        return {
          ok: true,
          status: 200,
          body: { commitId: sha, author: { name: "ado-author", date: "x" } },
        };
      }
      const repo = p.split("/_apis/git/repositories/")[1].split("?")[0];
      const project = p.split("/")[1];
      return {
        ok: true,
        status: 200,
        body: { id: "repo-guid", name: repo, project: { name: project } },
      };
    }
    if (service === "graph" && /admin-membership/.test(p)) {
      return {
        ok: true,
        status: 200,
        body: {
          role: o.role || "admin",
          state: o.state || "active",
          user: { login: meta.principal },
          organization: { login: meta.org },
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

// GitHub gh-api mock (for the byte-identity probe S10).
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
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

// ---------------------------------------------------------------------------
// Roster fixtures
// ---------------------------------------------------------------------------
function makeAdoOrgN1Roster(ownerKey, opts) {
  const o = opts || {};
  return {
    genesis: {
      provider: "azure-devops",
      repo_owner: o.org || "myorg",
      repo_owner_kind: "org",
      ado_project: o.project || "myproj",
      root_commit: o.root || "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-ado": {
        display_id: "owner",
        role: "owner",
        principal: o.principal || "alice@contoso.com",
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

function makeAdoOrgN2Roster(ownerKey, secondKey) {
  const r = makeAdoOrgN1Roster(ownerKey);
  r.persons["pid-owner-ado-b"] = {
    display_id: "bob",
    role: "owner",
    principal: "bob@contoso.com",
    host_role: "human",
    keys: [
      {
        type: "ssh",
        fingerprint: secondKey.fingerprint,
        pubkey: secondKey.pubKey,
      },
    ],
  };
  return r;
}

function makeGithubOrgN1Roster(ownerKey) {
  return {
    genesis: {
      repo_owner: "myorg",
      repo_owner_kind: "org",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-gh": {
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

// Common ADO migration invocation (owner-relocation, generation bump).
function runAdoMigration(ownerKey, roster, extra) {
  const { performMigration } = require(CEREMONY);
  const appended = [];
  const result = performMigration(
    Object.assign(
      {
        roster,
        repo: { repo: "coordrepo" },
        newRepo: { org: "neworg", project: "myproj", repo: "coordrepo" },
        signingKeyPath: ownerKey.keyPath,
        signingKeyFingerprint: ownerKey.fingerprint,
        keyType: "ssh",
        adoApi: makeAdoApiMock(extra && extra.adoOverrides),
        transportAppend: (rec) => {
          appended.push(rec);
          return { ok: true };
        },
        kind: "migration",
        fromGenesisGeneration: 0,
        toGenesisGeneration: 1,
      },
      (extra && extra.opts) || {},
    ),
  );
  return { result, appended };
}

// ===========================================================================
// S1 — ADO migration PASS: emits a fold-accepted genesis-migration record
// ===========================================================================
test("ado_migration_pass_emits_fold_accepted_record", () => {
  const { foldGenesisMigration, CO_SIGN_ANCHOR_KIND_ORG_ADMIN_ADO } = require(
    FOLD,
  );
  const ownerKey = mkEphemeralSshKey("s1");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result, appended } = runAdoMigration(ownerKey, roster);
    assert.equal(result.ok, true, `ceremony failed: ${JSON.stringify(result)}`);
    assert.equal(appended.length, 1);
    const rec = appended[0];
    const c = rec.content;
    assert.equal(rec.type, "genesis-migration");
    assert.equal(c.provider, "azure-devops");
    assert.equal(c.co_sign_anchor_kind, CO_SIGN_ANCHOR_KIND_ORG_ADMIN_ADO);
    assert.deepEqual(c.co_signers, []);
    assert.equal(c.new_repo_owner, "neworg");
    assert.equal(c.new_repo_owner_kind, "org");
    assert.ok(c.ado_api_owner_capture, "ado owner capture present");
    assert.ok(c.ado_api_org_admin_capture, "ado org-admin capture present");
    assert.equal(c.ado_api_org_admin_capture.role, "admin");
    assert.equal(c.ado_api_org_admin_capture.state, "active");
    // The ADO owner capture carries owner.login (the read-directly fold path).
    assert.equal(c.ado_api_owner_capture.owner.login, "neworg");
    // NO gh_api_* leakage on an ADO record.
    assert.equal(c.gh_api_owner_capture, undefined);
    assert.equal(c.gh_api_org_membership_capture, undefined);
    assert.deepEqual(rec, appended[0], "returned record == appended");

    const verdict = foldGenesisMigration(rec, { foldState: null, roster });
    assert.equal(verdict.accepted, true, `fold rejected: ${verdict.reason}`);
    assert.equal(verdict.foldState.trustRoot.verified_id, ownerKey.fingerprint);
    assert.equal(verdict.foldState.trustRoot.pinnedFacts.repo_owner, "neworg");
    assert.equal(verdict.foldState.genesis_generation, 1);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S2 — ADO re-anchor PASS: local+origin git verified, re-points trust root
// ===========================================================================
test("ado_reanchor_pass_repoints_trust_root", () => {
  const { performMigration } = require(CEREMONY);
  const { foldGenesisMigration } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s2");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const newRoot = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const git = makeGitMock({
      "rev-list --max-parents=0 HEAD": {
        ok: true,
        stdout: newRoot,
        stderr: "",
        status: 0,
      },
      "rev-list --max-parents=0 origin/main": {
        ok: true,
        stdout: newRoot,
        stderr: "",
        status: 0,
      },
    });
    const appended = [];
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "myorg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: (rec) => {
        appended.push(rec);
        return { ok: true };
      },
      kind: "re-anchor",
      newRootCommit: newRoot,
      preCorrectionRootCommit: "0000oldroot0000",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      git,
    });
    assert.equal(
      result.ok,
      true,
      `re-anchor failed: ${JSON.stringify(result)}`,
    );
    const c = appended[0].content;
    assert.equal(c.pre_correction_root_commit, "0000oldroot0000");
    assert.ok(c.ado_api_root_commit_capture, "root capture present");
    assert.equal(c.ado_api_root_commit_capture.sha, newRoot);
    // ADO never asserts a verified signature.
    assert.equal(
      c.ado_api_root_commit_capture.commit.verification.verified,
      false,
    );

    // Fold from a prior trust root → re-anchor re-points to the new sha.
    const priorState = {
      trustRoot: {
        verified_id: "prior",
        pinnedFacts: { root_commit: "0000oldroot0000" },
      },
    };
    const verdict = foldGenesisMigration(appended[0], {
      foldState: priorState,
      roster,
    });
    assert.equal(verdict.accepted, true, `fold rejected: ${verdict.reason}`);
    assert.equal(verdict.foldState.trustRoot.pinnedFacts.root_commit, newRoot);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S3 — fail-CLOSED when the PCA determination is not admin
// ===========================================================================
test("ado_migration_non_admin_fails_closed", () => {
  const ownerKey = mkEphemeralSshKey("s3");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result, appended } = runAdoMigration(ownerKey, roster, {
      adoOverrides: { role: "member" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "6-org-admin");
    assert.equal(appended.length, 0, "NO record emitted on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S4 — fail-CLOSED when the PCA attestation is not active
// ===========================================================================
test("ado_migration_inactive_attestation_fails_closed", () => {
  const ownerKey = mkEphemeralSshKey("s4");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result } = runAdoMigration(ownerKey, roster, {
      adoOverrides: { state: "pending" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "6-org-admin");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S5 — fold REJECTS when org-admin user principal != sole owner principal
// ===========================================================================
test("ado_fold_rejects_when_owner_principal_mismatch", () => {
  const { foldGenesisMigration } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s5");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result, appended } = runAdoMigration(ownerKey, roster);
    assert.equal(result.ok, true);
    // Fold the validly-signed record against a roster whose sole owner binds
    // to a DIFFERENT principal → binding (g) fails (signed bytes untouched).
    const otherRoster = makeAdoOrgN1Roster(ownerKey, {
      principal: "mallory@contoso.com",
    });
    const verdict = foldGenesisMigration(appended[0], {
      foldState: null,
      roster: otherRoster,
    });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /does not match sole owner's bound principal/);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S6 — fold REJECTS cross-provider discriminator forgery
// ===========================================================================
test("ado_fold_rejects_cross_provider_discriminator_forgery", () => {
  const { foldGenesisMigration, CO_SIGN_ANCHOR_KIND_ORG_ADMIN } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s6");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result, appended } = runAdoMigration(ownerKey, roster);
    assert.equal(result.ok, true);
    // Swap the ADO discriminator for the GitHub one, re-sign (so the signature
    // is valid over the forged content), fold → provider/discriminator mismatch.
    const forged = JSON.parse(JSON.stringify(appended[0]));
    forged.content.co_sign_anchor_kind = CO_SIGN_ANCHOR_KIND_ORG_ADMIN;
    const signed = resign(forged, ownerKey);
    const verdict = foldGenesisMigration(signed, { foldState: null, roster });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /inconsistent with content\.provider/);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S7 — fold REJECTS stale ADO org-admin capture (fold-time freshness)
// ===========================================================================
test("ado_fold_rejects_stale_capture", () => {
  const { performMigration } = require(CEREMONY);
  const { foldGenesisMigration } = require(FOLD);
  const { MIGRATION_LIVENESS_TTL } = require(GHAPI_ALLOWLIST);
  const ownerKey = mkEphemeralSshKey("s7");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const recordTs = new Date("2026-06-03T12:00:00Z");
    const staleTs = new Date(
      recordTs.getTime() - MIGRATION_LIVENESS_TTL - 60 * 1000,
    );
    // now() call order in _runAdoMigration (migration kind):
    //   1. Step 5 owner capture, 2. Step 6 org-admin capture, 3. record.ts
    const nowSeq = [
      staleTs.toISOString(),
      staleTs.toISOString(),
      recordTs.toISOString(),
    ];
    let i = 0;
    const nowFake = () => nowSeq[Math.min(i++, nowSeq.length - 1)];
    const appended = [];
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "neworg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: (rec) => {
        appended.push(rec);
        return { ok: true };
      },
      kind: "migration",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      now: nowFake,
    });
    assert.equal(result.ok, true, "helper does not enforce freshness");
    const verdict = foldGenesisMigration(appended[0], {
      foldState: null,
      roster,
    });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /stale|freshness/i);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S8 — user-owned N=1 ADO blocked (typed error, no adoApi call)
// ===========================================================================
test("ado_migration_user_owned_n1_blocked", () => {
  const { performMigration, ERR_USER_OWNED_N1_BLOCKED } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("s8");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    roster.genesis.repo_owner_kind = "user";
    let adoCalled = false;
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "neworg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: () => {
        adoCalled = true;
        return { ok: false };
      },
      transportAppend: () => ({ ok: true }),
      kind: "migration",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "2-route");
    assert.equal(result.reason, ERR_USER_OWNED_N1_BLOCKED);
    assert.equal(
      adoCalled,
      false,
      "no network call before the structural block",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S9 — ghes-shared-appliance host blocked
// ===========================================================================
test("ado_migration_ghes_shared_appliance_blocked", () => {
  const { performMigration, ERR_GHES_SHARED_APPLIANCE_BLOCKED } = require(
    CEREMONY,
  );
  const ownerKey = mkEphemeralSshKey("s9");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result } = runAdoMigration(ownerKey, roster, {
      opts: { host: "ghes-shared-appliance" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "2-route");
    assert.equal(result.reason, ERR_GHES_SHARED_APPLIANCE_BLOCKED);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S10 — GitHub byte-identity: github migration emits NO provider field
// ===========================================================================
test("github_migration_unchanged_no_provider_field", () => {
  const { performMigration } = require(CEREMONY);
  const { foldGenesisMigration } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s10");
  try {
    const roster = makeGithubOrgN1Roster(ownerKey);
    const appended = [];
    const result = performMigration({
      roster,
      repo: { owner: "myorg", name: "kailash" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      ghApi: makeGhApiMock(),
      transportAppend: (rec) => {
        appended.push(rec);
        return { ok: true };
      },
      kind: "migration",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
    });
    assert.equal(result.ok, true, `github migration failed: ${result.reason}`);
    const c = appended[0].content;
    // The #1 port invariant at the migration surface.
    assert.equal(c.provider, undefined, "github record MUST NOT set provider");
    assert.ok(c.gh_api_org_membership_capture, "gh org capture present");
    assert.ok(c.gh_api_owner_capture, "gh owner capture present");
    assert.equal(c.ado_api_owner_capture, undefined);
    assert.equal(c.ado_api_org_admin_capture, undefined);
    const verdict = foldGenesisMigration(appended[0], {
      foldState: null,
      roster,
    });
    assert.equal(
      verdict.accepted,
      true,
      `github fold rejected: ${verdict.reason}`,
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S11 — idempotency trap: fold REQUIRES ado_api_owner_capture.owner.login
//        (read-directly; the ado owner allowlist is NOT re-run at fold)
// ===========================================================================
test("ado_fold_requires_owner_login_directly_no_allowlist_rederive", () => {
  const { foldGenesisMigration } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s11");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result, appended } = runAdoMigration(ownerKey, roster);
    assert.equal(result.ok, true);
    // Strip owner.login from the (signed) owner capture, re-sign, fold.
    // If the fold re-derived via the non-idempotent _allowlistAdoRepoOwner it
    // would either crash or null owner.login anyway; the direct-read path
    // rejects with an explicit "NOT re-deriving" message.
    const mutated = JSON.parse(JSON.stringify(appended[0]));
    delete mutated.content.ado_api_owner_capture.owner.login;
    const signed = resign(mutated, ownerKey);
    const verdict = foldGenesisMigration(signed, { foldState: null, roster });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /owner\.login missing|NOT re-deriving/);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S12 — chain-continuation: migration seq stamps off the emitter chain head
// ===========================================================================
test("ado_migration_chain_continues_off_head", () => {
  const { performMigration } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("s12");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const appended = [];
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "neworg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: (rec) => {
        appended.push(rec);
        return { ok: true };
      },
      kind: "migration",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      readChainHead: () => ({ lastSeq: 5, lastContentHash: "headhash123" }),
    });
    assert.equal(result.ok, true, `ceremony failed: ${result.reason}`);
    assert.equal(appended[0].seq, 6, "seq continues off head (5+1)");
    assert.equal(appended[0].prev_hash, "headhash123");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S13 — sock-puppet N=2 ADO roster: N=1 helper rejects (sole-owner gate)
// ===========================================================================
test("ado_migration_n2_roster_rejected_by_sole_owner_gate", () => {
  const { performMigration } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("s13a");
  const secondKey = mkEphemeralSshKey("s13b");
  try {
    const roster = makeAdoOrgN2Roster(ownerKey, secondKey);
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "neworg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: () => ({ ok: true }),
      kind: "migration",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "3-sole-owner");
  } finally {
    cleanup(ownerKey.dir);
    cleanup(secondKey.dir);
  }
});

// ===========================================================================
// S14 — fold REJECTS an ADO N=1 record with populated co_signers (malformed)
// ===========================================================================
test("ado_fold_rejects_populated_co_signers_with_discriminator", () => {
  const { foldGenesisMigration } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s14");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const { result, appended } = runAdoMigration(ownerKey, roster);
    assert.equal(result.ok, true);
    const mutated = JSON.parse(JSON.stringify(appended[0]));
    mutated.content.co_signers = [{ verified_id: "x", sig: "y" }];
    const signed = resign(mutated, ownerKey);
    const verdict = foldGenesisMigration(signed, { foldState: null, roster });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /co_signers === \[\]|empty array/);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S15 — fold REJECTS an ADO re-anchor whose root capture .sha is malformed
//        (provider-aware rootCaptureField resolves to ado_api_root_commit_capture;
//        the shared ^[0-9a-f]{7,64}$ shape guard fires on the ADO branch)
// ===========================================================================
test("ado_reanchor_rejects_non_hex_sha_shape", () => {
  const { performMigration } = require(CEREMONY);
  const { foldGenesisMigration } = require(FOLD);
  const ownerKey = mkEphemeralSshKey("s15");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const newRoot = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const git = makeGitMock({
      "rev-list --max-parents=0 HEAD": {
        ok: true,
        stdout: newRoot,
        stderr: "",
        status: 0,
      },
      "rev-list --max-parents=0 origin/main": {
        ok: true,
        stdout: newRoot,
        stderr: "",
        status: 0,
      },
    });
    const appended = [];
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "myorg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: (rec) => {
        appended.push(rec);
        return { ok: true };
      },
      kind: "re-anchor",
      newRootCommit: newRoot,
      preCorrectionRootCommit: "0000oldroot0000",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      git,
    });
    assert.equal(
      result.ok,
      true,
      `re-anchor ceremony failed: ${result.reason}`,
    );
    // Corrupt the ADO root capture sha to a non-hex value, re-sign, fold.
    const mutated = JSON.parse(JSON.stringify(appended[0]));
    mutated.content.ado_api_root_commit_capture.sha = "not-a-valid-sha!!";
    const signed = resign(mutated, ownerKey);
    const verdict = foldGenesisMigration(signed, { foldState: null, roster });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /valid commit SHA shape/);
    // The provider-aware reason names the ADO field, not the gh field.
    assert.match(verdict.reason, /ado_api_root_commit_capture/);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// S16 — fold REJECTS a STALE ADO re-anchor root capture, and the rejection
//        names the ADO field (closes the test gap that hid the line-999
//        hardcoded-gh-field miss; cc-architect R1 LOW).
// ===========================================================================
test("ado_reanchor_rejects_stale_root_capture_names_ado_field", () => {
  const { performMigration } = require(CEREMONY);
  const { foldGenesisMigration } = require(FOLD);
  const { MIGRATION_LIVENESS_TTL } = require(GHAPI_ALLOWLIST);
  const ownerKey = mkEphemeralSshKey("s16");
  try {
    const roster = makeAdoOrgN1Roster(ownerKey);
    const newRoot = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const git = makeGitMock({
      "rev-list --max-parents=0 HEAD": {
        ok: true,
        stdout: newRoot,
        stderr: "",
        status: 0,
      },
      "rev-list --max-parents=0 origin/main": {
        ok: true,
        stdout: newRoot,
        stderr: "",
        status: 0,
      },
    });
    const recordTs = new Date("2026-06-03T12:00:00Z");
    const staleTs = new Date(
      recordTs.getTime() - MIGRATION_LIVENESS_TTL - 60 * 1000,
    );
    // now() order in _runAdoMigration (re-anchor kind):
    //   1. owner capture, 2. org-admin capture, 3. root-commit capture, 4. record.ts
    // Make ONLY the root capture stale (owner+org fresh) so the rejection MUST
    // come from the root-freshness guard (line 999), not a sibling.
    const nowSeq = [
      recordTs.toISOString(),
      recordTs.toISOString(),
      staleTs.toISOString(),
      recordTs.toISOString(),
    ];
    let i = 0;
    const nowFake = () => nowSeq[Math.min(i++, nowSeq.length - 1)];
    const appended = [];
    const result = performMigration({
      roster,
      repo: { repo: "coordrepo" },
      newRepo: { org: "myorg", project: "myproj", repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: (rec) => {
        appended.push(rec);
        return { ok: true };
      },
      kind: "re-anchor",
      newRootCommit: newRoot,
      preCorrectionRootCommit: "0000oldroot0000",
      fromGenesisGeneration: 0,
      toGenesisGeneration: 1,
      git,
      now: nowFake,
    });
    assert.equal(result.ok, true, "helper does not enforce freshness");
    const verdict = foldGenesisMigration(appended[0], {
      foldState: null,
      roster,
    });
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /stale/i);
    // Provider-aware: names the ADO field, NOT gh_api_root_commit_capture.
    assert.match(verdict.reason, /ado_api_root_commit_capture/);
    assert.doesNotMatch(verdict.reason, /gh_api_root_commit_capture/);
  } finally {
    cleanup(ownerKey.dir);
  }
});
