/**
 * Tier-2 integration tests for shard C2 (workspaces/multi-operator-coc,
 * design v11 §4.3 + §6.4) — the operator-gate.js hook.
 *
 * Tests at: tests/integration/multi-operator/operator-gate.test.js
 *
 * Per the shard contract (workspaces/multi-operator-coc/todos/active/
 * 00-todos.md § C2):
 *
 *   (1) operator-gate.js: resolves signed gate-approval key → person_id,
 *       rejects iff approver == requester OR (owner/senior gates) same
 *       bound GitHub-collaborator login (R5-S-07); host_role:ci NEVER
 *       eligible (R5-S-04); degenerate self-sign rows fire only when
 *       N=1 is *derived* current-attestation fact, never self-reported.
 *
 * Hook is invoked as a subprocess (real CC PreToolUse JSON in, JSON out).
 *
 * Run: node --test tests/integration/multi-operator/operator-gate.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "operator-gate.js");
const FIXTURES_DIR = path.join(REPO_ROOT, ".claude", "audit-fixtures", "operator-gate");
const COC_SIGN = path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js");

// F14 MED-1 + MED-2: gate_approval payloads now carry a real signed
// signature over canonical bytes. Helpers to mint ephemeral keys + build
// a verifying payload for the 4-eyes happy-path and self-approval tests.

function _mkKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2-test-${label}-`));
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fpOut = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    encoding: "utf8",
  });
  const m = fpOut.match(/SHA256:[A-Za-z0-9+/=]+/);
  return { dir, keyPath, pubKey: pub, fingerprint: m[0] };
}

function _cleanupKey(k) {
  try {
    fs.rmSync(k.dir, { recursive: true, force: true });
  } catch {}
}

function _signGateApproval(approverKey, fields) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  // iter-2 Sec-MED-2: canonical bytes now bind approver_verified_id.
  const signed = {
    target_tool: fields.target_tool,
    requester_person_id: fields.requester_person_id,
    requester_verified_id: fields.requester_verified_id,
    approver_verified_id: approverKey.fingerprint,
    consumed_nonce: fields.consumed_nonce,
    ts: fields.ts,
  };
  const r = sign(canonicalSerialize(signed), {
    keyType: "ssh",
    keyPath: approverKey.keyPath,
  });
  if (!r.ok) throw new Error(`sign failed: ${r.error}`);
  return r.sig;
}

function _ownerPerson(login, fp, pub) {
  return {
    display_id: login,
    role: "owner",
    github_login: login,
    host_role: "human",
    keys: [{ type: "ssh", fingerprint: fp, pubkey: pub }],
  };
}

function runHook(payload) {
  const result = spawnSync("node", [HOOK_PATH], {
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

// ---- audit fixtures presence ------------------------------------------------

test("audit_fixtures_directory_has_one_per_scope_restriction_predicate", () => {
  // Per cc-artifacts.md Rule 9 + hook-output-discipline.md MUST-4.
  // Required: one fixture per predicate the hook relies on.
  const required = [
    "clean-self-approvable-todos.txt",
    "flag-self-approval-release.txt",
    "flag-same-collaborator-owner-gate.txt",
    "flag-ci-host-role.txt",
    "clean-degenerate-self-sign-derived-n1.txt",
    "flag-degenerate-self-sign-under-r9s02.txt",
    "skip-shell-variable-trigger.txt",
  ];
  for (const f of required) {
    const p = path.join(FIXTURES_DIR, f);
    assert.ok(fs.existsSync(p), `audit fixture missing: ${p}`);
  }
});

// ---- hook output discipline -------------------------------------------------

test("operator_gate_passthrough_on_non_trigger_commands", () => {
  // Bash command unrelated to any gate trigger — should passthrough.
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
    cwd: REPO_ROOT,
  });
  assert.equal(out.code, 0, `exit 0 expected; stderr=${out.stderr}`);
  assert.equal(out.json && out.json.continue, true);
});

test("operator_gate_emits_canonical_instruct_and_wait_shape_on_every_halt", () => {
  // /release with self-sign → halt-and-report w/ all 6 fields.
  // Per instruct-and-wait.js: halt-and-report sets continue=true on PreToolUse
  // (CC's flow continues) but surfaces the structured handoff to the agent.
  // Only severity=block sets continue=false (and exit 2).
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "SlashCommand",
    tool_input: {
      command: "/release",
      requester_person_id: "person:owner-alpha",
      gate_approval: {
        approver_person_id: "person:owner-alpha", // self-sign → reject
        approver_gh_login: "alice",
      },
      requester_gh_login: "alice",
    },
    cwd: REPO_ROOT,
  });
  assert.equal(out.code, 0, "halt-and-report exits 0 per instruct-and-wait shape");
  const validation =
    out.json && out.json.hookSpecificOutput && out.json.hookSpecificOutput.validation;
  assert.ok(validation, "hookSpecificOutput.validation missing");
  // All 6 fields surfaced in the canonical body.
  assert.match(validation, /WHAT HAPPENED:/);
  assert.match(validation, /WHY:/);
  assert.match(validation, /REPORT TO USER/);
  assert.match(validation, /THEN:/);
  // Validation body MUST cite the rule_id + remediation.
  assert.match(validation, /operator-gate/);
  // user_summary lands on stderr.
  assert.match(out.stderr, /\[HALT-AND-REPORT\]/i);
});

test("zero_raw_process_exit_in_operator_gate_source", () => {
  // hook-output-discipline.md MUST-1 mechanical sweep:
  // grep process.exit([12]) in operator-gate.js — every hit MUST be either
  // (a) the timeout-fallback comment, or (b) the structured exit via emit().
  const source = fs.readFileSync(HOOK_PATH, "utf8");
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/process\.exit\(([12])\)/);
    if (!m) continue;
    // Acceptable: the line is within 3 lines of a comment containing "TIMEOUT" or "timeout fallback"
    // OR within a setTimeout(...) callback.
    const window = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
    const isTimeoutFallback =
      /TIMEOUT_MS|setTimeout|timeout fallback|fallback timeout/i.test(window);
    assert.ok(
      isTimeoutFallback,
      `process.exit(${m[1]}) at line ${i + 1} is not a timeout fallback — violates hook-output-discipline.md MUST-1`,
    );
  }
});

test("lexical_regex_on_command_string_emits_halt_and_report_not_block", () => {
  // hook-output-discipline.md MUST-2 — the trigger detection is lexical
  // (slash-command-name match), so the resulting severity MUST be
  // halt-and-report, NEVER block. Probe the hook with a flag-able scenario
  // and confirm exit code 0 (halt-and-report) — only severity=block exits 2.
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "SlashCommand",
    tool_input: {
      command: "/release",
      requester_person_id: "person:owner-alpha",
      gate_approval: {
        approver_person_id: "person:owner-alpha",
        approver_gh_login: "alice",
      },
      requester_gh_login: "alice",
    },
    cwd: REPO_ROOT,
  });
  // halt-and-report exits 0; only block exits 2. Confirm NOT block.
  assert.equal(out.code, 0, `expected exit 0 (halt-and-report), got ${out.code}`);
  // The stderr line carries the HALT-AND-REPORT tag (not BLOCK).
  assert.match(out.stderr, /HALT-AND-REPORT/);
  assert.doesNotMatch(out.stderr, /\[BLOCK\]/);
});

test("shell_variable_in_command_string_skipped", () => {
  // hook-output-discipline.md MUST-3 — command-string detectors MUST skip
  // shell-variable references. A Bash command of `eval "$CMD"` cannot be
  // evaluated at hook time and MUST return null (passthrough).
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'eval "$CMD"' },
    cwd: REPO_ROOT,
  });
  assert.equal(out.code, 0);
  assert.equal(out.json && out.json.continue, true);
});

test("command_substitution_in_command_string_skipped", () => {
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: '$(./helpers/release-helper.sh)' },
    cwd: REPO_ROOT,
  });
  assert.equal(out.code, 0);
  assert.equal(out.json && out.json.continue, true);
});

// ---- 4-eyes invariant -------------------------------------------------------

test("self_approval_release_rejected", () => {
  // F14 MED-1+MED-2: payload now carries a real verifying signature so
  // the verifyGateApproval check passes; then the gate-matrix's 4-eyes
  // check fires on the self-approval (requester == approver person_id).
  const alice = _mkKey("alice-self");
  try {
    const nonce = "n-self-001";
    const ts = new Date().toISOString();
    const sig = _signGateApproval(alice, {
      target_tool: "release",
      requester_person_id: "person:owner-alpha",
      requester_verified_id: alice.fingerprint,
      consumed_nonce: nonce,
      ts,
    });
    const out = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: nonce,
        roster: {
          genesis: {
            repo_owner: "alice",
            repo_owner_kind: "user",
            root_commit: "r",
            genesis_generation: 0,
          },
          persons: {
            "person:owner-alpha": _ownerPerson(
              "alice",
              alice.fingerprint,
              alice.pubKey,
            ),
          },
        },
        gate_approval: {
          approver_person_id: "person:owner-alpha",
          approver_verified_id: alice.fingerprint,
          approver_gh_login: "alice",
          approver_role: "owner",
          approver_host_role: "human",
          target_tool: "release",
          consumed_nonce: nonce,
          ts,
          sig,
        },
      },
      cwd: REPO_ROOT,
    });
    assert.match(out.stderr, /HALT-AND-REPORT/);
    assert.match(out.stderr, /operator-gate halted release/);
    const validation =
      out.json &&
      out.json.hookSpecificOutput &&
      out.json.hookSpecificOutput.validation;
    assert.match(validation, /self-approval|4-eyes/);
  } finally {
    _cleanupKey(alice);
  }
});

test("distinct_approver_release_allowed", () => {
  // F14 MED-1+MED-2: real signed gate_approval from a distinct owner;
  // happy-path passthrough.
  const alice = _mkKey("alice-happy");
  const bob = _mkKey("bob-happy");
  try {
    const nonce = "n-distinct-001";
    const ts = new Date().toISOString();
    const sig = _signGateApproval(bob, {
      target_tool: "release",
      requester_person_id: "person:owner-alpha",
      requester_verified_id: alice.fingerprint,
      consumed_nonce: nonce,
      ts,
    });
    const out = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: {
        command: "/release",
        requester_person_id: "person:owner-alpha",
        requester_verified_id: alice.fingerprint,
        requester_gh_login: "alice",
        requester_nonce: nonce,
        roster: {
          genesis: {
            repo_owner: "alice",
            repo_owner_kind: "user",
            root_commit: "r",
            genesis_generation: 0,
          },
          persons: {
            "person:owner-alpha": _ownerPerson(
              "alice",
              alice.fingerprint,
              alice.pubKey,
            ),
            "person:owner-bravo": _ownerPerson(
              "bob",
              bob.fingerprint,
              bob.pubKey,
            ),
          },
        },
        gate_approval: {
          approver_person_id: "person:owner-bravo",
          approver_verified_id: bob.fingerprint,
          approver_gh_login: "bob",
          approver_role: "owner",
          approver_host_role: "human",
          target_tool: "release",
          consumed_nonce: nonce,
          ts,
          sig,
        },
      },
      cwd: REPO_ROOT,
    });
    assert.equal(out.code, 0);
    assert.equal(out.json && out.json.continue, true);
  } finally {
    _cleanupKey(alice);
    _cleanupKey(bob);
  }
});

// ---- timeout fallback -------------------------------------------------------

test("operator_gate_has_setTimeout_fallback", () => {
  // cc-artifacts.md Rule 7 — every hook MUST include a setTimeout fallback
  // that returns {continue: true} and exits.
  const source = fs.readFileSync(HOOK_PATH, "utf8");
  assert.match(source, /setTimeout/, "operator-gate.js missing setTimeout fallback");
  assert.match(source, /continue:\s*true/, "fallback MUST return continue:true");
});
