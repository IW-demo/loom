"use strict";
/**
 * Shard 1 — VCS provider-adapter foundation tests (Azure DevOps port).
 *
 * Covers the NEW provider-abstraction layer in isolation (no ceremony, no
 * fold): ado-login.js, ado-api-allowlist.js, vcs-github-adapter.js,
 * vcs-azure-adapter.js, vcs-provider.js.
 *
 * The load-bearing invariant under test (the whole port hangs off it):
 *   the GitHub adapter is BEHAVIOR-IDENTICAL to the prior inline gh-api code,
 *   AND the Azure adapter emits the IDENTICAL canonical capture inner shape
 *   from ADO responses — so the provider-neutral fold predicates consume one
 *   shape below the content.provider dispatch point.
 *
 * Per rules/probe-driven-verification.md: every assertion is a STRUCTURAL
 * probe (return-shape fields, deep-equality of capture shapes, exit shapes) —
 * no regex over prose.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const adoLogin = require("../../../.claude/hooks/lib/ado-login.js");
const adoAllow = require("../../../.claude/hooks/lib/ado-api-allowlist.js");
const ghAllow = require("../../../.claude/hooks/lib/gh-api-allowlist.js");
const ghAdapter = require("../../../.claude/hooks/lib/vcs-github-adapter.js");
const azAdapter = require("../../../.claude/hooks/lib/vcs-azure-adapter.js");
const vcs = require("../../../.claude/hooks/lib/vcs-provider.js");

const TS = "2026-06-02T12:00:00.000Z";

// ---------------------------------------------------------------------------
// ado-login.js
// ---------------------------------------------------------------------------

test("ado-login: valid Entra UPN passes", () => {
  assert.equal(adoLogin.validatePrincipal("alice@contoso.com").valid, true);
  assert.equal(
    adoLogin.validatePrincipal("a.b-c_d+e@sub.contoso.co.uk").valid,
    true,
  );
});

test("ado-login: non-UPN principals rejected", () => {
  for (const bad of ["alice", "alice@", "@contoso.com", "alice@contoso", ""]) {
    assert.equal(
      adoLogin.validatePrincipal(bad).valid,
      false,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  assert.equal(adoLogin.validatePrincipal(123).valid, false);
});

test("ado-login: principalsEqual is case-insensitive (sock-puppet defense)", () => {
  assert.equal(
    adoLogin.principalsEqual("Alice@Contoso.com", "alice@contoso.com"),
    true,
  );
  assert.equal(
    adoLogin.principalsEqual("alice@contoso.com", "bob@contoso.com"),
    false,
  );
});

test("ado-login: non-ASCII principal normalizes to null (Turkish-I defense)", () => {
  // "İ" (dotted capital I, U+0130) must NOT case-fold-match an ASCII login.
  assert.equal(adoLogin.normalizePrincipal("İ@contoso.com"), null);
  assert.equal(
    adoLogin.principalsEqual("İ@contoso.com", "i@contoso.com"),
    false,
  );
  assert.equal(adoLogin.normalizePrincipal(""), null);
  assert.equal(adoLogin.normalizePrincipal(42), null);
});

test("ado-login: org/project/repo endpoint-injection rejection", () => {
  assert.equal(adoLogin.validateAdoOrg("my-org").valid, true);
  assert.equal(adoLogin.validateAdoOrg("../evil").valid, false);
  assert.equal(adoLogin.validateAdoOrg("org/sub").valid, false);
  assert.equal(adoLogin.validateAdoProject("Proj_1").valid, true);
  assert.equal(adoLogin.validateAdoProject("proj space").valid, false);
  assert.equal(adoLogin.validateAdoProject("a/b").valid, false);
  assert.equal(adoLogin.validateAdoRepo("repo.git").valid, true);
  assert.equal(adoLogin.validateAdoRepo("repo;rm -rf").valid, false);
});

// ---------------------------------------------------------------------------
// ado-api-allowlist.js — canonical shape parity
// ---------------------------------------------------------------------------

test("ado allowlist: repo-owner capture has the canonical owner.login/name/full_name/capture_ts shape", () => {
  const cap = adoAllow._allowlistAdoRepoOwner(
    { name: "myrepo", project: { name: "myproj" }, extra: "dropped" },
    { org: "myorg", capture_ts: TS },
  );
  assert.deepEqual(cap, {
    owner: { login: "myorg" },
    name: "myrepo",
    full_name: "myorg/myproj/myrepo",
    capture_ts: TS,
  });
  // Structural parity with the GitHub owner capture's key set.
  const gh = ghAllow._allowlistRepoOwner(
    {
      owner: { login: "myorg", type: "Organization" },
      name: "myrepo",
      full_name: "myorg/myrepo",
    },
    { capture_ts: TS },
  );
  assert.deepEqual(
    Object.keys(cap).sort(),
    Object.keys(gh).sort(),
    "ADO owner capture key set must match GitHub owner capture key set",
  );
});

test("ado allowlist: org-admin capture matches gh org-membership canonical shape", () => {
  const cap = adoAllow._allowlistAdoOrgAdmin(
    {
      role: "admin",
      state: "active",
      user: { login: "alice@contoso.com" },
      organization: { login: "myorg" },
    },
    { capture_ts: TS },
  );
  assert.deepEqual(cap, {
    role: "admin",
    state: "active",
    user: { login: "alice@contoso.com" },
    organization: { login: "myorg" },
    capture_ts: TS,
  });
  const gh = ghAllow._allowlistOrgMembership(
    {
      role: "admin",
      state: "active",
      user: { login: "alice" },
      organization: { login: "myorg" },
    },
    { capture_ts: TS },
  );
  assert.deepEqual(Object.keys(cap).sort(), Object.keys(gh).sort());
});

test("ado allowlist: commit capture records verified:false + explicit reason (no API signature verification)", () => {
  const cap = adoAllow._allowlistAdoCommitVerification(
    {
      commitId: "abc1234",
      author: { name: "Alice", email: "a@x.com", date: "..." },
    },
    { capture_ts: TS },
  );
  assert.equal(cap.sha, "abc1234");
  assert.equal(cap.commit.verification.verified, false);
  assert.equal(
    cap.commit.verification.reason,
    adoAllow.ADO_COMMIT_UNVERIFIED_REASON,
  );
  assert.equal(cap.author, null);
  assert.equal(cap.capture_ts, TS);
});

test("ado allowlist: members capture reuses the collaborators/{permissions.admin} shape", () => {
  const cap = adoAllow._allowlistAdoMembers(
    [
      { login: "alice@contoso.com", isAdmin: true },
      { login: "bob@contoso.com", isAdmin: false },
    ],
    { capture_ts: TS },
  );
  assert.equal(cap.capture_ts, TS);
  assert.equal(cap.collaborators.length, 2);
  assert.deepEqual(cap.collaborators[0].permissions, {
    admin: true,
    push: true,
  });
  assert.deepEqual(cap.collaborators[1].permissions, {
    admin: false,
    push: false,
  });
});

test("ado allowlist: distinct-bound-members enforces distinctness + admin + case-insensitivity", () => {
  const cap = adoAllow._allowlistAdoMembers(
    [
      { login: "alice@contoso.com", isAdmin: true },
      { login: "bob@contoso.com", isAdmin: true },
      { login: "carol@contoso.com", isAdmin: false },
    ],
    { capture_ts: TS },
  );
  // distinct admins, case-insensitive match → ok
  assert.equal(
    adoAllow._verifyDistinctBoundMembers(
      "Alice@contoso.com",
      "bob@contoso.com",
      cap,
    ).ok,
    true,
  );
  // same principal (case variant) → sock-puppet reject
  assert.equal(
    adoAllow._verifyDistinctBoundMembers(
      "alice@contoso.com",
      "ALICE@contoso.com",
      cap,
    ).ok,
    false,
  );
  // non-admin cosigner → reject
  assert.equal(
    adoAllow._verifyDistinctBoundMembers(
      "alice@contoso.com",
      "carol@contoso.com",
      cap,
    ).ok,
    false,
  );
  // absent principal → reject
  assert.equal(
    adoAllow._verifyDistinctBoundMembers(
      "alice@contoso.com",
      "dave@contoso.com",
      cap,
    ).ok,
    false,
  );
});

test("ado allowlist: re-exports the PROVIDER-NEUTRAL freshness surface (same identity as gh-api-allowlist)", () => {
  assert.equal(adoAllow._isCaptureFresh, ghAllow._isCaptureFresh);
  assert.equal(adoAllow.MIGRATION_LIVENESS_TTL, ghAllow.MIGRATION_LIVENESS_TTL);
  assert.equal(
    adoAllow.GH_API_CAPTURE_FRESHNESS_MS,
    ghAllow.GH_API_CAPTURE_FRESHNESS_MS,
  );
});

// ---------------------------------------------------------------------------
// vcs-provider.js registry
// ---------------------------------------------------------------------------

test("vcs-provider: getProvider default + known + unknown", () => {
  assert.equal(vcs.getProvider().provider, ghAdapter); // default github
  assert.equal(vcs.getProvider("github").provider, ghAdapter);
  assert.equal(vcs.getProvider("azure-devops").provider, azAdapter);
  const bad = vcs.getProvider("gitlab");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown provider/);
});

test("vcs-provider: getProviderForRoster (absent ⇒ github) + getProviderForRecordContent", () => {
  assert.equal(vcs.getProviderForRoster({ genesis: {} }).provider, ghAdapter);
  assert.equal(
    vcs.getProviderForRoster({ genesis: { provider: "azure-devops" } })
      .provider,
    azAdapter,
  );
  assert.equal(vcs.getProviderForRecordContent({}).provider, ghAdapter);
  assert.equal(
    vcs.getProviderForRecordContent({ provider: "azure-devops" }).provider,
    azAdapter,
  );
});

// ---------------------------------------------------------------------------
// vcs-github-adapter.js — behavior-identical wrapper
// ---------------------------------------------------------------------------

function ghTransport(map) {
  return (endpoint) => {
    if (!(endpoint in map))
      throw new Error(`unexpected gh endpoint: ${endpoint}`);
    return map[endpoint];
  };
}

test("github adapter: fetchRepoOwner returns canonical capture identical to inline gh-api-allowlist", () => {
  const body = {
    owner: { login: "octo", type: "User" },
    name: "repo",
    full_name: "octo/repo",
  };
  const t = ghTransport({ "repos/octo/repo": { ok: true, status: 200, body } });
  const r = ghAdapter.fetchRepoOwner(
    t,
    { owner: "octo", name: "repo" },
    { capture_ts: TS },
  );
  assert.equal(r.ok, true);
  assert.equal(r.ownerPrincipal, "octo");
  assert.deepEqual(
    r.capture,
    ghAllow._allowlistRepoOwner(body, { capture_ts: TS }),
  );
});

test("github adapter: fetchOrgAdmin + fetchCommitVerification + listCollaborators surface canonical fields", () => {
  const orgBody = {
    role: "admin",
    state: "active",
    user: { login: "octo" },
    organization: { login: "acme" },
  };
  const commitBody = {
    sha: "deadbee",
    commit: {
      author: { name: "Octo" },
      verification: { verified: true, reason: "valid" },
    },
    author: { login: "octo" },
  };
  const collabBody = [
    { login: "octo", type: "User", permissions: { admin: true, push: true } },
  ];
  const t = ghTransport({
    "orgs/acme/memberships/octo": { ok: true, status: 200, body: orgBody },
    "repos/acme/repo/commits/deadbee": {
      ok: true,
      status: 200,
      body: commitBody,
    },
    "repos/acme/repo/collaborators": {
      ok: true,
      status: 200,
      body: collabBody,
    },
  });
  const ref = { owner: "acme", name: "repo" };
  const a = ghAdapter.fetchOrgAdmin(t, ref, "octo", { capture_ts: TS });
  assert.equal(a.role, "admin");
  assert.equal(a.state, "active");
  const c = ghAdapter.fetchCommitVerification(t, ref, "deadbee", {
    capture_ts: TS,
  });
  assert.equal(c.verified, true);
  assert.equal(c.authorPrincipal, "octo");
  const l = ghAdapter.listCollaborators(t, ref, { capture_ts: TS });
  assert.equal(l.ok, true);
  assert.equal(l.capture.collaborators.length, 1);
});

test("github adapter: transport failure surfaces {ok:false} (fail-closed, not throw)", () => {
  const t = ghTransport({
    "repos/octo/repo": {
      ok: false,
      status: 404,
      body: { message: "Not Found" },
    },
  });
  const r = ghAdapter.fetchRepoOwner(t, { owner: "octo", name: "repo" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// vcs-azure-adapter.js
// ---------------------------------------------------------------------------

function adoTransport(handler) {
  return (req) => handler(req);
}

const ADO_REF = { org: "myorg", project: "myproj", repo: "myrepo" };

test("azure adapter: fetchRepoOwner confirms existence under auth-scoped org → owner.login = org", () => {
  const t = adoTransport((req) => {
    assert.equal(req.service, "core");
    assert.match(req.path, /git\/repositories\/myrepo/);
    return {
      ok: true,
      status: 200,
      body: { id: "guid", name: "myrepo", project: { name: "myproj" } },
    };
  });
  const r = azAdapter.fetchRepoOwner(t, ADO_REF, { capture_ts: TS });
  assert.equal(r.ok, true);
  assert.equal(r.ownerPrincipal, "myorg");
  assert.deepEqual(r.capture, {
    owner: { login: "myorg" },
    name: "myrepo",
    full_name: "myorg/myproj/myrepo",
    capture_ts: TS,
  });
});

test("azure adapter: fetchOrgAdmin consumes the determination shape from the graph transport", () => {
  const t = adoTransport((req) => {
    assert.equal(req.service, "graph");
    assert.equal(req.meta.principal, "alice@contoso.com");
    return {
      ok: true,
      status: 200,
      body: {
        role: "admin",
        state: "active",
        user: { login: "alice@contoso.com" },
        organization: { login: "myorg" },
      },
    };
  });
  const r = azAdapter.fetchOrgAdmin(t, ADO_REF, "alice@contoso.com", {
    capture_ts: TS,
  });
  assert.equal(r.ok, true);
  assert.equal(r.role, "admin");
  assert.equal(r.state, "active");
  assert.equal(r.orgPrincipal, "myorg");
});

test("azure adapter: fetchCommitVerification ALWAYS reports verified:false (ADO has no API signature verification)", () => {
  const t = adoTransport(() => ({
    ok: true,
    status: 200,
    body: { commitId: "abc1234", author: { name: "Alice" } },
  }));
  const r = azAdapter.fetchCommitVerification(t, ADO_REF, "abc1234", {
    capture_ts: TS,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.equal(r.capture.commit.verification.verified, false);
});

test("azure adapter: listCollaborators shapes members into the canonical collaborators capture", () => {
  const t = adoTransport(() => ({
    ok: true,
    status: 200,
    body: [
      { login: "alice@contoso.com", isAdmin: true },
      { login: "bob@contoso.com", isAdmin: true },
    ],
  }));
  const r = azAdapter.listCollaborators(t, ADO_REF, { capture_ts: TS });
  assert.equal(r.ok, true);
  assert.equal(
    azAdapter.verifyDistinctBoundPrincipals(
      "alice@contoso.com",
      "bob@contoso.com",
      r.capture,
    ).ok,
    true,
  );
});

test("azure adapter: validateRepoRef rejects injection in org/project/repo", () => {
  assert.equal(azAdapter.validateRepoRef(ADO_REF).valid, true);
  assert.equal(
    azAdapter.validateRepoRef({ org: "../x", project: "p", repo: "r" }).valid,
    false,
  );
});

test("azure adapter: transport throw is caught → {ok:false} (fail-closed, not propagated)", () => {
  const t = adoTransport(() => {
    throw new Error("ENETUNREACH");
  });
  const r = azAdapter.fetchRepoOwner(t, ADO_REF);
  assert.equal(r.ok, false);
  assert.match(r.reason, /network unavailable or transport threw/);
});

// ---------------------------------------------------------------------------
// Cross-provider invariant (the load-bearing one)
// ---------------------------------------------------------------------------

test("cross-provider: github + azure adapters expose the SAME method + field-name surface", () => {
  const methods = [
    "providerId",
    "captureFieldNames",
    "validateRepoRef",
    "validatePrincipal",
    "principalsEqual",
    "fetchRepoOwner",
    "fetchOrgAdmin",
    "fetchCommitVerification",
    "listCollaborators",
    "verifyDistinctBoundPrincipals",
  ];
  for (const m of methods) {
    assert.ok(m in ghAdapter, `github adapter missing ${m}`);
    assert.ok(m in azAdapter, `azure adapter missing ${m}`);
  }
  assert.deepEqual(
    Object.keys(ghAdapter.captureFieldNames).sort(),
    Object.keys(azAdapter.captureFieldNames).sort(),
    "both adapters MUST declare the same capture-field-name keys",
  );
  // The OUTER names differ by provider (honest naming); the KEYS match.
  assert.notDeepEqual(ghAdapter.captureFieldNames, azAdapter.captureFieldNames);
  assert.match(ghAdapter.captureFieldNames.owner, /^gh_api_/);
  assert.match(azAdapter.captureFieldNames.owner, /^ado_api_/);
});
