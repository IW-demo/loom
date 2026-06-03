"use strict";
/**
 * Shard 2a — Azure DevOps enrollment vertical (genesis ceremony + fold).
 *
 * Covers the ADO genesis-anchor ENROLLMENT path end-to-end:
 *   genesis-ceremony.js::runEnrollmentCeremony (provider="azure-devops")
 *     → signed genesis-anchor record (content.provider + ado_api_* captures)
 *     → fold-genesis-anchor.js::foldGenesisAnchor (provider dispatch → accept)
 * plus the roster-schema-validate.js provider-conditional identity binding
 * (github_login vs principal).
 *
 * The load-bearing invariants under test:
 *   1. ADO enrollment anchors via the org-admin (PCA) attestation — verified
 *      is ALWAYS false; the role==="admin"+state==="active" attestation is the
 *      verified-identity anchor (issue #358 org-bootstrap relaxation,
 *      generalized to the provider).
 *   2. GitHub byte-identity: a github enrollment through the SAME (refactored)
 *      ceremony emits a record with NO content.provider field + gh_api_*
 *      captures (the #1 port invariant; genesis-anchor.test.js is the broader
 *      regression lock, this file pins the focused property).
 *   3. The fold dispatches on content.provider and owner-binds an ADO anchor
 *      via `principal` against ado_api_org_admin_capture.
 *
 * Tier-2: dependency-injected fakes for the API transport (per the
 * runEnrollmentCeremony contract); REAL ephemeral SSH keys + REAL
 * coc-sign.sign/verify (no signing mock). Every assertion is a STRUCTURAL
 * probe per rules/probe-driven-verification.md.
 *
 * Run: node --test tests/integration/multi-operator/azure-enrollment-ceremony.test.js
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
const FOLD_ANCHOR = path.join(LIB_DIR, "fold-genesis-anchor.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const VALIDATE = path.join(LIB_DIR, "roster-schema-validate.js");

// ---------------------------------------------------------------------------
// Ephemeral SSH key fixture (parity with f86 / genesis-anchor tests)
// ---------------------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ado-enroll-${label}-`));
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
    `ado-enroll-test-${label}`,
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

// ---------------------------------------------------------------------------
// ADO transport mock — keyed on { service, path, meta }.
//   core  : repos/{repo} existence; commits/{sha} capture
//   graph : admin-membership (PCA determination); members list
// overrides let a test force a non-admin / non-active determination.
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
    if (service === "graph" && /members/.test(p)) {
      return { ok: true, status: 200, body: o.members || [] };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

// ---------------------------------------------------------------------------
// Roster fixtures
// ---------------------------------------------------------------------------
function makeAdoRoster(ownerKey, opts) {
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

function makeGithubRoster(ownerKey) {
  return {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
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

function makeGhApiMock() {
  return function ghApi(endpoint) {
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      const owner = endpoint.split("/")[1];
      return { ok: true, status: 200, body: { owner: { login: owner } } };
    }
    if (/^repos\/[^/]+\/[^/]+\/commits\/[a-f0-9]+$/.test(endpoint)) {
      const sha = endpoint.split("/").pop();
      return {
        ok: true,
        status: 200,
        body: {
          sha,
          commit: {
            author: { name: "alice" },
            verification: { verified: true, reason: "valid" },
          },
          author: { login: "alice" },
        },
      };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

// ===========================================================================
// 1. ADO enrollment PASS — emits a fold-accepted ADO genesis-anchor record
// ===========================================================================
test("ado_enrollment_pass_emits_fold_accepted_record", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const { foldGenesisAnchor } = require(FOLD_ANCHOR);
  const { verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("pass");
  try {
    const roster = makeAdoRoster(ownerKey);
    let appended = null;
    const result = runEnrollmentCeremony({
      roster,
      repo: { repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: (rec) => {
        appended = rec;
        return { ok: true };
      },
    });
    assert.equal(result.ok, true, `ceremony failed: ${JSON.stringify(result)}`);

    // --- record shape: provider discriminator + ado_api_* captures ---
    const c = result.record.content;
    assert.equal(c.provider, "azure-devops");
    assert.ok(c.ado_api_owner_capture, "owner capture present");
    assert.ok(c.ado_api_org_admin_capture, "org-admin capture present");
    assert.ok(c.ado_api_root_commit_capture, "root-commit capture present");
    // ADO never asserts a verified signature — the anchor is the attestation.
    assert.equal(
      c.ado_api_root_commit_capture.commit.verification.verified,
      false,
    );
    assert.equal(c.ado_api_org_admin_capture.role, "admin");
    assert.equal(c.ado_api_org_admin_capture.state, "active");
    // NO gh_api_* leakage on an ADO record.
    assert.equal(c.gh_api_owner_capture, undefined);
    assert.equal(c.gh_api_org_membership_capture, undefined);
    assert.deepEqual(result.record, appended, "appended record == returned");

    // --- fold accepts it (provider dispatch → principal owner-bind) ---
    const fold = foldGenesisAnchor(
      result.record,
      { trustRoot: null },
      roster,
      verify,
    );
    assert.equal(fold.accepted, true, `fold rejected: ${fold.reason}`);
    assert.notEqual(fold.foldState.trustRoot, null);
    assert.equal(
      fold.foldState.trustRoot.verified_id,
      ownerKey.fingerprint,
      "trust-root signer is the ADO owner key",
    );
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// 2. ADO enrollment fail-CLOSED when the PCA determination is not admin
// ===========================================================================
test("ado_enrollment_non_admin_fails_closed_no_record", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("nonadmin");
  try {
    const roster = makeAdoRoster(ownerKey);
    let appended = null;
    const result = runEnrollmentCeremony({
      roster,
      repo: { repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock({ role: "member" }),
      transportAppend: (rec) => {
        appended = rec;
        return { ok: true };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "3-org-admin");
    assert.equal(appended, null, "NO record emitted on fail-closed");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// 3. ADO enrollment fail-CLOSED when the PCA attestation is not active
// ===========================================================================
test("ado_enrollment_inactive_attestation_fails_closed", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const ownerKey = mkEphemeralSshKey("inactive");
  try {
    const roster = makeAdoRoster(ownerKey);
    const result = runEnrollmentCeremony({
      roster,
      repo: { repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock({ state: "pending" }),
      transportAppend: () => ({ ok: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "3-org-admin");
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// 4. ADO fold REJECTS when the roster owner principal != attestation UPN
// ===========================================================================
test("ado_fold_rejects_when_owner_principal_mismatch", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const { foldGenesisAnchor } = require(FOLD_ANCHOR);
  const { verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("mismatch");
  try {
    const roster = makeAdoRoster(ownerKey);
    const result = runEnrollmentCeremony({
      roster,
      repo: { repo: "coordrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeAdoApiMock(),
      transportAppend: () => ({ ok: true }),
    });
    assert.equal(result.ok, true);

    // Fold the validly-signed record against a roster whose owner binds to a
    // DIFFERENT principal → owner-bind fails (the signed bytes are untouched).
    const otherRoster = makeAdoRoster(ownerKey, {
      principal: "mallory@contoso.com",
    });
    const fold = foldGenesisAnchor(
      result.record,
      { trustRoot: null },
      otherRoster,
      verify,
    );
    assert.equal(fold.accepted, false);
    assert.match(fold.reason, /not owner-bound/);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// 5. GitHub byte-identity: github enrollment emits NO provider field
// ===========================================================================
test("github_enrollment_unchanged_no_provider_field", () => {
  const { runEnrollmentCeremony } = require(CEREMONY);
  const { foldGenesisAnchor } = require(FOLD_ANCHOR);
  const { verify } = require(COC_SIGN);
  const ownerKey = mkEphemeralSshKey("gh");
  try {
    const roster = makeGithubRoster(ownerKey);
    const result = runEnrollmentCeremony({
      roster,
      repo: { owner: "alice", name: "myrepo" },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      ghApi: makeGhApiMock(),
      transportAppend: () => ({ ok: true }),
    });
    assert.equal(result.ok, true, `github ceremony failed: ${result.reason}`);
    const c = result.record.content;
    // The #1 port invariant: github records carry NO provider field + gh_api_*.
    assert.equal(c.provider, undefined, "github record MUST NOT set provider");
    assert.ok(c.gh_api_owner_capture, "gh_api owner capture present");
    assert.ok(
      c.gh_api_root_commit_capture,
      "gh_api root-commit capture present",
    );
    assert.equal(c.ado_api_owner_capture, undefined);
    // And it still folds accepted through the (now provider-dispatching) fold.
    const fold = foldGenesisAnchor(
      result.record,
      { trustRoot: null },
      roster,
      verify,
    );
    assert.equal(fold.accepted, true, `github fold rejected: ${fold.reason}`);
  } finally {
    cleanup(ownerKey.dir);
  }
});

// ===========================================================================
// 6. Roster validator — provider-conditional identity binding
// ===========================================================================
test("validator_ado_roster_with_principal_is_valid", () => {
  const { validate } = require(VALIDATE);
  const roster = {
    genesis: {
      provider: "azure-devops",
      repo_owner: "myorg",
      repo_owner_kind: "org",
      ado_project: "myproj",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-a": {
        display_id: "alice",
        role: "owner",
        principal: "alice@contoso.com",
        host_role: "human",
        keys: [
          { type: "ssh", fingerprint: "SHA256:AAAA", pubkey: "ssh-x AAAA" },
        ],
      },
    },
  };
  const r = validate(roster);
  assert.equal(r.valid, true, `expected valid; errors: ${r.errors.join("; ")}`);
});

test("validator_ado_roster_missing_principal_is_invalid", () => {
  const { validate } = require(VALIDATE);
  const roster = {
    genesis: {
      provider: "azure-devops",
      repo_owner: "myorg",
      repo_owner_kind: "org",
      ado_project: "myproj",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-a": {
        display_id: "alice",
        role: "owner",
        host_role: "human",
        keys: [
          { type: "ssh", fingerprint: "SHA256:AAAA", pubkey: "ssh-x AAAA" },
        ],
      },
    },
  };
  const r = validate(roster);
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some((e) => /principal: required/.test(e)),
    `expected a principal-required error; got ${r.errors.join("; ")}`,
  );
});

test("validator_ado_roster_missing_ado_project_is_invalid", () => {
  const { validate } = require(VALIDATE);
  const roster = {
    genesis: {
      provider: "azure-devops",
      repo_owner: "myorg",
      repo_owner_kind: "org",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-a": {
        display_id: "alice",
        role: "owner",
        principal: "alice@contoso.com",
        host_role: "human",
        keys: [
          { type: "ssh", fingerprint: "SHA256:AAAA", pubkey: "ssh-x AAAA" },
        ],
      },
    },
  };
  const r = validate(roster);
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some((e) => /ado_project: required/.test(e)),
    `expected an ado_project-required error; got ${r.errors.join("; ")}`,
  );
});

test("validator_github_roster_missing_github_login_is_invalid", () => {
  const { validate } = require(VALIDATE);
  const roster = {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-a": {
        display_id: "alice",
        role: "owner",
        host_role: "human",
        keys: [
          { type: "ssh", fingerprint: "SHA256:AAAA", pubkey: "ssh-x AAAA" },
        ],
      },
    },
  };
  const r = validate(roster);
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some((e) => /github_login: required/.test(e)),
    `expected a github_login-required error; got ${r.errors.join("; ")}`,
  );
});

test("validator_github_roster_with_login_still_valid", () => {
  const { validate } = require(VALIDATE);
  const roster = {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-a": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [
          { type: "ssh", fingerprint: "SHA256:AAAA", pubkey: "ssh-x AAAA" },
        ],
      },
    },
  };
  const r = validate(roster);
  assert.equal(r.valid, true, `expected valid; errors: ${r.errors.join("; ")}`);
});
