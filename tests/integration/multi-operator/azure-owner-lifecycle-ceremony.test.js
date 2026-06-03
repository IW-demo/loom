"use strict";
/**
 * Shard 2c — Azure DevOps owner-lifecycle vertical (attestation / revocation /
 * reap ceremonies + their fold-side provider dispatch).
 *
 * Covers the ADO owner-add / owner-depart / reap paths end-to-end:
 *   owner-add-ceremony.js::runAttestationCeremony (provider="azure-devops")
 *     → collaborator-distinctness-attestation (content.provider + principal +
 *        ado_api_members_capture)
 *   owner-depart-ceremony.js::runRevocationCeremony (provider="azure-devops")
 *     → collaborator-distinctness-revocation (+ provider-neutral evidence_window)
 *     → fold-rule-10.js::foldRevocation (provider-neutral contest; reads principal)
 *   reap-ceremony.js::buildReapRecord (provider="azure-devops")
 *     → fold-rule-reap.js::foldReap (dispatch → ado_api_members_capture +
 *        principalsEqual distinctness)
 *   derive-n.js::computeDerivedN (provider dispatch → counts owners by principal)
 *
 * Load-bearing invariants under test:
 *   1. ADO binds the attested/departing operator via `principal` (Entra UPN),
 *      NOT github_login; the record carries content.provider + ado_api_*.
 *   2. GitHub byte-identity: a github lifecycle ceremony through the SAME
 *      (refactored) functions emits a record with NO content.provider field +
 *      github_login + gh_api_collaborators_capture (the #1 port invariant).
 *   3. The fold side dispatches on content.provider / roster.genesis.provider
 *      and reads the matching identity + capture fields.
 *
 * Tier-2: dependency-injected fakes for the API transport; REAL ephemeral SSH
 * keys + REAL coc-sign.sign/verify (no signing mock). Every assertion is a
 * STRUCTURAL probe per rules/probe-driven-verification.md.
 *
 * Run: node --test tests/integration/multi-operator/azure-owner-lifecycle-ceremony.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const OWNER_ADD = path.join(LIB_DIR, "owner-add-ceremony.js");
const OWNER_DEPART = path.join(LIB_DIR, "owner-depart-ceremony.js");
const REAP_CEREMONY = path.join(LIB_DIR, "reap-ceremony.js");
const FOLD_REAP = path.join(LIB_DIR, "fold-rule-reap.js");
const FOLD_RULE_10 = path.join(LIB_DIR, "fold-rule-10.js");
const DERIVE_N = path.join(LIB_DIR, "derive-n.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");

// ---------------------------------------------------------------------------
// Ephemeral SSH key fixture (parity with the 2a/2b ADO tests)
// ---------------------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ado-life-${label}-`));
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
    `ado-life-test-${label}`,
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

// ADO members transport: only the graph/members call is exercised by the
// attestation/revocation ceremonies. Returns the determination array
// [{login, isAdmin}] the adapter shapes into the canonical members capture.
function makeAdoMembersApi(members) {
  return function adoApi(req) {
    if (req && req.service === "graph" && /members/.test(req.path)) {
      return { ok: true, status: 200, body: members };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

// GitHub collaborators transport for byte-identity sibling tests.
function makeGhCollaboratorsApi(logins) {
  return function ghApi(endpoint) {
    if (/\/collaborators$/.test(endpoint)) {
      return {
        ok: true,
        status: 200,
        body: logins.map((l) => ({
          login: l,
          permissions: { admin: true, push: true },
        })),
      };
    }
    return { ok: false, status: 404, body: { message: "Not Found" } };
  };
}

function adoRosterGenesis(opts) {
  const o = opts || {};
  return {
    provider: "azure-devops",
    repo_owner: o.org || "myorg",
    repo_owner_kind: "org",
    ado_project: o.project || "myproj",
    root_commit: "abc123def456",
    genesis_generation: 0,
  };
}

// ===========================================================================
// owner-add (attestation)
// ===========================================================================

test("ado_attestation_emits_provider_principal_members_capture", () => {
  const { runAttestationCeremony } = require(OWNER_ADD);
  const { verify } = require(COC_SIGN);
  const key = mkEphemeralSshKey("att");
  try {
    const result = runAttestationCeremony({
      roster: { genesis: adoRosterGenesis(), persons: {} },
      repo: "coordrepo",
      newOwnerPrincipal: "Bob@Contoso.com", // mixed case — Entra is case-insensitive
      signer: {
        person_id: "pid-owner",
        verified_id: key.fingerprint,
        keyPath: key.keyPath,
      },
      seq: 3,
      prevHash: "prevhash-xyz",
      now: () => "2026-06-03T00:00:00.000Z",
      adoApi: makeAdoMembersApi([
        { login: "bob@contoso.com", isAdmin: true },
        { login: "alice@contoso.com", isAdmin: true },
      ]),
    });
    assert.ok(result.ok, `attestation: ${result.error || ""}`);
    const c = result.record.content;
    assert.equal(result.record.type, "collaborator-distinctness-attestation");
    assert.equal(c.provider, "azure-devops");
    assert.equal(c.principal, "Bob@Contoso.com");
    assert.equal(
      c.github_login,
      undefined,
      "ADO record MUST NOT carry github_login",
    );
    assert.ok(
      c.ado_api_members_capture &&
        Array.isArray(c.ado_api_members_capture.collaborators),
      "ADO record carries ado_api_members_capture in canonical shape",
    );
    assert.equal(
      c.gh_api_collaborators_capture,
      undefined,
      "ADO record MUST NOT carry gh_api_collaborators_capture",
    );
    // Real signature verifies.
    const { canonicalSerialize } = require(COC_SIGN);
    const { sig, ...core } = result.record;
    const v = verify(canonicalSerialize(core), sig, key.pubKey, {
      keyType: "ssh",
    });
    assert.ok(v.ok, `signature verify: ${v.reason || v.error || ""}`);
  } finally {
    cleanup(key.dir);
  }
});

test("ado_attestation_fails_closed_when_principal_not_a_member", () => {
  const { runAttestationCeremony } = require(OWNER_ADD);
  const key = mkEphemeralSshKey("att-fc");
  try {
    const result = runAttestationCeremony({
      roster: { genesis: adoRosterGenesis(), persons: {} },
      repo: "coordrepo",
      newOwnerPrincipal: "ghost@contoso.com",
      signer: {
        person_id: "pid-owner",
        verified_id: key.fingerprint,
        keyPath: key.keyPath,
      },
      seq: 1,
      now: () => "2026-06-03T00:00:00.000Z",
      adoApi: makeAdoMembersApi([
        { login: "alice@contoso.com", isAdmin: true },
      ]),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /fails closed|NOT a member/);
  } finally {
    cleanup(key.dir);
  }
});

test("github_attestation_byte_identity_no_provider_field", () => {
  const { runAttestationCeremony } = require(OWNER_ADD);
  const key = mkEphemeralSshKey("att-gh");
  try {
    const result = runAttestationCeremony({
      roster: { genesis: { repo_owner: "alice" }, persons: {} },
      repoOwner: "alice",
      repo: "myrepo",
      newOwnerLogin: "bob",
      signer: {
        person_id: "pid-owner",
        verified_id: key.fingerprint,
        keyPath: key.keyPath,
      },
      seq: 2,
      now: () => "2026-06-03T00:00:00.000Z",
      ghApi: makeGhCollaboratorsApi(["bob", "alice"]),
    });
    assert.ok(result.ok, `github attestation: ${result.error || ""}`);
    const c = result.record.content;
    assert.equal(
      c.provider,
      undefined,
      "github record MUST have NO content.provider",
    );
    assert.equal(c.github_login, "bob");
    assert.ok(
      c.gh_api_collaborators_capture,
      "github carries gh_api_collaborators_capture",
    );
    assert.equal(c.ado_api_members_capture, undefined);
  } finally {
    cleanup(key.dir);
  }
});

// ===========================================================================
// owner-depart (revocation) + fold-rule-10
// ===========================================================================

test("ado_revocation_emits_provider_principal_evidence_window", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const { _internal } = require(FOLD_RULE_10);
  const key = mkEphemeralSshKey("rev");
  try {
    const result = runRevocationCeremony({
      roster: { genesis: adoRosterGenesis(), persons: {} },
      repo: "coordrepo",
      departingPrincipal: "bob@contoso.com",
      signer: {
        person_id: "pid-owner",
        verified_id: key.fingerprint,
        keyPath: key.keyPath,
      },
      seq: 5,
      prevHash: "ph",
      now: () => "2026-06-03T00:00:00.000Z",
      mostRecentVictimChainEntry: {
        verified_id: "victim-vid",
        seq: 12,
        ts: "2026-06-02T00:00:00.000Z",
      },
      // bob is absent from the members list → revocation proceeds.
      adoApi: makeAdoMembersApi([
        { login: "alice@contoso.com", isAdmin: true },
      ]),
    });
    assert.ok(result.ok, `revocation: ${result.error || ""}`);
    const c = result.record.content;
    assert.equal(c.provider, "azure-devops");
    assert.equal(c.principal, "bob@contoso.com");
    assert.equal(c.github_login, undefined);
    assert.ok(c.evidence_window, "carries the R10-A-02 evidence window");
    assert.equal(c.evidence_window.opens_at, "2026-06-02T00:00:00.000Z");
    assert.equal(c.evidence_window.victim_chain_high_water_seq, 12);
    // fold-rule-10 accepts the ADO revocation shape (provider-neutral validate).
    const shapeErr = _internal._validateRevocationShape(result.record);
    assert.equal(shapeErr, null, `shape: ${shapeErr || ""}`);
  } finally {
    cleanup(key.dir);
  }
});

test("ado_revocation_fails_closed_when_principal_still_a_member", () => {
  const { runRevocationCeremony } = require(OWNER_DEPART);
  const key = mkEphemeralSshKey("rev-fc");
  try {
    const result = runRevocationCeremony({
      roster: { genesis: adoRosterGenesis(), persons: {} },
      repo: "coordrepo",
      departingPrincipal: "bob@contoso.com",
      signer: {
        person_id: "pid-owner",
        verified_id: key.fingerprint,
        keyPath: key.keyPath,
      },
      seq: 5,
      now: () => "2026-06-03T00:00:00.000Z",
      mostRecentVictimChainEntry: null,
      // bob is STILL a member → revocation fails closed (defeats omission).
      adoApi: makeAdoMembersApi([{ login: "bob@contoso.com", isAdmin: true }]),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /fails closed|still a member/);
  } finally {
    cleanup(key.dir);
  }
});

test("fold_rule_10_contests_ado_revocation_on_contradicting_activity", () => {
  const { foldRevocation } = require(FOLD_RULE_10);
  // Hand-built ADO revocation (fold trusts upstream sig verification).
  const revocation = {
    type: "collaborator-distinctness-revocation",
    verified_id: "revoker-vid",
    seq: 9,
    ts: "2026-06-03T00:00:00.000Z",
    content: {
      provider: "azure-devops",
      principal: "bob@contoso.com",
      evidence_window: {
        opens_at: "2026-06-02T00:00:00.000Z",
        closes_at: "2026-06-03T00:00:00.000Z",
        victim_chain_high_water_seq: 12,
      },
    },
  };
  // A victim-chain entry at a seq ABOVE the claimed high-water contests it.
  const contradicting = {
    verified_id: "victim-vid",
    seq: 15,
    ts: "2026-06-02T12:00:00.000Z",
  };
  const out = foldRevocation(revocation, {
    victimChainEntries: [contradicting],
    state: { revocations: {} },
  });
  assert.equal(out.accepted, false);
  assert.equal(out.contested, true);
  assert.equal(out.forging_signer, "revoker-vid");
});

// ===========================================================================
// derive-n — provider dispatch counts owners by principal
// ===========================================================================

test("derive_n_counts_ado_owners_by_principal", () => {
  const { computeDerivedN } = require(DERIVE_N);
  const roster = {
    genesis: adoRosterGenesis(),
    persons: {
      "pid-genesis": {
        role: "owner",
        host_role: "human",
        principal: "alice@contoso.com",
      },
      "pid-bob": {
        role: "owner",
        host_role: "human",
        principal: "bob@contoso.com",
      },
    },
  };
  const trustRoot = { person_id: "pid-genesis", seq: 0 };
  // bob attested (latest) → counts; alice is genesis → counts via R9-A-03.
  const logAttested = [
    {
      type: "collaborator-distinctness-attestation",
      seq: 1,
      content: { provider: "azure-devops", principal: "BOB@contoso.com" },
    },
  ];
  const r1 = computeDerivedN({ roster, log: logAttested, trustRoot });
  assert.equal(r1.derived_N, 2, `derived_N (attested): notes=${r1.notes}`);
  assert.ok(r1.live_logins.includes("bob@contoso.com"));
  assert.ok(r1.live_logins.includes("alice@contoso.com"));

  // bob revoked (latest by seq) → no longer counts; alice (genesis) remains.
  const logRevoked = [
    {
      type: "collaborator-distinctness-attestation",
      seq: 1,
      content: { provider: "azure-devops", principal: "bob@contoso.com" },
    },
    {
      type: "collaborator-distinctness-revocation",
      seq: 4,
      content: { provider: "azure-devops", principal: "bob@contoso.com" },
    },
  ];
  const r2 = computeDerivedN({ roster, log: logRevoked, trustRoot });
  assert.equal(r2.derived_N, 1, `derived_N (revoked): notes=${r2.notes}`);
  assert.ok(!r2.live_logins.includes("bob@contoso.com"));
});

test("derive_n_github_path_unchanged", () => {
  const { computeDerivedN } = require(DERIVE_N);
  const roster = {
    genesis: { repo_owner: "alice" },
    persons: {
      "pid-g": { role: "owner", host_role: "human", github_login: "alice" },
      "pid-b": { role: "owner", host_role: "human", github_login: "bob" },
    },
  };
  const trustRoot = { person_id: "pid-g", seq: 0 };
  const log = [
    {
      type: "collaborator-distinctness-attestation",
      seq: 1,
      content: { github_login: "bob" },
    },
  ];
  const r = computeDerivedN({ roster, log, trustRoot });
  assert.equal(r.derived_N, 2);
});

// ===========================================================================
// reap — buildReapRecord provider field + fold-rule-reap ADO distinctness
// ===========================================================================

test("ado_reap_record_carries_provider_and_members_capture", () => {
  const { buildReapRecord } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-a");
  const kCosigner = mkEphemeralSshKey("reap-b");
  const kVictim = mkEphemeralSshKey("reap-v");
  try {
    const now = Date.now();
    const out = buildReapRecord({
      provider: "azure-devops",
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: { person_id: "pid-r", role: "owner", host_role: "human" },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: { person_id: "pid-c", role: "owner", host_role: "human" },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: new Date(now - 3_600_000).toISOString(),
      },
      basis: "co-signed",
      adoMembersCapture: {
        collaborators: [
          {
            login: "reaper@contoso.com",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner@contoso.com",
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
    assert.ok(out.ok, `buildReapRecord: ${out.error || ""}`);
    assert.equal(out.record.content.provider, "azure-devops");
    assert.ok(out.record.content.ado_api_members_capture);
    assert.equal(out.record.content.gh_api_collaborators_capture, undefined);
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("github_reap_record_byte_identity_no_provider", () => {
  const { buildReapRecord } = require(REAP_CEREMONY);
  const kReaper = mkEphemeralSshKey("reap-gh-a");
  const kCosigner = mkEphemeralSshKey("reap-gh-b");
  const kVictim = mkEphemeralSshKey("reap-gh-v");
  try {
    const now = Date.now();
    const out = buildReapRecord({
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: { person_id: "pid-r", role: "owner", host_role: "human" },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: { person_id: "pid-c", role: "owner", host_role: "human" },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: new Date(now - 3_600_000).toISOString(),
      },
      basis: "co-signed",
      ghApiCollaboratorsCapture: {
        collaborators: [
          {
            login: "r",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "c",
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
    assert.ok(out.ok, `buildReapRecord: ${out.error || ""}`);
    assert.equal(out.record.content.provider, undefined);
    assert.ok(out.record.content.gh_api_collaborators_capture);
    assert.equal(out.record.content.ado_api_members_capture, undefined);
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("fold_rule_reap_accepts_ado_reap_via_principal_distinctness", () => {
  const { LIVENESS_TTL_MS } = require(FOLD_RULE_10);
  const { buildReapRecord } = require(REAP_CEREMONY);
  const { foldReap } = require(FOLD_REAP);
  const kReaper = mkEphemeralSshKey("freap-a");
  const kCosigner = mkEphemeralSshKey("freap-b");
  const kVictim = mkEphemeralSshKey("freap-v");
  try {
    const now = Date.now();
    const hbTs = new Date(now - LIVENESS_TTL_MS - 60_000).toISOString();
    const out = buildReapRecord({
      provider: "azure-devops",
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: { person_id: "pid-r", role: "owner", host_role: "human" },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: { person_id: "pid-c", role: "owner", host_role: "human" },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: hbTs,
      },
      basis: "co-signed",
      adoMembersCapture: {
        collaborators: [
          {
            login: "reaper@contoso.com",
            type: "User",
            permissions: { admin: true, push: true },
          },
          {
            login: "cosigner@contoso.com",
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
    assert.ok(out.ok, `buildReapRecord: ${out.error || ""}`);

    const roster = {
      genesis: adoRosterGenesis(),
      persons: {
        "pid-r": {
          role: "owner",
          host_role: "human",
          principal: "reaper@contoso.com",
          keys: [{ type: "ssh", fingerprint: kReaper.fingerprint }],
        },
        "pid-c": {
          role: "owner",
          host_role: "human",
          principal: "cosigner@contoso.com",
          keys: [{ type: "ssh", fingerprint: kCosigner.fingerprint }],
        },
      },
    };
    const acceptedSoFar = [
      {
        type: "heartbeat",
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: hbTs,
      },
    ];
    const res = foldReap(out.record, {
      foldState: { trustRoot: null },
      roster,
      acceptedSoFar,
      opts: { now },
    });
    assert.ok(res.accepted, `foldReap accepted: ${res.reason || ""}`);
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});

test("fold_rule_reap_rejects_ado_reap_when_principal_not_admin_member", () => {
  const { LIVENESS_TTL_MS } = require(FOLD_RULE_10);
  const { buildReapRecord } = require(REAP_CEREMONY);
  const { foldReap } = require(FOLD_REAP);
  const kReaper = mkEphemeralSshKey("freap-r-a");
  const kCosigner = mkEphemeralSshKey("freap-r-b");
  const kVictim = mkEphemeralSshKey("freap-r-v");
  try {
    const now = Date.now();
    const hbTs = new Date(now - LIVENESS_TTL_MS - 60_000).toISOString();
    const out = buildReapRecord({
      provider: "azure-devops",
      reapedClaim: { verified_id: kVictim.fingerprint, seq: 7 },
      reaperPerson: { person_id: "pid-r", role: "owner", host_role: "human" },
      reaperVerifiedId: kReaper.fingerprint,
      cosignerPerson: { person_id: "pid-c", role: "owner", host_role: "human" },
      cosignerVerifiedId: kCosigner.fingerprint,
      cosignerKeyPath: kCosigner.keyPath,
      reaperKeyPath: kReaper.keyPath,
      pinnedVictimHeartbeat: {
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: hbTs,
      },
      basis: "co-signed",
      // cosigner principal is ABSENT from the members capture → distinctness fails.
      adoMembersCapture: {
        collaborators: [
          {
            login: "reaper@contoso.com",
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
    assert.ok(out.ok, `buildReapRecord: ${out.error || ""}`);

    const roster = {
      genesis: adoRosterGenesis(),
      persons: {
        "pid-r": {
          role: "owner",
          host_role: "human",
          principal: "reaper@contoso.com",
          keys: [{ type: "ssh", fingerprint: kReaper.fingerprint }],
        },
        "pid-c": {
          role: "owner",
          host_role: "human",
          principal: "cosigner@contoso.com",
          keys: [{ type: "ssh", fingerprint: kCosigner.fingerprint }],
        },
      },
    };
    const acceptedSoFar = [
      {
        type: "heartbeat",
        verified_id: kVictim.fingerprint,
        seq: 42,
        ts: hbTs,
      },
    ];
    const res = foldReap(out.record, {
      foldState: { trustRoot: null },
      roster,
      acceptedSoFar,
      opts: { now },
    });
    assert.equal(res.accepted, false);
    assert.match(res.reason, /cosigner principal|not an admin/);
  } finally {
    cleanup(kReaper.dir);
    cleanup(kCosigner.dir);
    cleanup(kVictim.dir);
  }
});
