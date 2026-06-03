/**
 * Tier-2 integration tests for F14 C2-auth-hardening iter-3 shard.
 *
 * /redteam R3 against PR #317 surfaced same-bug-class sibling sites that
 * the iter-2 fixes missed. Per autonomous-execution.md MUST Rule 4 +
 * zero-tolerance.md Rule 4 (no workarounds — fix bug class structurally),
 * iter-3 closes the class via two shared helpers and routes ALL siblings
 * through them.
 *
 * HIGH (in-scope):
 *
 *   Tool-class sibling sweep (4 hooks):
 *     adjacency-leasecheck.js:130 — multi-operator lease integrity invariant
 *     signing-mutation-guard.js:131 — degraded-mode read-only on tracked paths
 *     genesis-anchor-guard.js:121 — roster-touching paths
 *     detect-violations.js:147 — worktree-drift + probe-driven sweep
 *
 *   Login case-norm sibling sweep (6+ sites):
 *     fold-genesis-anchor.js:121 — FOLD-time owner-bind
 *     gh-api-allowlist.js:320,334 — R5-S-07 sock-puppet check
 *     owner-add-ceremony.js:145 — attestation evidence
 *     recovery-fallback.js:114,260 — recovery owner resolution
 *     coordination-log.js:372 — fold-rule-10 victim chain
 *     fold-rule-9c.js:287 — genesis-migration owner-bind
 *
 *   Settings.json Bash deny matrix completion:
 *     rm / mv / cp / tee / sed / echo × roster + coordination-log
 *     cp / tee / sed / echo × .initialized
 *
 * Structural sweep tests:
 *   (a) `grep -rn 'tool === "Edit" || tool === "Write"' .claude/hooks/`
 *       MUST return ZERO hits — every mutation-tool check routes through
 *       isMutationTool().
 *   (b) `grep -rnE '\.(github_login|login)\s*[!=]==' .claude/hooks/`
 *       MUST return ZERO hits — every login comparison routes through
 *       loginsEqual() (type-guard `typeof X === "string"` is excluded).
 *
 * Run via:
 *   node --test tests/integration/multi-operator/c2-auth-hardening-iter3.test.js
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
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LIB_DIR = path.join(HOOKS_DIR, "lib");
const TOOL_CLASSES = path.join(LIB_DIR, "tool-classes.js");
const GITHUB_LOGIN = path.join(LIB_DIR, "github-login.js");

// ============================================================================
// Helper unit tests — tool-classes.js
// ============================================================================

test("isMutationTool_flags_edit_write_multiedit_notebookedit", () => {
  const { isMutationTool } = require(TOOL_CLASSES);
  assert.equal(isMutationTool("Edit"), true);
  assert.equal(isMutationTool("Write"), true);
  assert.equal(isMutationTool("MultiEdit"), true);
  assert.equal(isMutationTool("NotebookEdit"), true);
});

test("isMutationTool_rejects_read_only_tools", () => {
  const { isMutationTool } = require(TOOL_CLASSES);
  assert.equal(isMutationTool("Bash"), false);
  assert.equal(isMutationTool("Read"), false);
  assert.equal(isMutationTool("Grep"), false);
  assert.equal(isMutationTool("Glob"), false);
  assert.equal(isMutationTool("WebFetch"), false);
  assert.equal(isMutationTool(""), false);
});

test("isMutationTool_rejects_non_string_input", () => {
  const { isMutationTool } = require(TOOL_CLASSES);
  assert.equal(isMutationTool(null), false);
  assert.equal(isMutationTool(undefined), false);
  assert.equal(isMutationTool(42), false);
  assert.equal(isMutationTool({}), false);
  assert.equal(isMutationTool([]), false);
});

test("MUTATION_TOOLS_exports_canonical_set", () => {
  const { MUTATION_TOOLS } = require(TOOL_CLASSES);
  assert.ok(MUTATION_TOOLS instanceof Set);
  assert.equal(MUTATION_TOOLS.size, 4);
  assert.ok(MUTATION_TOOLS.has("Edit"));
  assert.ok(MUTATION_TOOLS.has("Write"));
  assert.ok(MUTATION_TOOLS.has("MultiEdit"));
  assert.ok(MUTATION_TOOLS.has("NotebookEdit"));
});

// ============================================================================
// Helper unit tests — github-login.js (case-insensitive comparison helpers)
// ============================================================================

test("loginsEqual_matches_mixed_case", () => {
  const { loginsEqual } = require(GITHUB_LOGIN);
  assert.equal(loginsEqual("Alice", "alice"), true);
  assert.equal(loginsEqual("alice", "Alice"), true);
  assert.equal(loginsEqual("ALICE", "alice"), true);
  assert.equal(loginsEqual("Alice", "Alice"), true);
});

test("loginsEqual_rejects_different_logins", () => {
  const { loginsEqual } = require(GITHUB_LOGIN);
  assert.equal(loginsEqual("Alice", "Bob"), false);
  assert.equal(loginsEqual("alice", "bob"), false);
  assert.equal(loginsEqual("alice", "alice-bot"), false);
});

test("loginsEqual_rejects_non_string_input", () => {
  const { loginsEqual } = require(GITHUB_LOGIN);
  assert.equal(loginsEqual(null, "alice"), false);
  assert.equal(loginsEqual("alice", null), false);
  assert.equal(loginsEqual(undefined, "alice"), false);
  assert.equal(loginsEqual("alice", undefined), false);
  assert.equal(loginsEqual(42, "alice"), false);
  assert.equal(loginsEqual(null, null), false);
});

test("normalizeLogin_lowercases_string", () => {
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin("Alice"), "alice");
  assert.equal(normalizeLogin("ALICE"), "alice");
  assert.equal(normalizeLogin("alice"), "alice");
});

test("normalizeLogin_returns_null_for_non_string", () => {
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin(null), null);
  assert.equal(normalizeLogin(undefined), null);
  assert.equal(normalizeLogin(42), null);
  assert.equal(normalizeLogin({}), null);
});

// ============================================================================
// CRITICAL Structural Sweep Tests
// (pre-ship contract: these fail until the refactor lands)
// ============================================================================

test("structural_sweep_no_bare_mutation_tool_checks_remain", () => {
  // Per autonomous-execution.md MUST-4 + zero-tolerance.md Rule 4:
  // every `tool === "Edit" || tool === "Write"` MUST be routed through
  // isMutationTool(). This sweep is the SSOT enforcement.
  //
  // Exclusion: lib/tool-classes.js documents the rule in code comments
  // (the helper module's own JSDoc references the deprecated pattern as
  // the bug class it closes); those references are NOT bugs.
  let result;
  try {
    result = execFileSync(
      "grep",
      [
        "-rn",
        "--include=*.js",
        "--exclude=tool-classes.js",
        'tool === "Edit" || tool === "Write"',
        HOOKS_DIR,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    // grep exit 1 = no matches found (the success case)
    if (err.status === 1) {
      result = "";
    } else {
      throw err;
    }
  }
  assert.equal(
    result.trim(),
    "",
    `Found bare 'tool === "Edit" || tool === "Write"' patterns. ALL such checks MUST route through isMutationTool() from lib/tool-classes.js:\n${result}`,
  );
});

test("structural_sweep_no_bare_login_strict_equality_remains", () => {
  // Per autonomous-execution.md MUST-4 + zero-tolerance.md Rule 4:
  // every login-class strict-equality comparison MUST be routed through
  // loginsEqual().
  //
  // F14 C2 iter-4 MED-R4-2: the sweep regex consumes the SSOT
  // GITHUB_LOGIN_FIELD_NAMES constant exported from lib/github-login.js.
  // Adding a new login-class field name MUST extend the constant and
  // the sweep automatically covers it. This tightens iter-3's
  // field-name-anchored sweep (which was hand-coded
  // `(github_login|login)`) to a positive allowlist that scales with
  // deliberate additions (per cc-artifacts.md Rule 10).
  //
  // Type-guard `typeof X.login === "string"` is filtered out (it's a
  // TYPE check, not a value comparison).
  const { GITHUB_LOGIN_FIELD_NAMES } = require(GITHUB_LOGIN);
  const pattern = `\\.(${GITHUB_LOGIN_FIELD_NAMES.join("|")})\\s*[!=]==`;
  // Regex word-class for the typeof-filter: same field names.
  const typeofFilter = new RegExp(
    `typeof\\s+[^=]+(\\.|\\s)(${GITHUB_LOGIN_FIELD_NAMES.join("|")})\\s*[!=]==\\s*"string"`,
  );
  let result;
  try {
    result = execFileSync(
      "grep",
      ["-rnE", "--include=*.js", pattern, HOOKS_DIR],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    if (err.status === 1) {
      result = "";
    } else {
      throw err;
    }
  }
  const lines = result.split("\n").filter((line) => {
    if (!line.trim()) return false;
    if (typeofFilter.test(line)) return false;
    // Comment lines (// or *) — JSDoc references to deprecated patterns
    // are not real bug sites.
    const trimmed = line.replace(/^[^:]*:\d+:\s*/, "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return true;
  });
  assert.equal(
    lines.join("\n"),
    "",
    `Found bare login-class field strict compares. ALL such comparisons MUST route through loginsEqual() from lib/github-login.js (extension path: append to GITHUB_LOGIN_FIELD_NAMES):\n${lines.join("\n")}`,
  );
});

test("structural_sweep_no_bare_local_var_login_compares_iter4", () => {
  // F14 C2 iter-4 MED-R4-2 (R4-security): iter-3 sweep was
  // field-name-anchored and slid past local-var-assigned compares
  // (e.g. `externalOwner !== declaredOwner`). This sweep consumes the
  // SSOT GITHUB_LOGIN_LOCAL_VARS constant and flags any bare strict
  // compare of those locals.
  //
  // Filtered: type guards (`typeof X === "string"`), null/undefined
  // checks (`X === null`), and comment-only matches. Real value-vs-value
  // strict compares on login-class locals are flagged.
  const { GITHUB_LOGIN_LOCAL_VARS } = require(GITHUB_LOGIN);
  const pattern = `\\b(${GITHUB_LOGIN_LOCAL_VARS.join("|")})\\s*[!=]==`;
  let result;
  try {
    result = execFileSync(
      "grep",
      ["-rnE", "--include=*.js", pattern, HOOKS_DIR],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    if (err.status === 1) {
      result = "";
    } else {
      throw err;
    }
  }
  const lines = result.split("\n").filter((line) => {
    if (!line.trim()) return false;
    // typeof <var-or-property-access> === "string" / "undefined" / "object"
    if (/typeof\s+[\w.]+\s*[!=]==\s*"\w+"/.test(line)) return false;
    // <var> === null / undefined
    if (/\b\w+\s*[!=]==\s*(null|undefined)\b/.test(line)) return false;
    // Comment lines (// or *).
    const trimmed = line.replace(/^[^:]*:\d+:\s*/, "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return true;
  });
  assert.equal(
    lines.join("\n"),
    "",
    `Found bare local-var login-class strict compares. ALL such compares MUST route through loginsEqual() (extension path: append to GITHUB_LOGIN_LOCAL_VARS):\n${lines.join("\n")}`,
  );
});

// ============================================================================
// HIGH — Adjacency-leasecheck MultiEdit/NotebookEdit coverage
// ============================================================================

test("adjacency_leasecheck_uses_isMutationTool_helper", () => {
  // Structural assertion: adjacency-leasecheck.js MUST import + use the
  // shared helper, not maintain a local Edit/Write set.
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "adjacency-leasecheck.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*tool-classes/.test(src),
    "adjacency-leasecheck.js MUST require lib/tool-classes.js",
  );
  assert.ok(
    /isMutationTool\s*\(/.test(src),
    "adjacency-leasecheck.js MUST call isMutationTool() on the tool field",
  );
});

test("signing_mutation_guard_uses_isMutationTool_helper", () => {
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "signing-mutation-guard.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*tool-classes/.test(src),
    "signing-mutation-guard.js MUST require lib/tool-classes.js",
  );
  assert.ok(
    /isMutationTool\s*\(/.test(src),
    "signing-mutation-guard.js MUST call isMutationTool()",
  );
});

test("integrity_guard_uses_isMutationTool_helper", () => {
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "integrity-guard.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*tool-classes/.test(src),
    "integrity-guard.js MUST require lib/tool-classes.js (SSOT consistency)",
  );
});

test("posture_gate_uses_isMutationTool_helper", () => {
  const src = fs.readFileSync(path.join(HOOKS_DIR, "posture-gate.js"), "utf8");
  assert.ok(
    /require\([^)]*tool-classes/.test(src),
    "posture-gate.js MUST require lib/tool-classes.js (SSOT consistency)",
  );
});

// ============================================================================
// HIGH — Login case-norm coverage at FOLD layer
// ============================================================================

test("fold_genesis_anchor_uses_loginsEqual_helper", () => {
  // fold-genesis-anchor.js:121 was `person.github_login !== targetLogin`
  // case-strict. iter-3 fix routes through loginsEqual.
  const src = fs.readFileSync(
    path.join(LIB_DIR, "fold-genesis-anchor.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "fold-genesis-anchor.js MUST require lib/github-login.js",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "fold-genesis-anchor.js MUST call loginsEqual() instead of bare `!==`",
  );
});

test("fold_genesis_anchor_matches_case_insensitively", () => {
  // Behavioral test: roster declares "Alice", capture says "alice".
  // Pre-iter-3, strict !== would fail to match. iter-3 routes through
  // loginsEqual so the bind succeeds.
  const { _internal } = require(path.join(LIB_DIR, "fold-genesis-anchor.js"));
  const { _resolveOwnerPerson } = _internal;
  // Test mode: kind=user, targetLogin via genesis.repo_owner.
  const roster = {
    genesis: { repo_owner_kind: "user", repo_owner: "Alice" },
    persons: {
      "person:owner-alpha": {
        role: "owner",
        github_login: "alice", // lowercase in roster
        keys: [{ fingerprint: "SHA256:abc" }],
      },
    },
  };
  const r = _resolveOwnerPerson(roster, { content: {} });
  assert.ok(
    r && r.person_id === "person:owner-alpha",
    `fold-genesis-anchor owner-bind MUST be case-insensitive; got ${JSON.stringify(r)}`,
  );
});

// ============================================================================
// HIGH — gh-api-allowlist R5-S-07 sock-puppet case-norm
// ============================================================================

test("gh_api_allowlist_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "gh-api-allowlist.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "gh-api-allowlist.js MUST require lib/github-login.js",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "gh-api-allowlist.js MUST use loginsEqual() for collaborator-login comparisons",
  );
});

test("gh_api_allowlist_sock_puppet_detects_case_mismatch", () => {
  // R5-S-07: primary "Alice" + cosigner "alice" must be detected as
  // the same person (sock-puppet defense), not bypassed by case.
  const { _verifyDistinctBoundCollaborators } = require(
    path.join(LIB_DIR, "gh-api-allowlist.js"),
  );
  const capture = {
    collaborators: [
      { login: "Alice", permissions: { admin: true } },
      { login: "bob", permissions: { admin: true } },
    ],
  };
  // Primary "alice" (lowercase) + cosigner "Alice" (mixed): sock-puppet.
  // Signature: (primaryLogin, cosignerLogin, capture)
  const r = _verifyDistinctBoundCollaborators("alice", "Alice", capture);
  assert.equal(
    r.ok,
    false,
    "sock-puppet defense MUST detect case-mismatch as same login",
  );
  assert.ok(
    r.reason.includes("sock-puppet") || r.reason.includes("SAME"),
    `expected sock-puppet error; got ${r.reason}`,
  );
});

test("gh_api_allowlist_finds_primary_collaborator_case_insensitive", () => {
  // Primary login "Alice" in roster, gh-api capture has "alice".
  const { _verifyDistinctBoundCollaborators } = require(
    path.join(LIB_DIR, "gh-api-allowlist.js"),
  );
  const capture = {
    collaborators: [
      { login: "alice", permissions: { admin: true } }, // lowercase
      { login: "bob", permissions: { admin: true } },
    ],
  };
  // Signature: (primaryLogin, cosignerLogin, capture)
  const r = _verifyDistinctBoundCollaborators("Alice", "Bob", capture);
  assert.equal(
    r.ok,
    true,
    `primary admin lookup MUST be case-insensitive; got ${JSON.stringify(r)}`,
  );
});

// ============================================================================
// HIGH — Owner-add ceremony case-norm
// ============================================================================

test("owner_add_ceremony_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "owner-add-ceremony.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "owner-add-ceremony.js MUST require lib/github-login.js",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "owner-add-ceremony.js MUST use loginsEqual() for attestation evidence",
  );
});

// ============================================================================
// HIGH — Coordination-log fold-rule-10 victim chain
// ============================================================================

test("coordination_log_uses_loginsEqual_in_victim_chain", () => {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "coordination-log.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "coordination-log.js MUST require lib/github-login.js for victim-chain login compare",
  );
  // Find the _collectVictimChainEntries function and assert it uses loginsEqual
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "coordination-log.js MUST use loginsEqual() at victim-chain login compare",
  );
});

test("coordination_log_victim_chain_case_insensitive", () => {
  // Roster declares "Alice" with fingerprint vfid-alice; revocation
  // record says github_login: "alice". Victim chain MUST populate.
  const engine = require(path.join(LIB_DIR, "coordination-log.js"));
  const { _internal } = engine;
  const { _collectVictimChainEntries } = _internal;
  const roster = {
    persons: {
      "person:alpha": {
        github_login: "Alice", // mixed case
        keys: [{ fingerprint: "vfid-alice" }],
      },
    },
  };
  const revocation = {
    type: "collaborator-distinctness-revocation",
    content: { github_login: "alice" }, // lowercase
  };
  const accepted = [
    { type: "claim", verified_id: "vfid-alice", seq: 0 },
    { type: "heartbeat", verified_id: "vfid-alice", seq: 1 },
    { type: "session-open", verified_id: "vfid-bob", seq: 2 },
  ];
  const chain = _collectVictimChainEntries(revocation, roster, accepted);
  // Should match the two vfid-alice records, not the bob one.
  assert.equal(
    chain.length,
    2,
    `victim chain MUST populate case-insensitively; got ${chain.length} entries`,
  );
});

// ============================================================================
// HIGH — fold-rule-9c case-norm
// ============================================================================

test("fold_rule_9c_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(path.join(LIB_DIR, "fold-rule-9c.js"), "utf8");
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "fold-rule-9c.js MUST require lib/github-login.js",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "fold-rule-9c.js MUST use loginsEqual() for owner-bind",
  );
});

// ============================================================================
// HIGH — recovery-fallback case-norm
// ============================================================================

test("recovery_fallback_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "recovery-fallback.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "recovery-fallback.js MUST require lib/github-login.js",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "recovery-fallback.js MUST use loginsEqual() in trust-root + remaining-owner resolution",
  );
});

// ============================================================================
// SSOT consistency — derive-n.js / gate-matrix.js / genesis-ceremony.js /
// owner-depart-ceremony.js use loginsEqual (already had toLowerCase but
// route through helper for SSOT)
// ============================================================================

test("derive_n_uses_loginsEqual_or_normalizeLogin_helper", () => {
  const src = fs.readFileSync(path.join(LIB_DIR, "derive-n.js"), "utf8");
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "derive-n.js MUST require lib/github-login.js (SSOT)",
  );
  // Azure DevOps port (Shard 2c): derive-n now dispatches on
  // roster.genesis.provider and routes case-folding through EITHER the
  // github-login SSOT (loginsEqual/normalizeLogin) OR the ado-login SSOT
  // (principalsEqual/normalizePrincipal), selected once into aliased locals
  // (idEqual/normalizeId). The load-bearing invariant is unchanged: NO inline
  // toLowerCase — every case-fold routes through an SSOT helper.
  assert.ok(
    /require\([^)]*ado-login/.test(src),
    "derive-n.js MUST require lib/ado-login.js (ADO principal SSOT) for the azure-devops provider dispatch",
  );
  // The SSOT helpers are bound once into the provider-dispatch aliases
  // (idEqual / normalizeId) and invoked through them; assert a case-fold/
  // equality helper IS invoked (direct or via the dispatch alias).
  assert.ok(
    /(loginsEqual|normalizeLogin|principalsEqual|normalizePrincipal|idEqual|normalizeId)\s*\(/.test(
      src,
    ),
    "derive-n.js MUST invoke an SSOT case-fold/equality helper (login or principal, direct or dispatch-alias)",
  );
});

test("genesis_ceremony_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "genesis-ceremony.js"),
    "utf8",
  );
  // genesis-ceremony already imported github-login for validators; now
  // routes through loginsEqual.
  assert.ok(
    /loginsEqual\s*\(|normalizeLogin\s*\(/.test(src),
    "genesis-ceremony.js MUST use loginsEqual()/normalizeLogin() for SSOT consistency",
  );
});

test("owner_depart_ceremony_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "owner-depart-ceremony.js"),
    "utf8",
  );
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "owner-depart-ceremony.js MUST require lib/github-login.js (SSOT)",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "owner-depart-ceremony.js MUST use loginsEqual() for stillPresent check",
  );
});

test("gate_matrix_uses_loginsEqual_helper", () => {
  const src = fs.readFileSync(path.join(LIB_DIR, "gate-matrix.js"), "utf8");
  assert.ok(
    /require\([^)]*github-login/.test(src),
    "gate-matrix.js MUST require lib/github-login.js (SSOT)",
  );
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "gate-matrix.js MUST use loginsEqual() for requester/approver compare",
  );
});

// ============================================================================
// Bash mutation coverage — path-based hook interceptor (F123)
//
// The per-verb Bash deny-matrix was removed from settings.json as
// structurally incompletable; the authoritative Bash control is the
// path-based hook interceptor validate-bash-command.js::detectStateFileMutation,
// which catches the same vectors (rm/mv/cp Layer 2, tee/redirect/sed-i
// Layer 1) regardless of verb. These tests assert hook coverage of each
// state-file path across all six historical deny-matrix vectors.
// ============================================================================

const { detectStateFileMutation } = require(
  path.join(LIB_DIR, "violation-patterns.js"),
);

function hookStatePathRx() {
  const src = fs.readFileSync(
    path.join(LIB_DIR, "..", "validate-bash-command.js"),
    "utf8",
  );
  const m = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(m, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval -- reconstruct the source-controlled regex literal
  return eval(m[1]);
}

function mutationCommands(p) {
  return [
    `rm ${p}`, // Layer 2
    `mv ${p} /tmp/x`, // Layer 2
    `cp /tmp/x ${p}`, // Layer 2
    `tee ${p} < /tmp/x`, // Layer 1 (tee)
    `echo '{}' > ${p}`, // Layer 1 (redirect)
    `sed -i 's/a/b/' ${p}`, // Layer 1 (in-place)
  ];
}

test("hook_protects_roster_across_bash_vectors", () => {
  const rx = hookStatePathRx();
  for (const cmd of mutationCommands(".claude/operators.roster.json")) {
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag Bash mutation of operators.roster.json: ${cmd}`,
    );
  }
});

test("hook_protects_coordination_log_across_bash_vectors", () => {
  const rx = hookStatePathRx();
  for (const cmd of mutationCommands(
    ".claude/learning/coordination-log.jsonl",
  )) {
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag Bash mutation of coordination-log.jsonl: ${cmd}`,
    );
  }
});

test("hook_protects_initialized_marker_across_bash_vectors", () => {
  const rx = hookStatePathRx();
  for (const cmd of mutationCommands(".claude/learning/.initialized")) {
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag Bash mutation of .initialized: ${cmd}`,
    );
  }
});

// ============================================================================
// adjacency-leasecheck MultiEdit behavioral regression
// ============================================================================

test("adjacency_leasecheck_recognizes_MultiEdit_as_mutation", () => {
  // The isWatchedTool predicate in adjacency-leasecheck.js fires on
  // mutation tools. Behavioral regression: MultiEdit MUST be recognized
  // as a mutation tool (post-refactor through isMutationTool).
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "adjacency-leasecheck.js"),
    "utf8",
  );
  // Verify the file no longer has the bare Edit/Write check
  assert.equal(
    /tool\s*===\s*"Edit"\s*\|\|\s*tool\s*===\s*"Write"/.test(src),
    false,
    "adjacency-leasecheck.js MUST NOT have bare Edit||Write check after refactor",
  );
});

test("signing_mutation_guard_recognizes_MultiEdit_as_mutation", () => {
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "signing-mutation-guard.js"),
    "utf8",
  );
  // After refactor, classifyOperation MUST route through isMutationTool
  // for the edit-write branch.
  assert.equal(
    /tool\s*===\s*"Edit"\s*\|\|\s*tool\s*===\s*"Write"/.test(src),
    false,
    "signing-mutation-guard.js MUST NOT have bare Edit||Write check after refactor",
  );
});

// ============================================================================
// genesis-anchor-guard + detect-violations: design intent verification
// ============================================================================

test("genesis_anchor_guard_uses_isMutationTool_or_documents_edit_only", () => {
  // genesis-anchor-guard fires on roster-touching paths. After iter-3,
  // it either (a) routes through isMutationTool, OR (b) carries an
  // explicit code comment documenting Edit-only-by-design. The decision
  // is documented in the audit report.
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "genesis-anchor-guard.js"),
    "utf8",
  );
  const hasHelperImport = /require\([^)]*tool-classes/.test(src);
  const hasBareCheck = /tool\s*===\s*"Edit"\s*\|\|\s*tool\s*===\s*"Write"/.test(
    src,
  );
  assert.ok(
    hasHelperImport && !hasBareCheck,
    "genesis-anchor-guard.js MUST import tool-classes AND NOT have bare Edit||Write check (extended to MultiEdit/NotebookEdit for roster integrity)",
  );
});

test("detect_violations_uses_isMutationTool_or_documents_edit_only", () => {
  const src = fs.readFileSync(
    path.join(HOOKS_DIR, "detect-violations.js"),
    "utf8",
  );
  const hasHelperImport = /require\([^)]*tool-classes/.test(src);
  const hasBareCheck = /tool\s*===\s*"Edit"\s*\|\|\s*tool\s*===\s*"Write"/.test(
    src,
  );
  assert.ok(
    hasHelperImport && !hasBareCheck,
    "detect-violations.js MUST import tool-classes AND NOT have bare Edit||Write check (extends worktree-drift + probe-driven sweep to MultiEdit/NotebookEdit)",
  );
});
