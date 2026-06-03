/**
 * Tier-2 integration tests for F14 C2-auth-hardening iter-2 shard.
 *
 * /redteam R2 against PR #316 surfaced same-bug-class siblings that the
 * iter-1 fixes missed. Per autonomous-execution.md MUST Rule 4, fix in-shard.
 *
 *   HIGH-1  coordination-log.test.js:1149 asserts r.derivedN.live_logins
 *           includes "owner-A" (mixed case). PR #316 lowercased derive-n
 *           outputs but missed this legacy test → pre-existing test failure
 *           on main (zero-tolerance Rule 1 + 1a).
 *
 *   HIGH-2  integrity-guard.js::isWatchedTool only accepts Edit/Write.
 *           MultiEdit + NotebookEdit bypass the integrity fence entirely
 *           (same bug class as PR #316 LOW-2 closed on posture-gate.js).
 *
 *   MED-1   genesis-ceremony.js:93 `person.github_login !== targetLogin`
 *           is case-sensitive (sibling of PR #316 MED-4).
 *
 *   MED-2   owner-depart-ceremony.js:161 `entry.login === params.departingLogin`
 *           is case-sensitive (sibling of PR #316 MED-4).
 *
 *   Sec-MED-1  Bash rm/mv deny patterns covered posture* + violations* but
 *              not the .initialized init marker; an attacker who removes
 *              the marker downgrades the fresh-vs-corrupt distinction
 *              (trust-posture MUST Rule 2).
 *
 *   Sec-MED-2  approver_verified_id absent from canonical signed bytes —
 *              the verifier already enforces it via roster lookup, so the
 *              swap is structurally rejected, but adding the field to
 *              canonical bytes is defense-in-depth: the contract explicitly
 *              binds approver identity.
 *
 *   Sec-MED-4  Bash deny patterns covered rm/mv but not shell-redirection
 *              vectors (cp/tee/sed/echo) targeting posture* / violations*.
 *
 * Run via:
 *   node --test tests/integration/multi-operator/c2-auth-hardening-iter2.test.js
 *
 * Tier-2 discipline: real ssh-keygen + real coc-sign verify; no mocking
 * of crypto / fold semantics (rules/testing.md § Tier 2).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOK_INTEGRITY_GUARD = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "integrity-guard.js",
);
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const GATE_APPROVAL_LIB = path.join(LIB_DIR, "gate-approval.js");
const GENESIS_CEREMONY = path.join(LIB_DIR, "genesis-ceremony.js");
const OWNER_DEPART_CEREMONY = path.join(LIB_DIR, "owner-depart-ceremony.js");
const SETTINGS_JSON = path.join(REPO_ROOT, ".claude", "settings.json");
const DERIVE_N = path.join(LIB_DIR, "derive-n.js");
const ENGINE = path.join(LIB_DIR, "coordination-log.js");

// ---- ephemeral key fixtures ------------------------------------------------

function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-c2i2-${label}-`));
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
    `coc-c2i2-test-${label}`,
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

function runHook(hookPath, payload) {
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
  });
  let stdoutJson = null;
  try {
    const trimmed = result.stdout.trim();
    if (trimmed) stdoutJson = JSON.parse(trimmed.split("\n").pop());
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

// ============================================================================
// HIGH-1 — coordination-log live_logins lowercase invariant (regression)
// ============================================================================

test("coordination_log_live_logins_lowercase_assertion", () => {
  // Regression for HIGH-1. derive-n.js lowercases github_login values into
  // live_logins; the assertion in coordination-log.test.js was authored
  // pre-PR-#316 (mixed case "owner-A") and was the only legacy test
  // missed in the PR #316 case-norm sweep. This test exercises the
  // SAME engine path (foldLog + derive-n) and pins the invariant
  // directly so a future refactor that re-introduces case-sensitivity
  // is caught here even if the legacy test moves or changes shape.
  const { foldLog } = require(ENGINE);
  const { signRecord, signKeyMkEphemeral, signKeyCleanup } = (() => {
    // Inline minimal sign harness matching coordination-log.test.js shape.
    const { canonicalSerialize, sign } = require(COC_SIGN);
    function mkKey(label) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-i2-${label}-`));
      const kp = path.join(dir, "id_ed25519");
      execFileSync("ssh-keygen", [
        "-t",
        "ed25519",
        "-N",
        "",
        "-q",
        "-f",
        kp,
        "-C",
        `coc-i2-${label}`,
      ]);
      const pub = fs.readFileSync(`${kp}.pub`, "utf8").trim();
      const fpOut = execFileSync("ssh-keygen", ["-lf", `${kp}.pub`], {
        encoding: "utf8",
      });
      const m = fpOut.match(/SHA256:[A-Za-z0-9+/=]+/);
      return { dir, keyPath: kp, pubKey: pub, fingerprint: m[0] };
    }
    function cleanupK(dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    function signRec(rec, keyPath) {
      const bytes = canonicalSerialize(rec);
      const r = sign(bytes, { keyType: "ssh", keyPath });
      if (!r.ok) throw new Error(`sign failed: ${r.error}`);
      return { ...rec, sig: r.sig };
    }
    return {
      signRecord: signRec,
      signKeyMkEphemeral: mkKey,
      signKeyCleanup: cleanupK,
    };
  })();

  const k = signKeyMkEphemeral("owner-mixedcase");
  try {
    const roster = {
      genesis: {
        repo_owner: "OWNER-A",
        repo_owner_kind: "user",
        root_commit: "abc123",
        genesis_generation: 0,
      },
      persons: {
        "person:owner-alpha": {
          display_id: "alpha",
          role: "owner",
          // Mixed-case github_login in roster MUST be lowercased through
          // the live_logins derivation.
          github_login: "OWNER-A",
          host_role: "human",
          keys: [{ type: "ssh", fingerprint: k.fingerprint, pubkey: k.pubKey }],
        },
      },
    };
    const anchorCore = {
      type: "genesis-anchor",
      person_id: "person:owner-alpha",
      verified_id: k.fingerprint,
      seq: 0,
      prev_hash: null,
      ts: "2025-01-01T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "OWNER-A",
          repo_owner_kind: "user",
          root_commit: "abc123",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "OWNER-A", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123", verified: true },
      },
    };
    const anchor = signRecord(anchorCore, k.keyPath);
    const r = foldLog([anchor], roster, {});
    assert.ok(r.derivedN, "derivedN computed");
    assert.equal(
      r.derivedN.derived_N,
      1,
      "lone owner counts via R9-A-03 (anchor IS the basis)",
    );
    // Hard contract: live_logins MUST be lowercase regardless of source case.
    assert.ok(
      r.derivedN.live_logins.includes("owner-a"),
      `live_logins MUST contain lowercased 'owner-a'; got ${JSON.stringify(
        r.derivedN.live_logins,
      )}`,
    );
    assert.ok(
      !r.derivedN.live_logins.includes("OWNER-A"),
      "live_logins MUST NOT contain mixed-case 'OWNER-A'",
    );
  } finally {
    signKeyCleanup(k.dir);
  }
});

// ============================================================================
// HIGH-2 — integrity-guard.js extends to MultiEdit + NotebookEdit
// ============================================================================

function setupFixtureMainCheckout(label) {
  // Synthesize a minimal git checkout containing the watched paths so the
  // integrity-guard hook (which resolves the main checkout via
  // git-worktree-list / CLAUDE_TRUST_STATE_DIR) can run end-to-end against
  // a controlled tmpdir instead of the real loom worktree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-i2-mc-${label}-`));
  // Init a real git repo so resolveActiveBranch returns a non-codify branch.
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"], {});
  execFileSync("git", ["-C", dir, "config", "user.name", "t"], {});
  // Seed minimal .claude state.
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "operators.roster.json"),
    JSON.stringify({ persons: {} }),
  );
  fs.writeFileSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
    "",
  );
  // Commit so HEAD resolves cleanly.
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

function runIntegrityGuardWithFixture(fixtureDir, payload) {
  const result = spawnSync("node", [HOOK_INTEGRITY_GUARD], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_TRUST_STATE_DIR: path.join(fixtureDir, ".claude", "learning"),
    },
    cwd: fixtureDir,
  });
  let stdoutJson = null;
  try {
    const trimmed = (result.stdout || "").trim();
    if (trimmed) stdoutJson = JSON.parse(trimmed.split("\n").pop());
  } catch {
    stdoutJson = null;
  }
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json: stdoutJson,
  };
}

test("integrity_guard_blocks_multiedit_on_roster", () => {
  // End-to-end: synthesize a main-checkout fixture, run hook against
  // MultiEdit on operators.roster.json from the default (non-codify)
  // branch. Pre-iter-2 the hook returned passthrough (watched:false)
  // because isWatchedTool only accepted Edit/Write.
  const fixture = setupFixtureMainCheckout("me-roster");
  try {
    const out = runIntegrityGuardWithFixture(fixture, {
      hook_event_name: "PreToolUse",
      tool_name: "MultiEdit",
      tool_input: {
        file_path: path.join(fixture, ".claude", "operators.roster.json"),
        edits: [{ old_string: "a", new_string: "b" }],
      },
      cwd: fixture,
    });
    // The hook MUST halt (exit-2, continue:false) on a non-codify branch
    // for a watched path. The pre-iter-2 hook would have returned
    // {continue:true} immediately at isWatchedTool because MultiEdit was
    // not in the watched-tool set.
    const halted = out.code === 2 || (out.json && out.json.continue === false);
    assert.ok(
      halted,
      `integrity-guard MUST halt MultiEdit on watched roster from non-codify branch; got code=${out.code}, json=${JSON.stringify(out.json)}, stderr=${out.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(fixture);
  }
});

test("integrity_guard_blocks_notebookedit_on_coordination_log", () => {
  // Same shape for NotebookEdit on coordination-log.jsonl.
  const fixture = setupFixtureMainCheckout("ne-coord");
  try {
    const out = runIntegrityGuardWithFixture(fixture, {
      hook_event_name: "PreToolUse",
      tool_name: "NotebookEdit",
      tool_input: {
        file_path: path.join(
          fixture,
          ".claude",
          "learning",
          "coordination-log.jsonl",
        ),
        new_source: "tampered",
      },
      cwd: fixture,
    });
    const halted = out.code === 2 || (out.json && out.json.continue === false);
    assert.ok(
      halted,
      `integrity-guard MUST halt NotebookEdit on watched coordination-log from non-codify branch; got code=${out.code}, json=${JSON.stringify(out.json)}, stderr=${out.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(fixture);
  }
});

test("integrity_guard_does_not_halt_unwatched_tool_on_watched_path", () => {
  // Negative-control: Read on a watched path MUST NOT halt — the hook's
  // watched-tool set covers only mutating tools (Edit/Write/MultiEdit/
  // NotebookEdit). This pins the false-positive surface area.
  const fixture = setupFixtureMainCheckout("read-control");
  try {
    const out = runIntegrityGuardWithFixture(fixture, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {
        file_path: path.join(fixture, ".claude", "operators.roster.json"),
      },
      cwd: fixture,
    });
    assert.equal(out.code, 0, "Read on watched path MUST NOT halt");
    assert.equal(out.json && out.json.continue, true, "Read MUST passthrough");
  } finally {
    cleanup(fixture);
  }
});

test("integrity_guard_source_extends_iswatchedtool_to_multiedit_and_notebookedit", () => {
  // Source-level structural invariant: the hook MUST reference both new
  // tool names in its watched-tool predicate. Defense against future
  // refactor reverting MultiEdit/NotebookEdit coverage.
  const src = fs.readFileSync(HOOK_INTEGRITY_GUARD, "utf8");
  assert.ok(
    /MultiEdit/.test(src),
    "integrity-guard.js MUST reference MultiEdit",
  );
  assert.ok(
    /NotebookEdit/.test(src),
    "integrity-guard.js MUST reference NotebookEdit",
  );
});

// ============================================================================
// settings.json — deny patterns cover MultiEdit / NotebookEdit / .initialized
// + shell-redirection vectors (HIGH-2 + Sec-MED-1 + Sec-MED-4)
// ============================================================================

function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8"));
}

test("settings_deny_covers_multiedit_on_roster", () => {
  const settings = readSettings();
  const denyList = settings.permissions.deny;
  assert.ok(
    denyList.some((p) => /MultiEdit\(.*operators\.roster\.json/.test(p)),
    `settings.json deny MUST cover MultiEdit on operators.roster.json; got ${JSON.stringify(denyList)}`,
  );
});

test("settings_deny_covers_notebookedit_on_coordination_log", () => {
  const settings = readSettings();
  const denyList = settings.permissions.deny;
  assert.ok(
    denyList.some((p) =>
      /NotebookEdit\(.*learning\/coordination-log\.jsonl/.test(p),
    ),
    `settings.json deny MUST cover NotebookEdit on coordination-log.jsonl; got ${JSON.stringify(denyList)}`,
  );
});

test("settings_deny_covers_multiedit_on_coordination_log", () => {
  const settings = readSettings();
  const denyList = settings.permissions.deny;
  assert.ok(
    denyList.some((p) =>
      /MultiEdit\(.*learning\/coordination-log\.jsonl/.test(p),
    ),
    `settings.json deny MUST cover MultiEdit on coordination-log.jsonl; got ${JSON.stringify(denyList)}`,
  );
});

test("settings_deny_covers_multiedit_and_notebookedit_on_posture_and_violations", () => {
  const settings = readSettings();
  const denyList = settings.permissions.deny;
  const requiredPatterns = [
    /MultiEdit\(.*learning\/posture\.json/,
    /MultiEdit\(.*learning\/violations\.jsonl/,
    /NotebookEdit\(.*learning\/posture\.json/,
    /NotebookEdit\(.*learning\/violations\.jsonl/,
  ];
  for (const rx of requiredPatterns) {
    assert.ok(
      denyList.some((p) => rx.test(p)),
      `settings.json deny missing pattern ${rx}; got ${JSON.stringify(denyList)}`,
    );
  }
});

test("initialized_marker_bash_mutation_blocked_by_hook", () => {
  // Sec-MED-1: `rm .claude/learning/.initialized` or `mv ... /tmp/...`
  // downgrades the fresh-vs-corrupt distinction (trust-posture MUST Rule 2):
  // without the marker, missing posture.json is treated as a fresh repo and
  // posture defaults to L5 instead of fail-closed to L1.
  //
  // F123: the per-verb Bash deny-matrix (Bash(rm:<state>), Bash(mv:<state>))
  // was removed from settings.json as structurally incompletable; the
  // authoritative Bash control is the path-based hook interceptor
  // validate-bash-command.js::detectStateFileMutation, which covers rm (F123
  // addition) + mv (pre-existing Layer 2) of .initialized regardless of verb.
  const validateBash = path.join(
    REPO_ROOT,
    ".claude",
    "hooks",
    "validate-bash-command.js",
  );
  const { detectStateFileMutation } = require(
    path.join(LIB_DIR, "violation-patterns.js"),
  );
  const src = fs.readFileSync(validateBash, "utf8");
  const m = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(m, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval -- reconstruct the source-controlled regex literal
  const rx = eval(m[1]);
  assert.ok(
    detectStateFileMutation("rm .claude/learning/.initialized", rx),
    "hook MUST flag `rm .claude/learning/.initialized` (Sec-MED-1)",
  );
  assert.ok(
    detectStateFileMutation("mv .claude/learning/.initialized /tmp/x", rx),
    "hook MUST flag `mv .claude/learning/.initialized` (Sec-MED-1)",
  );
});

test("shell_redirection_to_posture_and_violations_blocked_by_hook", () => {
  // Sec-MED-4: cp/tee/sed/echo redirection vectors against state files.
  // F123: the per-verb Bash deny-matrix was removed from settings.json as
  // structurally incompletable; the authoritative Bash control is the
  // path-based hook interceptor validate-bash-command.js::detectStateFileMutation,
  // which flags these vectors (cp Layer 2, tee/redirect/sed-i Layer 1)
  // regardless of verb — `cp /tmp/forged.json .claude/learning/posture.json`
  // no longer needs a `Bash(cp:...)` deny entry to be caught.
  const validateBash = path.join(
    REPO_ROOT,
    ".claude",
    "hooks",
    "validate-bash-command.js",
  );
  const { detectStateFileMutation } = require(
    path.join(LIB_DIR, "violation-patterns.js"),
  );
  const src = fs.readFileSync(validateBash, "utf8");
  const m = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(m, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval -- reconstruct the source-controlled regex literal
  const rx = eval(m[1]);
  const targets = {
    posture: ".claude/learning/posture.json",
    violations: ".claude/learning/violations.jsonl",
  };
  for (const [name, p] of Object.entries(targets)) {
    for (const cmd of [
      `cp /tmp/forged.json ${p}`, // Layer 2
      `tee ${p} < /tmp/forged.json`, // Layer 1 (tee)
      `echo '{}' > ${p}`, // Layer 1 (redirect)
      `sed -i 's/L5/L1/' ${p}`, // Layer 1 (in-place)
    ]) {
      assert.ok(
        detectStateFileMutation(cmd, rx),
        `hook MUST flag shell mutation of ${name}: ${cmd}`,
      );
    }
  }
});

// ============================================================================
// Q-MED-1 — genesis-ceremony.js github_login case-insensitive compare
// ============================================================================

test("genesis_ceremony_resolves_owner_case_insensitive", () => {
  // Roster declares github_login="alice"; ceremony invoked with
  // targetLogin="Alice" (mixed case) must still match. Pre-fix the
  // strict `!==` would skip the match and emit "no genesis owner declared".
  const { _internal } = require(GENESIS_CEREMONY);
  const { _resolveGenesisOwner } = _internal;
  const roster = {
    persons: {
      "person:owner-alpha": {
        role: "owner",
        github_login: "alice",
        keys: [],
      },
    },
  };
  const r = _resolveGenesisOwner(roster, "Alice");
  assert.equal(
    r.ok,
    true,
    `genesis owner resolution MUST be case-insensitive; got ${JSON.stringify(r)}`,
  );
  assert.equal(r.person_id, "person:owner-alpha");
});

test("genesis_ceremony_resolves_owner_reverse_case", () => {
  // Reverse direction: roster has mixed-case "Alice", ceremony lookup
  // with lowercase "alice" must match too.
  const { _internal } = require(GENESIS_CEREMONY);
  const { _resolveGenesisOwner } = _internal;
  const roster = {
    persons: {
      "person:owner-alpha": {
        role: "owner",
        github_login: "Alice",
        keys: [],
      },
    },
  };
  const r = _resolveGenesisOwner(roster, "alice");
  assert.equal(r.ok, true, "reverse case-direction must match");
  assert.equal(r.person_id, "person:owner-alpha");
});

test("genesis_ceremony_source_uses_tolowercase_on_github_login", () => {
  // Source-level invariant — protects the case-fold from being reverted.
  const src = fs.readFileSync(GENESIS_CEREMONY, "utf8");
  // The resolver function MUST use toLowerCase on github_login comparison.
  // Tolerate either `.toLowerCase()` chain.
  assert.ok(
    /github_login.*toLowerCase|toLowerCase.*github_login/s.test(src) ||
      // Or the explicit compare-after-lowercase pattern
      /String\(.*\.github_login.*toLowerCase\(\)\)/.test(src) ||
      /\.toLowerCase\(\)\s*!==\s*String\([^)]*\)\.toLowerCase\(\)/.test(src),
    "genesis-ceremony.js MUST case-normalize github_login comparison",
  );
});

// ============================================================================
// Q-MED-2 — owner-depart-ceremony.js login case-insensitive compare
// ============================================================================

test("owner_depart_ceremony_still_present_case_insensitive", () => {
  // GitHub server returns canonical casing ("alice"); operator-supplied
  // departingLogin may be "Alice". The collaborator-distinctness check
  // MUST treat them as equal and BLOCK the revocation since the operator
  // is in fact still a collaborator. Pre-fix the strict `===` returns
  // stillPresent=undefined → revocation proceeds against a live operator.
  const odc = require(OWNER_DEPART_CEREMONY);
  // Mock ghApi returning a single still-present collaborator entry with
  // canonical casing "alice".
  const collaboratorEntries = [{ login: "alice", id: 1, type: "User" }];
  const ghApi = (endpoint) => {
    if (/collaborators$/.test(endpoint)) {
      return { ok: true, status: 200, body: collaboratorEntries };
    }
    return { ok: false, status: 404, body: null };
  };
  // We need an ephemeral signer for the ceremony.
  const k = mkEphemeralSshKey("depart-i2");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "person:owner-bravo": {
          display_id: "bob",
          role: "owner",
          github_login: "bob",
          host_role: "human",
          keys: [{ type: "ssh", fingerprint: k.fingerprint, pubkey: k.pubKey }],
        },
      },
    };
    const r = odc.runRevocationCeremony({
      roster,
      repoOwner: "owner-A",
      repo: "repo-X",
      departingLogin: "Alice", // mixed case
      signer: {
        person_id: "person:owner-bravo",
        verified_id: k.fingerprint,
        keyPath: k.keyPath,
      },
      seq: 1,
      prevHash: "prev123",
      ghApi,
      now: () => "2025-01-01T00:00:00Z",
      mostRecentVictimChainEntry: null,
    });
    assert.equal(
      r.ok,
      false,
      "revocation MUST fail-closed when departingLogin is still a collaborator (case-insensitive)",
    );
    assert.match(
      r.error || "",
      /still a collaborator/i,
      `expected 'still a collaborator' error; got: ${r.error}`,
    );
  } finally {
    cleanup(k.dir);
  }
});

test("owner_depart_ceremony_source_uses_tolowercase_on_login", () => {
  const src = fs.readFileSync(OWNER_DEPART_CEREMONY, "utf8");
  // The stillPresent check MUST use toLowerCase on both sides.
  assert.ok(
    /toLowerCase\(\)/.test(src),
    "owner-depart-ceremony.js MUST case-normalize login comparison",
  );
});

// ============================================================================
// Sec-MED-2 — gate-approval canonical bytes include approver_verified_id
// ============================================================================

test("gate_approval_canonical_bytes_include_approver_verified_id", () => {
  // The canonical bytes MUST cover approver_verified_id. Defense-in-depth:
  // the verifier already resolves the approver pubkey via this field, so
  // a payload-level swap is structurally rejected. But binding the field
  // INTO the signed bytes makes the contract explicit and makes the
  // attacker's job harder (the swap is rejected even if the verifier's
  // resolution layer is buggy).
  const ga = require(GATE_APPROVAL_LIB);
  const fields = {
    target_tool: "release",
    requester_person_id: "person:owner-alpha",
    requester_verified_id: "SHA256:requester",
    approver_verified_id: "SHA256:approver",
    consumed_nonce: "n-1",
    ts: "2025-01-01T00:00:00Z",
  };
  const bytes = ga.canonicalGateApprovalBytes(fields);
  // The canonical bytes are a Buffer (deterministic UTF-8 JSON-canonical).
  // approver_verified_id MUST appear in the output bytes.
  const s = bytes.toString("utf8");
  assert.match(
    s,
    /approver_verified_id/,
    `canonical bytes MUST include approver_verified_id; got: ${s}`,
  );
  assert.match(
    s,
    /SHA256:approver/,
    `canonical bytes MUST include the approver_verified_id value; got: ${s}`,
  );
});

test("gate_approval_canonical_bytes_differ_when_approver_swapped", () => {
  // Concretely: swapping approver_verified_id changes the canonical bytes.
  // Before iter-2, swapping it had ZERO effect on signed bytes (only the
  // payload's verifier-lookup field changed).
  const ga = require(GATE_APPROVAL_LIB);
  const base = {
    target_tool: "release",
    requester_person_id: "person:owner-alpha",
    requester_verified_id: "SHA256:requester",
    consumed_nonce: "n-1",
    ts: "2025-01-01T00:00:00Z",
  };
  const aBytes = ga.canonicalGateApprovalBytes({
    ...base,
    approver_verified_id: "SHA256:alice",
  });
  const bBytes = ga.canonicalGateApprovalBytes({
    ...base,
    approver_verified_id: "SHA256:bob",
  });
  assert.notEqual(
    aBytes.toString("hex"),
    bBytes.toString("hex"),
    "canonical bytes MUST differ when approver_verified_id differs (defense-in-depth)",
  );
});

test("gate_approval_verify_rejects_approver_id_swap", () => {
  // End-to-end: build a valid gate_approval signed by Bob. Then swap the
  // payload-level approver_verified_id to Carol. Verify call MUST fail —
  // confirms structural defense (verifier resolves pubkey from
  // approver_verified_id, finds Carol's pubkey, but the sig was over
  // canonical bytes that bind Bob's id → verify rejects).
  const ga = require(GATE_APPROVAL_LIB);
  const { canonicalSerialize, sign } = require(COC_SIGN);

  const alice = mkEphemeralSshKey("alice-i2");
  const bob = mkEphemeralSshKey("bob-i2");
  const carol = mkEphemeralSshKey("carol-i2");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "person:owner-alpha": {
          display_id: "alice",
          role: "owner",
          github_login: "alice",
          host_role: "human",
          keys: [
            {
              type: "ssh",
              fingerprint: alice.fingerprint,
              pubkey: alice.pubKey,
            },
          ],
        },
        "person:owner-bravo": {
          display_id: "bob",
          role: "owner",
          github_login: "bob",
          host_role: "human",
          keys: [
            { type: "ssh", fingerprint: bob.fingerprint, pubkey: bob.pubKey },
          ],
        },
        "person:owner-charlie": {
          display_id: "carol",
          role: "owner",
          github_login: "carol",
          host_role: "human",
          keys: [
            {
              type: "ssh",
              fingerprint: carol.fingerprint,
              pubkey: carol.pubKey,
            },
          ],
        },
      },
    };
    const ts = new Date().toISOString();
    const nonce = "n-swap-test";

    // Bob signs over canonical bytes that bind Bob's approver_verified_id.
    const signedFields = {
      target_tool: "release",
      requester_person_id: "person:owner-alpha",
      requester_verified_id: alice.fingerprint,
      approver_verified_id: bob.fingerprint,
      consumed_nonce: nonce,
      ts,
    };
    const canonicalBytes = ga.canonicalGateApprovalBytes(signedFields);
    const signResult = sign(canonicalBytes, {
      keyType: "ssh",
      keyPath: bob.keyPath,
    });
    assert.equal(signResult.ok, true, "Bob signing must succeed");

    // Construct payload where the attacker swaps approver_verified_id to
    // Carol's fingerprint. The verifier resolves Carol's pubkey →
    // verify call rejects because canonical bytes covered Bob's id.
    const swappedPayload = {
      approver_person_id: "person:owner-charlie",
      approver_verified_id: carol.fingerprint, // SWAPPED
      approver_gh_login: "carol",
      approver_role: "owner",
      approver_host_role: "human",
      target_tool: "release",
      consumed_nonce: nonce,
      ts,
      sig: signResult.sig,
      signed_payload: signedFields,
    };
    const verifyResult = ga.verifyGateApproval(swappedPayload, {
      gate: "release",
      requester_person_id: "person:owner-alpha",
      requester_verified_id: alice.fingerprint,
      requester_nonce: nonce,
      roster,
      now: Date.parse(ts),
    });
    assert.equal(
      verifyResult.ok,
      false,
      "approver-id swap MUST fail verification",
    );
    // The rejection reason MUST cite signature failure (not roster lookup).
    assert.match(
      verifyResult.reason || "",
      /signature did not verify|verify call failed|did not verify/i,
      `rejection reason MUST cite signature failure; got: ${verifyResult.reason}`,
    );
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
    cleanup(carol.dir);
  }
});

test("gate_approval_happy_path_roundtrip_with_approver_verified_id_in_bytes", () => {
  // Sanity: the iter-2 contract change MUST NOT break the happy-path
  // round-trip. Bob signs valid bytes binding his id; verify succeeds.
  const ga = require(GATE_APPROVAL_LIB);
  const { sign } = require(COC_SIGN);

  const alice = mkEphemeralSshKey("alice-rt");
  const bob = mkEphemeralSshKey("bob-rt");
  try {
    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "person:owner-alpha": {
          display_id: "alice",
          role: "owner",
          github_login: "alice",
          host_role: "human",
          keys: [
            {
              type: "ssh",
              fingerprint: alice.fingerprint,
              pubkey: alice.pubKey,
            },
          ],
        },
        "person:owner-bravo": {
          display_id: "bob",
          role: "owner",
          github_login: "bob",
          host_role: "human",
          keys: [
            { type: "ssh", fingerprint: bob.fingerprint, pubkey: bob.pubKey },
          ],
        },
      },
    };
    const ts = new Date().toISOString();
    const nonce = "n-happy-i2";

    const signedFields = {
      target_tool: "release",
      requester_person_id: "person:owner-alpha",
      requester_verified_id: alice.fingerprint,
      approver_verified_id: bob.fingerprint,
      consumed_nonce: nonce,
      ts,
    };
    const canonicalBytes = ga.canonicalGateApprovalBytes(signedFields);
    const signResult = sign(canonicalBytes, {
      keyType: "ssh",
      keyPath: bob.keyPath,
    });
    assert.equal(signResult.ok, true);

    const payload = {
      approver_person_id: "person:owner-bravo",
      approver_verified_id: bob.fingerprint,
      approver_gh_login: "bob",
      approver_role: "owner",
      approver_host_role: "human",
      target_tool: "release",
      consumed_nonce: nonce,
      ts,
      sig: signResult.sig,
      signed_payload: signedFields,
    };
    const v = ga.verifyGateApproval(payload, {
      gate: "release",
      requester_person_id: "person:owner-alpha",
      requester_verified_id: alice.fingerprint,
      requester_nonce: nonce,
      roster,
      now: Date.parse(ts),
    });
    assert.equal(v.ok, true, `happy-path verify must succeed; got ${v.reason}`);
    assert.equal(v.approverVerifiedId, bob.fingerprint);
  } finally {
    cleanup(alice.dir);
    cleanup(bob.dir);
  }
});
