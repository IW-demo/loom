"use strict";
/**
 * Azure DevOps LIVE conformance harness (F122 follow-up).
 *
 * Closes the one gap the F122 convergence redteam documented but could not test:
 * whether the REAL Azure DevOps REST + Graph API responses match the shapes the
 * `vcs-azure-adapter.js` + `ado-api-allowlist.js` were built against (per
 * `rules/verify-resource-existence.md` MUST-2 — the live-API mapping is the
 * operator-verified step, NOT gospel baked into the adapter). It ALSO doubles as
 * the reference implementation of the production `adoApi` transport (the `az
 * rest` wrapper + the multi-step ADO Graph PCA-membership resolution) the runbook
 * `guides/co-setup/11-genesis-ceremony.md` § "Azure DevOps provider" documents.
 *
 * The conformance ORACLE is the adapter's OWN allowlist functions: this harness
 * drives `fetchRepoOwner` / `fetchOrgAdmin` / `fetchCommitVerification` /
 * `listCollaborators` against live ADO via a real `az rest` transport, then
 * asserts each returned `.capture` has the canonical inner shape. If the live
 * API has drifted from the documented shape, the adapter's allowlist produces a
 * malformed capture and the assertion fails LOUDLY — which is exactly the
 * divergence we want surfaced.
 *
 * SKIP-UNLESS-LIVE (per `skills/test-skip-discipline`): every test skips with an
 * explicit reason unless the live env is provisioned. Run it live with:
 *
 *   az login                       # refresh MFA for the Azure DevOps resource
 *   export COC_ADO_LIVE_ORG=<ado-org>
 *   export COC_ADO_LIVE_PROJECT=<ado-project>
 *   export COC_ADO_LIVE_REPO=<ado-repo-slug>
 *   export COC_ADO_LIVE_PRINCIPAL=<entra-upn>      # e.g. alice@contoso.com
 *   export COC_ADO_LIVE_SHA=<commit-sha>           # optional; any commit in the repo
 *   node --test tests/integration/multi-operator/azure-live-conformance.test.js
 *
 * Existence-check-first: the FIRST live test (repo existence) is the gate per
 * `verify-resource-existence.md` MUST-1 — if the org/project/repo does not exist
 * under the auth-scoped token, every downstream check is meaningless, so it
 * fails first with the resource that was absent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const LIB = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  ".claude",
  "hooks",
  "lib",
);
const azureAdapter = require(path.join(LIB, "vcs-azure-adapter.js"));
const adoAllow = require(path.join(LIB, "ado-api-allowlist.js"));
const { runEnrollmentCeremony } = require(
  path.join(LIB, "genesis-ceremony.js"),
);
const { foldGenesisAnchor } = require(path.join(LIB, "fold-genesis-anchor.js"));
const { verify } = require(path.join(LIB, "coc-sign.js"));
// Multi-operator lifecycle surfaces (owner-add / owner-depart / reap / derived-N).
const { runAttestationCeremony } = require(
  path.join(LIB, "owner-add-ceremony.js"),
);
const { runRevocationCeremony } = require(
  path.join(LIB, "owner-depart-ceremony.js"),
);
const { buildReapRecord } = require(path.join(LIB, "reap-ceremony.js"));
const { foldReap } = require(path.join(LIB, "fold-rule-reap.js"));
const { computeDerivedN } = require(path.join(LIB, "derive-n.js"));
const { LIVENESS_TTL_MS } = require(path.join(LIB, "fold-rule-10.js"));

// Ephemeral SSH key fixture (parity with azure-enrollment-ceremony.test.js).
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ado-live-${label}-`));
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
    `ado-live-${label}`,
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fp = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    encoding: "utf8",
  }).match(/SHA256:[A-Za-z0-9+/=]+/)[0];
  return { dir, keyPath, pubKey: pub, fingerprint: fp };
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps
const GRAPH_API = "7.1-preview.1";
const CORE_API = "7.1";

const ENV = {
  org: process.env.COC_ADO_LIVE_ORG,
  project: process.env.COC_ADO_LIVE_PROJECT,
  repo: process.env.COC_ADO_LIVE_REPO,
  principal: process.env.COC_ADO_LIVE_PRINCIPAL,
  principal2: process.env.COC_ADO_LIVE_PRINCIPAL2 || null, // 2nd PCA operator
  sha: process.env.COC_ADO_LIVE_SHA || null,
};
const LIVE = !!(ENV.org && ENV.project && ENV.repo && ENV.principal);
const SKIP_REASON =
  "probe-unavailable: requires az login (ADO MFA) + COC_ADO_LIVE_{ORG,PROJECT,REPO,PRINCIPAL} env";
// The multi-operator lifecycle section additionally needs a 2nd PCA principal +
// COC_ADO_LIVE_LIFECYCLE=1 (both members must be Project Collection Administrators
// so the reap distinctness predicate has two admin-bound co-signers).
const LIFECYCLE =
  LIVE && ENV.principal2 && process.env.COC_ADO_LIVE_LIFECYCLE === "1";
const LIFECYCLE_SKIP =
  "lifecycle-unavailable: requires COC_ADO_LIVE_LIFECYCLE=1 + COC_ADO_LIVE_PRINCIPAL2 (a 2nd PCA member)";

// --- live transport (az rest) -------------------------------------------------
function azRest(uri) {
  // Arg-array form (no shell); az rest binds the ADO bearer token via --resource.
  const out = execFileSync(
    "az",
    [
      "rest",
      "--resource",
      ADO_RESOURCE,
      "--method",
      "get",
      "--uri",
      uri,
      "-o",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out && out.trim() ? JSON.parse(out) : null;
}

// Production-grade adoApi: the `az rest` transport + the documented multi-step
// ADO Graph PCA-membership resolution. This is the reference the runbook's
// "production transport MUST implement" clause points at.
function makeLiveAdoApi() {
  return function adoApi(req) {
    const { service, path: p, meta } = req || {};
    try {
      if (service === "core") {
        const body = azRest(`https://dev.azure.com/${p}`);
        return { ok: true, status: 200, body };
      }
      if (service === "graph") {
        const org = (meta && meta.org) || ENV.org;
        const vssps = `https://vssps.dev.azure.com/${org}/_apis/graph`;
        if (/admin-membership/.test(p)) {
          // Step 1: resolve the aad user descriptor by principalName.
          const users = azRest(
            `${vssps}/users?subjectTypes=aad&api-version=${GRAPH_API}`,
          );
          const user = (users && users.value ? users.value : []).find(
            (u) =>
              u &&
              typeof u.principalName === "string" &&
              azureAdapter.principalsEqual(u.principalName, meta.principal),
          );
          if (!user) {
            return {
              ok: true,
              status: 200,
              body: {
                role: "member",
                state: "inactive",
                user: { login: meta.principal },
                organization: { login: org },
                _note: "principal not found among aad graph users",
              },
            };
          }
          // Step 2: resolve the Project Collection Administrators group descriptor.
          const groups = azRest(`${vssps}/groups?api-version=${GRAPH_API}`);
          const pca = (groups && groups.value ? groups.value : []).find(
            (g) =>
              g &&
              typeof g.displayName === "string" &&
              g.displayName.toLowerCase() ===
                "project collection administrators",
          );
          // Step 3: is the user a (transitive) member of the PCA group?
          let isAdmin = false;
          if (pca) {
            const memberships = azRest(
              `${vssps}/memberships/${user.descriptor}?direction=up&api-version=${GRAPH_API}`,
            );
            isAdmin = (
              memberships && memberships.value ? memberships.value : []
            ).some((m) => m && m.containerDescriptor === pca.descriptor);
          }
          return {
            ok: true,
            status: 200,
            body: {
              role: isAdmin ? "admin" : "member",
              state: "active",
              user: { login: user.principalName },
              organization: { login: org },
            },
          };
        }
        if (/\/members\b/.test(p)) {
          // Members determination: aad users in the org + their PCA-admin flag.
          const users = azRest(
            `${vssps}/users?subjectTypes=aad&api-version=${GRAPH_API}`,
          );
          const groups = azRest(`${vssps}/groups?api-version=${GRAPH_API}`);
          const pca = (groups && groups.value ? groups.value : []).find(
            (g) =>
              g &&
              typeof g.displayName === "string" &&
              g.displayName.toLowerCase() ===
                "project collection administrators",
          );
          const members = (users && users.value ? users.value : []).map((u) => {
            let isAdmin = false;
            if (pca && u.descriptor) {
              const ms = azRest(
                `${vssps}/memberships/${u.descriptor}?direction=up&api-version=${GRAPH_API}`,
              );
              isAdmin = (ms && ms.value ? ms.value : []).some(
                (m) => m && m.containerDescriptor === pca.descriptor,
              );
            }
            return { login: u.principalName, isAdmin };
          });
          return { ok: true, status: 200, body: members };
        }
      }
      return {
        ok: false,
        status: 404,
        body: { message: `unhandled ${service} ${p}` },
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: err && err.message ? err.message : String(err),
      };
    }
  };
}

function repoRef() {
  return { org: ENV.org, project: ENV.project, repo: ENV.repo };
}

// =============================================================================
// 1. EXISTENCE CHECK FIRST (verify-resource-existence MUST-1)
// =============================================================================
test("ado_live_repo_exists_under_auth_scoped_org", (t) => {
  if (!LIVE) return t.skip(SKIP_REASON);
  const adoApi = makeLiveAdoApi();
  const res = azureAdapter.fetchRepoOwner(adoApi, repoRef(), {});
  assert.ok(
    res.ok,
    `repo existence FAILED — ${res.error || res.reason}. Per verify-resource-existence MUST-1, the org/project/repo must exist under the az-auth-scoped token before any downstream check is meaningful. Verify: az rest --resource ${ADO_RESOURCE} --uri https://dev.azure.com/${ENV.org}/${ENV.project}/_apis/git/repositories/${ENV.repo}?api-version=${CORE_API}`,
  );
  // Conformance: the allowlist oracle must produce the canonical owner shape.
  assert.equal(res.ownerPrincipal, ENV.org, "owner.login = auth-scoped org");
  assert.ok(res.capture.owner && res.capture.owner.login === ENV.org);
  assert.ok(
    typeof res.capture.name === "string",
    "repo name present in capture",
  );
  assert.ok(typeof res.capture.capture_ts === "string", "capture_ts present");
});

// =============================================================================
// 2. COMMIT CAPTURE — verified ALWAYS false on ADO (org-admin anchor)
// =============================================================================
test("ado_live_commit_capture_verified_always_false", (t) => {
  if (!LIVE) return t.skip(SKIP_REASON);
  if (!ENV.sha)
    return t.skip(
      "set COC_ADO_LIVE_SHA to a commit in the repo to run this check",
    );
  const adoApi = makeLiveAdoApi();
  const res = azureAdapter.fetchCommitVerification(
    adoApi,
    repoRef(),
    ENV.sha,
    {},
  );
  assert.ok(res.ok, `commit capture FAILED — ${res.error || res.reason}`);
  assert.equal(res.verified, false, "ADO never returns a verified signature");
  assert.equal(
    res.capture.commit.verification.reason,
    adoAllow.ADO_COMMIT_UNVERIFIED_REASON,
    "unverified reason token is faithful",
  );
  assert.ok(typeof res.capture.sha === "string", "sha present in capture");
});

// =============================================================================
// 3. ORG-ADMIN (PCA) ATTESTATION — the ADO verified-identity anchor
// =============================================================================
test("ado_live_org_admin_pca_attestation_shape", (t) => {
  if (!LIVE) return t.skip(SKIP_REASON);
  const adoApi = makeLiveAdoApi();
  const res = azureAdapter.fetchOrgAdmin(adoApi, repoRef(), ENV.principal, {});
  assert.ok(res.ok, `org-admin resolution FAILED — ${res.error || res.reason}`);
  // Shape conformance (independent of whether the principal IS an admin).
  assert.ok(
    ["admin", "member"].includes(res.role),
    `role is admin|member, got ${res.role}`,
  );
  assert.ok(typeof res.capture.state === "string", "state present");
  assert.ok(
    res.capture.user && typeof res.capture.user.login === "string",
    "user.login (UPN) present",
  );
  assert.ok(
    res.capture.organization && res.capture.organization.login === ENV.org,
    "organization.login = org",
  );
  // Informational: surface whether THIS principal is a PCA (the anchor gate).
  t.diagnostic(
    `principal ${ENV.principal} resolved role=${res.role} state=${res.capture.state} — ` +
      (res.role === "admin"
        ? "eligible as the ADO N=1 org-admin anchor"
        : "NOT a PCA → would fail the org-admin anchor (expected unless this UPN is a Project Collection Administrator)"),
  );
});

// =============================================================================
// 4. MEMBERS CAPTURE — distinctness-attestation surface
// =============================================================================
test("ado_live_members_capture_canonical_shape", (t) => {
  if (!LIVE) return t.skip(SKIP_REASON);
  const adoApi = makeLiveAdoApi();
  const res = azureAdapter.listCollaborators(adoApi, repoRef(), {});
  assert.ok(res.ok, `members capture FAILED — ${res.error || res.reason}`);
  assert.ok(
    Array.isArray(res.capture.collaborators),
    "collaborators is an array",
  );
  for (const c of res.capture.collaborators) {
    assert.ok(typeof c.login === "string", "each member has a login (UPN)");
    assert.ok(
      c.permissions && typeof c.permissions.admin === "boolean",
      "permissions.admin bool",
    );
  }
  t.diagnostic(
    `live ADO org members captured: ${res.capture.collaborators.length}`,
  );
});

// =============================================================================
// 5. END-TO-END enrollment walk (user-flow-validation) — opt-in, ceremony-ready
// =============================================================================
test("ado_live_enrollment_ceremony_end_to_end", (t) => {
  if (!LIVE) return t.skip(SKIP_REASON);
  if (process.env.COC_ADO_LIVE_CEREMONY !== "1")
    return t.skip(
      "set COC_ADO_LIVE_CEREMONY=1 to run the full enrollment walk (requires the principal to be a PCA + COC_ADO_LIVE_SHA = repo root commit)",
    );
  if (!ENV.sha)
    return t.skip(
      "set COC_ADO_LIVE_SHA to the repo root commit for the enrollment root_commit anchor",
    );
  // The FULL user walk (user-flow-validation): runEnrollmentCeremony with
  // provider=azure-devops against LIVE ADO + a REAL ephemeral signing key, then
  // fold the emitted genesis-anchor and assert the trust root is established.
  // The org creator (PRINCIPAL) is a PCA, so the live org-admin attestation is
  // the verified-identity anchor (ADO has no commit-sig). transportAppend is
  // capture-only — the walk exercises the ceremony + fold, it does NOT write to
  // any real coordination log.
  const ownerKey = mkEphemeralSshKey("enroll");
  try {
    const roster = {
      genesis: {
        provider: "azure-devops",
        repo_owner: ENV.org, // the ADO org
        repo_owner_kind: "org",
        ado_project: ENV.project,
        root_commit: ENV.sha,
        genesis_generation: 0,
      },
      persons: {
        "pid-owner-live": {
          display_id: "live-owner",
          role: "owner",
          principal: ENV.principal,
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
    let appended = null;
    const result = runEnrollmentCeremony({
      roster,
      repo: { repo: ENV.repo },
      signingKeyPath: ownerKey.keyPath,
      signingKeyFingerprint: ownerKey.fingerprint,
      keyType: "ssh",
      adoApi: makeLiveAdoApi(),
      transportAppend: (rec) => {
        appended = rec;
        return { ok: true };
      },
    });
    assert.equal(
      result.ok,
      true,
      `LIVE enrollment ceremony failed at step ${result.step}: ${result.error || ""} ${result.reason || ""}`,
    );
    const c = result.record.content;
    assert.equal(c.provider, "azure-devops");
    assert.equal(
      c.ado_api_org_admin_capture.role,
      "admin",
      "live PCA role=admin",
    );
    assert.equal(
      c.ado_api_org_admin_capture.state,
      "active",
      "live PCA state=active",
    );
    assert.equal(
      c.ado_api_root_commit_capture.commit.verification.verified,
      false,
      "ADO root commit verified=false (anchor is the PCA attestation, not the sig)",
    );
    assert.equal(
      c.gh_api_org_membership_capture,
      undefined,
      "no gh_api_* leakage",
    );
    assert.deepEqual(result.record, appended, "appended == returned record");

    // Fold the live-produced record → trust root established (provider dispatch
    // → principal owner-bind against the live ado_api_org_admin_capture).
    const fold = foldGenesisAnchor(
      result.record,
      { trustRoot: null },
      roster,
      verify,
    );
    assert.equal(fold.accepted, true, `live fold rejected: ${fold.reason}`);
    assert.equal(
      fold.foldState.trustRoot.verified_id,
      ownerKey.fingerprint,
      "trust-root signer is the live ADO owner key",
    );
    t.diagnostic(
      `LIVE ADO enrollment walked end-to-end: ceremony signed a genesis-anchor for ${ENV.principal} (PCA of ${ENV.org}), root_commit ${ENV.sha.slice(0, 12)}, fold ACCEPTED → trust root established`,
    );
  } finally {
    cleanupDir(ownerKey.dir);
  }
});

// =============================================================================
// MULTI-OPERATOR LIFECYCLE (live) — owner-add / owner-depart / reap / derived-N
// Requires COC_ADO_LIVE_LIFECYCLE=1 + COC_ADO_LIVE_PRINCIPAL2 (a 2nd PCA member).
// Both principals MUST be Project Collection Administrators so the reap
// distinctness predicate has two admin-bound co-signers.
// =============================================================================

function adoGenesisBlock() {
  return {
    provider: "azure-devops",
    repo_owner: ENV.org,
    repo_owner_kind: "org",
    ado_project: ENV.project,
    root_commit: ENV.sha || "0".repeat(40),
    genesis_generation: 0,
  };
}

// L1 — owner-add SUCCESS (jack attests ss) + derived-N counts both owners.
test("ado_live_lifecycle_owner_add_then_derived_n_counts_two", (t) => {
  if (!LIFECYCLE) return t.skip(LIFECYCLE_SKIP);
  if (!ENV.sha)
    return t.skip(
      "set COC_ADO_LIVE_SHA (repo root commit) for the enrollment anchor",
    );
  const jackKey = mkEphemeralSshKey("lc-jack");
  const ssKey = mkEphemeralSshKey("lc-ss");
  try {
    const adoApi = makeLiveAdoApi();
    const roster = {
      genesis: adoGenesisBlock(),
      persons: {
        "pid-jack": {
          display_id: "jack",
          role: "owner",
          principal: ENV.principal,
          host_role: "human",
          keys: [
            {
              type: "ssh",
              fingerprint: jackKey.fingerprint,
              pubkey: jackKey.pubKey,
            },
          ],
        },
        "pid-ss": {
          display_id: "ss",
          role: "owner",
          principal: ENV.principal2,
          host_role: "human",
          keys: [
            {
              type: "ssh",
              fingerprint: ssKey.fingerprint,
              pubkey: ssKey.pubKey,
            },
          ],
        },
      },
    };
    // Enroll jack (genesis-anchor) → trust root.
    let genesisRec = null;
    const enroll = runEnrollmentCeremony({
      roster,
      repo: { repo: ENV.repo },
      signingKeyPath: jackKey.keyPath,
      signingKeyFingerprint: jackKey.fingerprint,
      keyType: "ssh",
      adoApi,
      transportAppend: (r) => {
        genesisRec = r;
        return { ok: true };
      },
    });
    assert.ok(
      enroll.ok,
      `enroll: ${enroll.error || ""} ${enroll.reason || ""}`,
    );
    const fold = foldGenesisAnchor(
      enroll.record,
      { trustRoot: null },
      roster,
      verify,
    );
    assert.ok(fold.accepted, `genesis fold: ${fold.reason}`);

    // owner-add: the owner attests the 2nd principal as a distinct collaborator
    // (live members check against the ADO Graph).
    const att = runAttestationCeremony({
      roster,
      repo: ENV.repo,
      newOwnerPrincipal: ENV.principal2,
      signer: {
        person_id: "pid-jack",
        verified_id: jackKey.fingerprint,
        keyPath: jackKey.keyPath,
      },
      seq: 1,
      prevHash: null,
      now: () => new Date().toISOString(),
      adoApi,
    });
    assert.ok(att.ok, `owner-add: ${att.error || ""}`);
    assert.equal(att.record.content.provider, "azure-devops");
    assert.equal(att.record.content.principal, ENV.principal2);
    assert.ok(
      att.record.content.ado_api_members_capture,
      "members capture present",
    );

    // derived-N: jack (genesis owner, R9-A-03) + ss (attested) → 2.
    const dn = computeDerivedN({
      roster,
      log: [genesisRec, att.record],
      trustRoot: fold.foldState.trustRoot,
    });
    assert.equal(
      dn.derived_N,
      2,
      `derived_N=${dn.derived_N} notes=${dn.notes}`,
    );
    t.diagnostic(
      `LIVE owner-add + derived-N: ${dn.derived_N} owners (${dn.live_logins.join(", ")})`,
    );
  } finally {
    cleanupDir(jackKey.dir);
    cleanupDir(ssKey.dir);
  }
});

// L2 — owner-depart FAIL-CLOSED (ss is still a live member → revocation refused).
test("ado_live_lifecycle_owner_depart_fails_closed_while_member_present", (t) => {
  if (!LIFECYCLE) return t.skip(LIFECYCLE_SKIP);
  const jackKey = mkEphemeralSshKey("lc-dep");
  try {
    const roster = { genesis: adoGenesisBlock(), persons: {} };
    const res = runRevocationCeremony({
      roster,
      repo: ENV.repo,
      departingPrincipal: ENV.principal2, // ss STILL a member
      signer: {
        person_id: "pid-jack",
        verified_id: jackKey.fingerprint,
        keyPath: jackKey.keyPath,
      },
      seq: 2,
      now: () => new Date().toISOString(),
      mostRecentVictimChainEntry: null,
      adoApi: makeLiveAdoApi(),
    });
    assert.equal(
      res.ok,
      false,
      "revocation MUST fail closed while the principal is still a member",
    );
    assert.match(res.error, /still a member|fails closed/);
    t.diagnostic(`LIVE owner-depart correctly fail-closed: ${res.error}`);
  } finally {
    cleanupDir(jackKey.dir);
  }
});

// L3 — owner-add FAIL-CLOSED (a non-member principal → attestation refused).
test("ado_live_lifecycle_owner_add_fails_closed_for_non_member", (t) => {
  if (!LIFECYCLE) return t.skip(LIFECYCLE_SKIP);
  const jackKey = mkEphemeralSshKey("lc-ghost");
  try {
    const roster = { genesis: adoGenesisBlock(), persons: {} };
    const res = runAttestationCeremony({
      roster,
      repo: ENV.repo,
      newOwnerPrincipal: "ghost-not-a-member@example.com",
      signer: {
        person_id: "pid-jack",
        verified_id: jackKey.fingerprint,
        keyPath: jackKey.keyPath,
      },
      seq: 1,
      now: () => new Date().toISOString(),
      adoApi: makeLiveAdoApi(),
    });
    assert.equal(
      res.ok,
      false,
      "attestation MUST fail closed for a non-member",
    );
    assert.match(res.error, /NOT a member|fails closed/);
    t.diagnostic(`LIVE owner-add correctly fail-closed: ${res.error}`);
  } finally {
    cleanupDir(jackKey.dir);
  }
});

// L4 — cross-operator reap SUCCESS (jack reaper + ss cosigner, both PCA-admin-bound
// in the LIVE members capture → distinctness predicate passes).
test("ado_live_lifecycle_reap_success_two_admin_bound_principals", (t) => {
  if (!LIFECYCLE) return t.skip(LIFECYCLE_SKIP);
  const jackKey = mkEphemeralSshKey("lc-reap-j");
  const ssKey = mkEphemeralSshKey("lc-reap-s");
  const victimKey = mkEphemeralSshKey("lc-reap-v");
  try {
    const adoApi = makeLiveAdoApi();
    const repoRefObj = { org: ENV.org, project: ENV.project, repo: ENV.repo };
    // Live members capture (both jack + ss are admin-bound after the PCA promotion).
    const membersRes = azureAdapter.listCollaborators(adoApi, repoRefObj, {
      capture_ts: new Date().toISOString(),
    });
    assert.ok(membersRes.ok, `members capture: ${membersRes.error || ""}`);
    const now = Date.now();
    const hbTs = new Date(now - LIVENESS_TTL_MS - 60_000).toISOString();
    const reap = buildReapRecord({
      provider: "azure-devops",
      reapedClaim: { verified_id: victimKey.fingerprint, seq: 7 },
      reaperPerson: {
        person_id: "pid-jack",
        role: "owner",
        host_role: "human",
      },
      reaperVerifiedId: jackKey.fingerprint,
      cosignerPerson: {
        person_id: "pid-ss",
        role: "owner",
        host_role: "human",
      },
      cosignerVerifiedId: ssKey.fingerprint,
      cosignerKeyPath: ssKey.keyPath,
      reaperKeyPath: jackKey.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: victimKey.fingerprint,
        seq: 42,
        ts: hbTs,
      },
      basis: "co-signed",
      adoMembersCapture: membersRes.capture, // LIVE capture
      seq: 0,
      prevHash: null,
      ts: new Date(now).toISOString(),
    });
    assert.ok(reap.ok, `buildReapRecord: ${reap.error || ""}`);
    assert.equal(reap.record.content.provider, "azure-devops");

    const roster = {
      genesis: adoGenesisBlock(),
      persons: {
        "pid-jack": {
          role: "owner",
          host_role: "human",
          principal: ENV.principal,
          keys: [{ type: "ssh", fingerprint: jackKey.fingerprint }],
        },
        "pid-ss": {
          role: "owner",
          host_role: "human",
          principal: ENV.principal2,
          keys: [{ type: "ssh", fingerprint: ssKey.fingerprint }],
        },
      },
    };
    const res = foldReap(reap.record, {
      foldState: { trustRoot: null },
      roster,
      acceptedSoFar: [
        {
          type: "heartbeat",
          verified_id: victimKey.fingerprint,
          seq: 42,
          ts: hbTs,
        },
      ],
      opts: { now },
    });
    assert.ok(res.accepted, `reap fold: ${res.reason || ""}`);
    t.diagnostic(
      `LIVE reap accepted: jack + ss (both PCA-admin in live capture) co-signed the reap of a stale claim`,
    );
  } finally {
    cleanupDir(jackKey.dir);
    cleanupDir(ssKey.dir);
    cleanupDir(victimKey.dir);
  }
});
