/**
 * Tier-2 integration tests for F14 C2-authorization-hardening shard
 * (workspaces/multi-operator-coc — security review R1 against PR #315 C2).
 *
 * Pre-ship contract per harness-cap discipline. The 4 MEDIUM + 2 LOW
 * findings from security-reviewer R1 against C2's gate matrix:
 *
 *   MED-1  operator-gate.js does not call cocSign.verify() on the
 *          gate_approval signature. The hook checks presence of
 *          approver_role / approver_gh_login / approver_host_role / sig
 *          but never verifies the bytes were signed by the approver's
 *          roster pubkey.
 *
 *   MED-2  gate-approval records are replayable across invocations
 *          (no nonce binding, no target_tool binding, no TTL). One
 *          signed approval authorizes unbounded invocations across
 *          any owner-class gated surface.
 *
 *   MED-3  Stub predicate at coordination-log.js:581-684 lacks context
 *          binding. Specifically: no target_tool allowlist, no
 *          consumed_nonce uniqueness, no requester_verified_id roster
 *          membership. Real predicate ships here for gate-approval;
 *          lease-override stays on the stub with a documented context-
 *          binding gap (out of scope for this shard).
 *
 *   MED-4  R5-S-07 collaborator-distinctness comparison is
 *          case-sensitive. GitHub server semantics are case-insensitive;
 *          an attacker registers two roster entries with the same login
 *          under different cases and bypasses the distinctness check.
 *
 *   LOW-2  Deny patterns + posture-gate.js tool check don't cover
 *          MultiEdit / NotebookEdit. Settings primary fence + posture-
 *          gate secondary fence both miss the new tools.
 *
 *   LOW-3  posture-gate.js R6-C-02 regex check runs against the literal
 *          file_path without realpath normalization. Path traversal
 *          (..foo/../learning/posture.json) bypasses the secondary fence.
 *
 * Cross-shard contracts preserved (per shard contract):
 *   - lib/eligibility.js::isEligibleSigner — single source of truth
 *   - lib/coc-sign.js::canonicalSerialize / verify — same crypto layer
 *   - lib/coordination-log.js::_coSignedBytes — canonical-bytes pattern
 *   - lib/state-io.js — read/append coordination log via Transport
 *
 * Run via:
 *   node --test tests/integration/multi-operator/c2-auth-hardening.test.js
 *
 * Tier-2 discipline: real ssh-keygen + real coc-sign verify; no mocking
 * of crypto / signature / fold semantics (rules/testing.md § Tier 2).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "operator-gate.js");
const POSTURE_GATE_PATH = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "posture-gate.js",
);
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const GATE_APPROVAL_LIB = path.join(LIB_DIR, "gate-approval.js");
const COORDINATION_LOG = path.join(LIB_DIR, "coordination-log.js");
const GATE_MATRIX = path.join(LIB_DIR, "gate-matrix.js");
const DERIVE_N = path.join(LIB_DIR, "derive-n.js");
const SETTINGS_JSON = path.join(REPO_ROOT, ".claude", "settings.json");
const OPERATOR_GATE_FIXTURES = path.join(
  REPO_ROOT,
  ".claude",
  "audit-fixtures",
  "operator-gate",
);
const POSTURE_GATE_FIXTURES = path.join(
  REPO_ROOT,
  ".claude",
  "audit-fixtures",
  "posture-gate",
);

// ---- ephemeral key fixtures (shared shape with substrate-hardening tests) ----
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-c2-${label}-`));
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
    `coc-c2-test-${label}`,
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

function ownerPerson(login, fp, pub, opts) {
  const o = opts || {};
  return {
    display_id: o.display_id || login,
    role: o.role || "owner",
    github_login: login,
    host_role: o.host_role || "human",
    keys: [{ type: "ssh", fingerprint: fp, pubkey: pub }],
  };
}

function makeRoster(persons, genesis) {
  return {
    genesis: genesis || {
      repo_owner: "owner-A",
      repo_owner_kind: "user",
      root_commit: "rootABC",
      genesis_generation: 0,
    },
    persons,
  };
}

function runHook(hookPath, payload) {
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
  });
  let stdoutJson = null;
  try {
    stdoutJson = JSON.parse(result.stdout.trim().split("\n").pop());
  } catch {
    stdoutJson = null;
  }
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: stdoutJson,
  };
}

// ---- gate-approval payload builder ------------------------------------------
//
// The MED-1+MED-2 contract: a gate_approval payload is the in-payload
// transport for an approver's signed acknowledgement that the gated
// invocation may proceed. The signed bytes cover:
//   { target_tool, requester_person_id, requester_verified_id,
//     consumed_nonce, ts }
// and the payload carries the sig + approver identity fields.

function buildGateApproval(opts) {
  const {
    approverKey,
    approverPersonId,
    approverGhLogin,
    approverRole,
    approverHostRole,
    targetTool,
    requesterPersonId,
    requesterVerifiedId,
    consumedNonce,
    ts,
    forgeSig,
    omitSig,
    omitConsumedNonce,
  } = opts;
  // iter-2 Sec-MED-2: canonical bytes now bind approver_verified_id.
  const signed = {
    target_tool: targetTool,
    requester_person_id: requesterPersonId,
    requester_verified_id: requesterVerifiedId,
    approver_verified_id: approverKey.fingerprint,
    consumed_nonce: consumedNonce,
    ts,
  };
  if (omitConsumedNonce) delete signed.consumed_nonce;
  const { canonicalSerialize, sign } = require(COC_SIGN);
  let sig = null;
  if (!omitSig) {
    if (forgeSig) {
      sig = forgeSig;
    } else {
      const r = sign(canonicalSerialize(signed), {
        keyType: "ssh",
        keyPath: approverKey.keyPath,
      });
      if (!r.ok) throw new Error(`sign failed: ${r.error} ${r.reason}`);
      sig = r.sig;
    }
  }
  const payload = {
    approver_person_id: approverPersonId,
    approver_verified_id: approverKey.fingerprint,
    approver_gh_login: approverGhLogin,
    approver_role: approverRole || "owner",
    approver_host_role: approverHostRole || "human",
    target_tool: targetTool,
    consumed_nonce: consumedNonce,
    ts,
    signed_payload: signed,
  };
  if (omitConsumedNonce) delete payload.consumed_nonce;
  if (!omitSig) payload.sig = sig;
  return payload;
}

// ---- audit fixtures presence -----------------------------------------------

test("c2_auth_hardening_audit_fixtures_present", () => {
  const operatorRequired = [
    "flag-missing-gate-approval-sig.txt",
    "flag-forged-gate-approval-sig.txt",
    "flag-nonce-mismatch.txt",
    "flag-replay-same-nonce.txt",
    "flag-target-tool-mismatch.txt",
    "flag-expired-gate-approval.txt",
    "flag-case-folded-collaborator-bypass.txt",
  ];
  for (const f of operatorRequired) {
    const p = path.join(OPERATOR_GATE_FIXTURES, f);
    assert.ok(fs.existsSync(p), `operator-gate fixture missing: ${p}`);
  }
  const postureRequired = [
    "flag-multiedit-blocked.txt",
    "flag-realpath-traversal.txt",
  ];
  for (const f of postureRequired) {
    const p = path.join(POSTURE_GATE_FIXTURES, f);
    assert.ok(fs.existsSync(p), `posture-gate fixture missing: ${p}`);
  }
});

// ---- MED-1: cocSign.verify on gate_approval -------------------------------

test("operator_gate_requires_gate_approval_sig", () => {
  // MED-1: payload without sig field must block.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "bob",
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-test-001",
      ts: new Date().toISOString(),
      omitSig: true,
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: "n-test-001",
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(
      out.stderr,
      /HALT-AND-REPORT/,
      `expected halt; stderr=${out.stderr}`,
    );
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.ok(validation, "hookSpecificOutput.validation missing");
    assert.match(validation, /sig/i, "halt reason should cite missing sig");
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

test("operator_gate_rejects_forged_gate_approval_sig", () => {
  // MED-1: cocSign.verify rejects sig that doesn't validate over canonical bytes.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    // Generate a structurally-valid SSH signature over different bytes.
    const { canonicalSerialize, sign } = require(COC_SIGN);
    const forgedR = sign(canonicalSerialize({ different: "bytes" }), {
      keyType: "ssh",
      keyPath: bob.keyPath,
    });
    assert.ok(forgedR.ok, "should produce forged sig over different bytes");
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "bob",
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-test-002",
      ts: new Date().toISOString(),
      forgeSig: forgedR.sig,
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: "n-test-002",
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(
      validation,
      /verify|signature/i,
      "halt reason should cite signature failure",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

test("operator_gate_resolves_approver_from_roster_not_payload", () => {
  // MED-1: attacker payload claims approver_role:"owner" but roster says "contributor".
  // The hook MUST consult the roster-resolved person, not the attacker-controlled claim.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:contrib-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey, {
        role: "contributor",
      }),
    });
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:contrib-bravo",
      approverGhLogin: "bob",
      approverRole: "owner", // ← attacker claim
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-test-003",
      ts: new Date().toISOString(),
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: "n-test-003",
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(
      validation,
      /role|eligib|contributor/i,
      "halt reason should cite roster-resolved role insufficient",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

// ---- MED-2: nonce / target_tool / TTL ---------------------------------------

test("operator_gate_verifies_nonce_matches_requester", () => {
  // MED-2: gate_approval.consumed_nonce MUST equal tool_input.requester_nonce.
  // If they differ, the approval was minted for a different invocation.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "bob",
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-OLD-INVOCATION",
      ts: new Date().toISOString(),
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: "n-NEW-INVOCATION", // ← mismatch
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(
      validation,
      /nonce|consumed/i,
      "halt reason should cite nonce mismatch",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

test("operator_gate_rejects_target_tool_mismatch", () => {
  // MED-2: gate_approval signed over target_tool="release" cannot authorize
  // /posture upgrade.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "bob",
      targetTool: "release", // ← signed for release
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-test-005",
      ts: new Date().toISOString(),
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/posture upgrade --to L5", // ← but invoked against posture-upgrade
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: "n-test-005",
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(
      validation,
      /target_tool|target tool|cross.surface|mismatch/i,
      "halt reason should cite target_tool mismatch",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

test("operator_gate_rejects_expired_gate_approval", () => {
  // MED-2: gate_approval.ts older than 24h is rejected.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    const expiredTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "bob",
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-test-006",
      ts: expiredTs,
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: "n-test-006",
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(
      validation,
      /expired|stale|ttl|older/i,
      "halt reason should cite TTL expiry",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

// ---- MED-3: gate-approval fold predicate -----------------------------------

test("gate_approval_predicate_validates_target_tool_allowlist", () => {
  // MED-3: fold predicate refuses gate-approval with unknown target_tool.
  const { createEngine } = require(COORDINATION_LOG);
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    const engine = createEngine();
    // Build a gate-approval record with target_tool="unknown-target".
    const coreNoSig = {
      type: "gate-approval",
      verified_id: alice.fingerprint,
      person_id: "person:owner-alpha",
      seq: 0,
      prev_hash: null,
      ts: new Date().toISOString(),
      content: {
        target_tool: "unknown-target", // ← not in allowlist
        consumed_nonce: "n-unknown-001",
        requester_verified_id: alice.fingerprint,
        requester_person_id: "person:owner-alpha",
        co_signers: [],
      },
    };
    const { co_signers, ...contentForCoSig } = coreNoSig.content;
    const baseForCoSig = { ...coreNoSig, content: contentForCoSig };
    const cosigBytes = canonicalSerialize(baseForCoSig);
    const cosigR = sign(cosigBytes, { keyType: "ssh", keyPath: bob.keyPath });
    assert.ok(cosigR.ok);
    coreNoSig.content.co_signers.push({
      verified_id: bob.fingerprint,
      sig: cosigR.sig,
    });
    const sigR = sign(canonicalSerialize(coreNoSig), {
      keyType: "ssh",
      keyPath: alice.keyPath,
    });
    assert.ok(sigR.ok);
    const record = { ...coreNoSig, sig: sigR.sig };
    const result = engine.foldLog([record], roster, {});
    const accepted = result.accepted.find((r) => r.type === "gate-approval");
    assert.equal(
      accepted,
      undefined,
      "unknown target_tool MUST NOT be accepted",
    );
    const rejected = result.rejected.find(
      (r) => r.record && r.record.type === "gate-approval",
    );
    assert.ok(rejected, "expected rejection entry");
    assert.match(
      rejected.reason,
      /target_tool|allowlist/i,
      "rejection reason should cite target_tool allowlist",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

test("gate_approval_predicate_refuses_nonce_collision", () => {
  // MED-3: second gate-approval with same consumed_nonce is rejected.
  const { createEngine } = require(COORDINATION_LOG);
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  const carol = mkEphemeralSshKey("carol");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
      "person:owner-carol": ownerPerson("carol", carol.fingerprint, carol.pubKey),
    });
    const engine = createEngine();
    const sharedNonce = "n-shared-007";
    const buildRec = (cosigner, seq, ts) => {
      const coreNoSig = {
        type: "gate-approval",
        verified_id: alice.fingerprint,
        person_id: "person:owner-alpha",
        seq,
        prev_hash: seq === 0 ? null : "placeholder", // overridden below for seq>0
        ts,
        content: {
          target_tool: "release",
          consumed_nonce: sharedNonce,
          requester_verified_id: alice.fingerprint,
          requester_person_id: "person:owner-alpha",
          co_signers: [],
        },
      };
      const { co_signers, ...contentForCoSig } = coreNoSig.content;
      const baseForCoSig = { ...coreNoSig, content: contentForCoSig };
      const cosigR = sign(canonicalSerialize(baseForCoSig), {
        keyType: "ssh",
        keyPath: cosigner.keyPath,
      });
      coreNoSig.content.co_signers.push({
        verified_id: cosigner.fingerprint,
        sig: cosigR.sig,
      });
      const sigR = sign(canonicalSerialize(coreNoSig), {
        keyType: "ssh",
        keyPath: alice.keyPath,
      });
      return { ...coreNoSig, sig: sigR.sig };
    };
    const rec0 = buildRec(bob, 0, "2026-05-20T00:00:00Z");
    // Wire prev_hash for rec1 to match canonical content hash of rec0.
    const recCoreHash = (() => {
      const { sig, ...core } = rec0;
      return crypto
        .createHash("sha256")
        .update(canonicalSerialize(core))
        .digest("hex");
    })();
    const rec1Pre = {
      type: "gate-approval",
      verified_id: alice.fingerprint,
      person_id: "person:owner-alpha",
      seq: 1,
      prev_hash: recCoreHash,
      ts: "2026-05-20T01:00:00Z",
      content: {
        target_tool: "release",
        consumed_nonce: sharedNonce, // ← same as rec0
        requester_verified_id: alice.fingerprint,
        requester_person_id: "person:owner-alpha",
        co_signers: [],
      },
    };
    const { co_signers: _cs, ...contentForCoSig1 } = rec1Pre.content;
    const baseForCoSig1 = { ...rec1Pre, content: contentForCoSig1 };
    const cosig1 = sign(canonicalSerialize(baseForCoSig1), {
      keyType: "ssh",
      keyPath: carol.keyPath,
    });
    rec1Pre.content.co_signers.push({
      verified_id: carol.fingerprint,
      sig: cosig1.sig,
    });
    const sig1 = sign(canonicalSerialize(rec1Pre), {
      keyType: "ssh",
      keyPath: alice.keyPath,
    });
    const rec1 = { ...rec1Pre, sig: sig1.sig };

    const result = engine.foldLog([rec0, rec1], roster, {});
    const acceptedGates = result.accepted.filter(
      (r) => r.type === "gate-approval",
    );
    assert.equal(
      acceptedGates.length,
      1,
      `expected only first gate-approval to fold; accepted=${acceptedGates.length}`,
    );
    const rejected = result.rejected.find(
      (r) =>
        r.record &&
        r.record.type === "gate-approval" &&
        r.record.seq === 1,
    );
    assert.ok(rejected, "expected second gate-approval to be rejected");
    assert.match(
      rejected.reason,
      /consumed_nonce|nonce|already/i,
      "rejection should cite nonce collision",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
    cleanup(carol.dir);
  }
});

// ---- MED-4: case-insensitive R5-S-07 ---------------------------------------

test("case_folded_collaborator_login_caught_R5_S_07", () => {
  // MED-4: requester "Alice" + approver "alice" → same bound collaborator
  // after lowercase-normalization → R5-S-07 violation.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson(
        "Alice",
        alice.fingerprint,
        alice.pubKey,
      ),
      "person:owner-bravo": ownerPerson(
        "alice",
        bob.fingerprint,
        bob.pubKey,
      ),
    });
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "alice",
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: "n-test-008",
      ts: new Date().toISOString(),
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "Alice", // ← capital A
        requester_nonce: "n-test-008",
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(
      validation,
      /collaborator|R5-S-07/i,
      "halt reason should cite collaborator distinctness",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

test("gate_matrix_lowercase_normalizes_gh_login_comparison", () => {
  // MED-4 unit: gate-matrix._sameBoundCollaborator MUST be case-insensitive.
  const { evaluateGate } = require(GATE_MATRIX);
  const verdict = evaluateGate({
    gate: "release",
    requester: { person_id: "person:A", gh_login: "Alice" },
    approver: { person_id: "person:B", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: null,
    foldedState: null,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /collaborator|R5-S-07/i);
});

test("derive_n_lowercase_normalizes_login_keys", () => {
  // MED-4 unit: derive-n.computeDerivedN MUST treat candidateLogins case-insensitively.
  const { computeDerivedN } = require(DERIVE_N);
  // Two roster owners with same gh_login under different cases should not
  // both count as distinct logins.
  const roster = {
    persons: {
      "person:A": {
        role: "owner",
        host_role: "human",
        github_login: "Alice",
        keys: [],
      },
      "person:B": {
        role: "owner",
        host_role: "human",
        github_login: "alice",
        keys: [],
      },
    },
  };
  const out = computeDerivedN({ roster, log: [], trustRoot: null });
  // Both candidate logins lowercase-normalize to "alice"; only one distinct
  // login emerges in candidateLogins after normalization.
  // (Without trust-root binding neither attests, so derived_N is 0 either way;
  //  the structural check is that the live_logins set is case-folded.)
  assert.ok(
    out.live_logins.every((l) => l === l.toLowerCase()),
    `live_logins must be lowercase-normalized; got ${JSON.stringify(out.live_logins)}`,
  );
});

// ---- LOW-2 + LOW-3: posture-gate hardening ----------------------------------

test("multiedit_posture_json_blocked", () => {
  const out = runHook(POSTURE_GATE_PATH, {
    hook_event_name: "PreToolUse",
    tool_name: "MultiEdit",
    tool_input: {
      file_path: ".claude/learning/posture.json",
      edits: [{ old_string: "L1", new_string: "L5" }],
    },
    cwd: REPO_ROOT,
  });
  assert.match(out.stderr, /HALT-AND-REPORT/);
});

test("notebookedit_posture_json_blocked", () => {
  const out = runHook(POSTURE_GATE_PATH, {
    hook_event_name: "PreToolUse",
    tool_name: "NotebookEdit",
    tool_input: {
      file_path: ".claude/learning/posture.json",
      new_source: "{}",
    },
    cwd: REPO_ROOT,
  });
  assert.match(out.stderr, /HALT-AND-REPORT/);
});

test("settings_json_deny_covers_multiedit_and_notebookedit", () => {
  const raw = fs.readFileSync(SETTINGS_JSON, "utf8");
  const settings = JSON.parse(raw);
  const deny = (settings.permissions && settings.permissions.deny) || [];
  assert.ok(
    deny.some((d) => /MultiEdit\([^)]*posture\.json/.test(d)),
    "settings deny MUST cover MultiEdit on posture.json",
  );
  assert.ok(
    deny.some((d) => /MultiEdit\([^)]*violations\.jsonl/.test(d)),
    "settings deny MUST cover MultiEdit on violations.jsonl",
  );
  assert.ok(
    deny.some((d) => /NotebookEdit\([^)]*posture\.json/.test(d)),
    "settings deny MUST cover NotebookEdit on posture.json",
  );
});

test("realpath_traversal_caught", () => {
  // LOW-3: ../.. path traversal targeting posture.json must be normalized
  // before regex testing; the secondary fence catches the normalized path.
  // We use a path that the realpath best-effort walker will normalize:
  //   .claude/foo/../learning/posture.json → .claude/learning/posture.json
  const out = runHook(POSTURE_GATE_PATH, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(
        REPO_ROOT,
        ".claude/foo-nonexistent/../learning/posture.json",
      ),
    },
    cwd: REPO_ROOT,
  });
  assert.match(
    out.stderr,
    /HALT-AND-REPORT/,
    `realpath traversal MUST be caught; stderr=${out.stderr}`,
  );
});

// ---- gate-approval lib structure -------------------------------------------

test("gate_approval_lib_exists_with_canonical_bytes_builder", () => {
  // The new lib module ships canonical-bytes builder + verifier per shard.
  assert.ok(fs.existsSync(GATE_APPROVAL_LIB), "gate-approval.js MUST exist");
  const ga = require(GATE_APPROVAL_LIB);
  assert.equal(
    typeof ga.canonicalGateApprovalBytes,
    "function",
    "must export canonicalGateApprovalBytes",
  );
  assert.equal(
    typeof ga.verifyGateApproval,
    "function",
    "must export verifyGateApproval",
  );
  assert.equal(
    typeof ga.GATE_APPROVAL_TTL_MS,
    "number",
    "must export GATE_APPROVAL_TTL_MS",
  );
  assert.equal(
    ga.GATE_APPROVAL_TTL_MS,
    24 * 60 * 60 * 1000,
    "TTL must be 24 hours",
  );
  assert.equal(
    typeof ga.TARGET_TOOL_ALLOWLIST,
    "object",
    "must export TARGET_TOOL_ALLOWLIST",
  );
});

test("gate_approval_pre_flight_round_trip", () => {
  // End-to-end: requester emits nonce → approver signs over canonical bytes
  // → operator-gate verifies → passthrough.
  const alice = mkEphemeralSshKey("alice");
  const bob = mkEphemeralSshKey("bob");
  try {
    const roster = makeRoster({
      "person:owner-alpha": ownerPerson("alice", alice.fingerprint, alice.pubKey),
      "person:owner-bravo": ownerPerson("bob", bob.fingerprint, bob.pubKey),
    });
    const nonce = "n-roundtrip-009";
    const ga = buildGateApproval({
      approverKey: bob,
      approverPersonId: "person:owner-bravo",
      approverGhLogin: "bob",
      targetTool: "release",
      requesterPersonId: "person:owner-alpha",
      requesterVerifiedId: alice.fingerprint,
      consumedNonce: nonce,
      ts: new Date().toISOString(),
    });
    const out = runHook(HOOK_PATH, {
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: nonce,
        gate_approval: ga,
        roster,
      },
      cwd: REPO_ROOT,
    });
    assert.equal(out.code, 0, `expected passthrough; stderr=${out.stderr}`);
    assert.equal(
      out.json && out.json.continue,
      true,
      "happy-path round-trip must passthrough",
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});

// ---- mechanical sweeps ------------------------------------------------------

test("operator_gate_calls_cocSign_verify", () => {
  const src = fs.readFileSync(HOOK_PATH, "utf8");
  assert.ok(
    /cocSign\.verify|cocVerify|verifyGateApproval/.test(src),
    "operator-gate.js MUST call cocSign.verify (directly or via lib)",
  );
});

test("operator_gate_contains_nonce_binding_logic", () => {
  const opGateSrc = fs.readFileSync(HOOK_PATH, "utf8");
  const gaLibSrc = fs.existsSync(GATE_APPROVAL_LIB)
    ? fs.readFileSync(GATE_APPROVAL_LIB, "utf8")
    : "";
  const combined = opGateSrc + "\n" + gaLibSrc;
  assert.ok(
    /consumed_nonce|consumedNonce/.test(combined),
    "MUST reference consumed_nonce binding",
  );
});

test("gate_matrix_normalizes_gh_login_case_insensitively", () => {
  // F14 C2 iter-3: source-grep replaced with structural assertion of
  // helper routing. Behavioral regression: must use loginsEqual()
  // from lib/github-login.js (SSOT). Per rules/testing.md § Behavioral
  // Regression Tests Over Source-Grep.
  const src = fs.readFileSync(GATE_MATRIX, "utf8");
  assert.ok(
    /loginsEqual\s*\(|toLowerCase\(\)/.test(src),
    "gate-matrix.js MUST lowercase-normalize gh_login (via loginsEqual helper or inline toLowerCase)",
  );
});

test("derive_n_normalizes_gh_login_case_insensitively", () => {
  // F14 C2 iter-3: helper-based routing also accepted.
  const src = fs.readFileSync(DERIVE_N, "utf8");
  assert.ok(
    /normalizeLogin\s*\(|loginsEqual\s*\(|toLowerCase\(\)/.test(src),
    "derive-n.js MUST lowercase-normalize gh_login keys (via normalizeLogin helper or inline toLowerCase)",
  );
});

test("posture_gate_covers_multiedit_and_notebookedit", () => {
  const src = fs.readFileSync(POSTURE_GATE_PATH, "utf8");
  assert.ok(
    /MultiEdit/.test(src),
    "posture-gate.js MUST reference MultiEdit",
  );
  assert.ok(
    /NotebookEdit/.test(src),
    "posture-gate.js MUST reference NotebookEdit",
  );
});

test("posture_gate_realpath_normalizes_file_path", () => {
  const src = fs.readFileSync(POSTURE_GATE_PATH, "utf8");
  assert.ok(
    /realpathSync|realpath/.test(src),
    "posture-gate.js MUST realpath-normalize file_path before regex match",
  );
});
