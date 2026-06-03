/**
 * Tier-2 regression suite for the F14 M5-B2 iter-5 SSOT extension.
 *
 * Anchor: `workspaces/multi-operator-coc/todos/active/iter5-ssot-vocabulary-completeness.md`
 * (verbatim §R5-MED-1 / R5-MED-2 / R5-LOW-1 / R5-LOW-3 + R5-LOW-2 settings deny extension).
 *
 * Scope (this shard, partial-bundle delivery per Path-A authorization):
 *   - iter-5 SSOT extension only. The full M5-B2 contract (3 lifecycle hooks
 *     + 17+ audit fixtures + sessionstart/heartbeat/sessionend) is deferred
 *     to a continuation shard because per-session capacity (~85k tokens of
 *     system-reminder rule context already injected this turn) exceeds the
 *     `rules/autonomous-execution.md` MUST-1 budget for the full bundle.
 *
 * Tests:
 *   1. github_login_field_names_includes_gh_login  (R5-MED-1)
 *   2. github_login_local_vars_includes_recLogin_login_victimLogin_adminLogin
 *      (R5-MED-2 + R5-LOW-3)
 *   3. normalize_login_rejects_empty_string_after_iter5  (R5-LOW-1)
 *   4. normalize_login_still_accepts_valid_ascii_logins  (regression-block)
 *   5. settings_json_denies_python_against_state_files  (R5-LOW-2 — Python)
 *   6. settings_json_denies_node_against_state_files  (R5-LOW-2 — Node)
 *   7. structural_sweep_with_extended_field_ssot_empty   (post-iter-5 sweep)
 *   8. structural_sweep_with_extended_localvar_ssot_empty (post-iter-5 sweep)
 *
 * Per `rules/probe-driven-verification.md` Rule 3: this is structural
 * verification (constant membership, regex sweep), not semantic — regex is
 * the correct tool here.
 *
 * Run via:
 *   node --test tests/integration/multi-operator/m5-b2-iter5-ssot.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LIB_DIR = path.join(HOOKS_DIR, "lib");
const GITHUB_LOGIN = path.join(LIB_DIR, "github-login.js");

// ============================================================================
// R5-MED-1 — GITHUB_LOGIN_FIELD_NAMES includes gh_login
// ============================================================================

test("github_login_field_names_includes_gh_login", () => {
  // R5-MED-1: gate-matrix.js:200-203 (_sameBoundCollaborator) routes
  // .gh_login through loginsEqual already; this lifts the field name into
  // the SSOT constants so the structural sweep regex catches FUTURE bare
  // `.gh_login ===` compares anywhere in the substrate.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { GITHUB_LOGIN_FIELD_NAMES } = require(GITHUB_LOGIN);
  assert.ok(
    GITHUB_LOGIN_FIELD_NAMES.includes("gh_login"),
    `Expected 'gh_login' in GITHUB_LOGIN_FIELD_NAMES, got ${JSON.stringify(GITHUB_LOGIN_FIELD_NAMES)}`,
  );
});

test("github_login_field_names_preserves_iter4_entries", () => {
  // Regression-block: iter-5 addition MUST NOT drop any iter-4 entry.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { GITHUB_LOGIN_FIELD_NAMES } = require(GITHUB_LOGIN);
  for (const name of [
    "github_login",
    "login",
    "repo_owner",
    "new_repo_owner",
  ]) {
    assert.ok(
      GITHUB_LOGIN_FIELD_NAMES.includes(name),
      `Iter-4 entry '${name}' missing from GITHUB_LOGIN_FIELD_NAMES`,
    );
  }
});

// ============================================================================
// R5-MED-2 + R5-LOW-3 — GITHUB_LOGIN_LOCAL_VARS extension
// ============================================================================

test("github_login_local_vars_includes_recLogin_login_victimLogin_adminLogin", () => {
  // R5-MED-2: derive-n.js:130,143 + recovery-fallback.js:66,94 use `recLogin`
  //   and `login` local-vars (currently structurally safe via upstream
  //   normalizeLogin); SSOT enumeration lifts them so future refactor that
  //   removes upstream normalization cannot drift past the sweep.
  // R5-LOW-3: fold-rule-10.js:252 + genesis-ceremony.js:366 use `victimLogin`
  //   and `adminLogin` local-vars (no current compare sites; future-drift
  //   defense only).
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { GITHUB_LOGIN_LOCAL_VARS } = require(GITHUB_LOGIN);
  for (const name of ["recLogin", "login", "victimLogin", "adminLogin"]) {
    assert.ok(
      GITHUB_LOGIN_LOCAL_VARS.includes(name),
      `Expected '${name}' in GITHUB_LOGIN_LOCAL_VARS, got ${JSON.stringify(GITHUB_LOGIN_LOCAL_VARS)}`,
    );
  }
});

test("github_login_local_vars_preserves_iter4_entries", () => {
  // Regression-block: iter-5 addition MUST NOT drop any iter-4 entry.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { GITHUB_LOGIN_LOCAL_VARS } = require(GITHUB_LOGIN);
  for (const name of [
    "externalOwner",
    "declaredOwner",
    "authorLogin",
    "authorName",
    "targetLogin",
    "primaryLogin",
    "cosignerLogin",
    "departingLogin",
    "newOwnerLogin",
    "remainingLogin",
  ]) {
    assert.ok(
      GITHUB_LOGIN_LOCAL_VARS.includes(name),
      `Iter-4 entry '${name}' missing from GITHUB_LOGIN_LOCAL_VARS`,
    );
  }
});

// ============================================================================
// R5-LOW-1 — normalizeLogin rejects empty string after iter-5
// ============================================================================

test("normalize_login_rejects_empty_string_after_iter5", () => {
  // R5-LOW-1: `normalizeLogin("")` previously returned "" (the ASCII regex
  // /^[\x00-\x7f]*$/ allows zero chars). loginsEqual("","") returned true,
  // which was upstream-dependent safety (validateGithubLogin rejects empty,
  // but the property was contingent rather than structural).
  //
  // Iter-5 fix: explicit length-0 guard inside normalizeLogin makes the
  // property structural — `null` instead of "" regardless of upstream
  // discipline.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { normalizeLogin, loginsEqual } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin(""), null);
  assert.equal(
    loginsEqual("", ""),
    false,
    "Two empty strings MUST NOT be equal after iter-5",
  );
});

test("normalize_login_still_accepts_valid_ascii_logins", () => {
  // Regression-block: the iter-5 length-0 guard MUST NOT reject any valid
  // GitHub login. Lowercase + uppercase + hyphen + digits remain legal.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin("Alice"), "alice");
  assert.equal(normalizeLogin("ALICE"), "alice");
  assert.equal(normalizeLogin("alice"), "alice");
  assert.equal(normalizeLogin("alice-bot"), "alice-bot");
  assert.equal(normalizeLogin("user-42"), "user-42");
  assert.equal(normalizeLogin("a"), "a");
});

test("normalize_login_still_rejects_non_ascii_post_iter5", () => {
  // Regression-block: iter-4 LOW-R4-5 ASCII guard must survive iter-5.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin("İlhan"), null);
  assert.equal(normalizeLogin("élise"), null);
});

test("normalize_login_still_rejects_non_string_post_iter5", () => {
  // Regression-block: iter-3 non-string guard must survive iter-5.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin(null), null);
  assert.equal(normalizeLogin(undefined), null);
  assert.equal(normalizeLogin(42), null);
  assert.equal(normalizeLogin({}), null);
});

// ============================================================================
// R5-LOW-2 — interpreter-body (python/node) Layer-3 mutation coverage.
// F123: the per-verb Bash deny-matrix (Bash(python:*<state>), Bash(node:...))
// was removed from settings.json as structurally incompletable; the
// authoritative control is the path-based hook interceptor
// validate-bash-command.js::detectStateFileMutation, whose Layer 3 flags
// `python -c` / `node -e` bodies that touch a protected state-file path.
// ============================================================================

const VALIDATE_BASH = path.join(HOOKS_DIR, "validate-bash-command.js");
const { detectStateFileMutation } = require(
  path.join(LIB_DIR, "violation-patterns.js"),
);

function statePathRx() {
  const src = fs.readFileSync(VALIDATE_BASH, "utf8");
  const m = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(m, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval -- reconstruct the source-controlled regex literal
  return eval(m[1]);
}

const STATE_FILE_PATHS = {
  posture: ".claude/learning/posture.json",
  violations: ".claude/learning/violations.jsonl",
  "operators.roster.json": ".claude/operators.roster.json",
  "coordination-log.jsonl": ".claude/learning/coordination-log.jsonl",
  ".initialized": ".claude/learning/.initialized",
};

test("hook_blocks_python_interpreter_against_state_files", () => {
  // R5-LOW-2: Layer-3 interpreter-body bypass —
  // `python -c "open('...posture.json...','w').write(...)"` routes around any
  // verb denylist. The hook flags it on the TARGET PATH regardless of verb.
  const rx = statePathRx();
  for (const [cls, p] of Object.entries(STATE_FILE_PATHS)) {
    const cmd = `python3 -c "open('${p}','w').write('x')"`;
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag python interpreter mutation of '${cls}': ${cmd}`,
    );
  }
});

test("hook_blocks_node_interpreter_against_state_files", () => {
  // R5-LOW-2 sibling: `node -e "require('fs').writeFileSync('...')"` is the
  // same Layer-3 interpreter-body bypass class through a different interpreter.
  const rx = statePathRx();
  for (const [cls, p] of Object.entries(STATE_FILE_PATHS)) {
    const cmd = `node -e "require('fs').writeFileSync('${p}','x')"`;
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag node interpreter mutation of '${cls}': ${cmd}`,
    );
  }
});

test("hook_blocks_interpreter_m_flag_unquoted_and_heredoc_forms", () => {
  // F123 whole-command fallback: the per-line quoted-body matcher misses
  // `-m` module invocations, unquoted bodies, `--eval=` forms, and stdin
  // heredocs. The whole-command clause restores parity with the removed
  // Bash(python:...) / Bash(node:...) deny globs, which matched the whole
  // command string regardless of body quoting or line span.
  const rx = statePathRx();
  const posture = ".claude/learning/posture.json";
  const evasions = [
    `python3 -m json.tool ${posture}`, // -m module, no quoted body
    `python3 -c open\\('${posture}','w'\\).write\\('x'\\)`, // unquoted/escaped body
    `python3 - <<PY\nopen('${posture}','w').write('x')\nPY`, // stdin heredoc (path on a later line)
    `node --eval=require('fs').writeFileSync('${posture}','x')`, // --eval= form
    `python3 write_state.py ${posture}`, // script-arg (path passed to a script) — parity case
  ];
  for (const cmd of evasions) {
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag interpreter evasion form: ${cmd}`,
    );
  }
  // A pure read via cat/jq (no python/node/ruby/perl token) MUST still pass
  // clean — the whole-command clause keys on the interpreter token.
  assert.equal(
    detectStateFileMutation(`cat ${posture} | jq .posture`, rx),
    null,
    "cat|jq read MUST NOT flag (no interpreter token)",
  );
  // Legitimate node tooling that merely NAMES a similar path MUST NOT flag:
  // STATE_PATH_RX requires `posture.json`, not `posture-gate.js`. This is the
  // false-positive guard for the whole-command clause's path conjunction.
  assert.equal(
    detectStateFileMutation("node .claude/hooks/posture-gate.js", rx),
    null,
    "node tooling on posture-gate.js MUST NOT flag (pathRx needs posture.json)",
  );
  // Prose / interpreter-as-search-arg: the interpreter is NOT the leading
  // token of any segment, so these MUST NOT flag. The leading-token anchor is
  // what keeps the clause from over-blocking relative to a bare
  // token-anywhere match (the false-positive class the old anchored deny
  // globs also did not have).
  assert.equal(
    detectStateFileMutation(`echo "python writes ${posture}"`, rx),
    null,
    "prose mentioning python + a state path MUST NOT flag (echo is the leading token)",
  );
  assert.equal(
    detectStateFileMutation(`grep python ${posture}`, rx),
    null,
    "grep with 'python' as a search arg MUST NOT flag (grep is the leading token)",
  );
});

// ============================================================================
// Post-iter-5 structural sweeps — extended SSOT MUST be empty
// ============================================================================

test("structural_sweep_with_extended_field_ssot_empty", () => {
  // Post-iter-5 sweep against the EXTENDED field-name SSOT. Any bare strict
  // compare on a login-class field anywhere in .claude/hooks/ MUST route
  // through `loginsEqual` from `lib/github-login.js`.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { GITHUB_LOGIN_FIELD_NAMES } = require(GITHUB_LOGIN);
  const pattern = `\\.(${GITHUB_LOGIN_FIELD_NAMES.join("|")})\\s*[!=]==`;
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
  // Filter:
  //   (a) type-guard patterns: `typeof X.login === "string"`.
  //   (b) comment lines (// or *) — JSDoc references to deprecated pattern.
  const lines = result.split("\n").filter((line) => {
    if (!line.trim()) return false;
    if (
      /typeof\s+[^=]+(\.|\s)(github_login|login|repo_owner|new_repo_owner|gh_login)\s*[!=]==\s*"string"/.test(
        line,
      )
    ) {
      return false;
    }
    const trimmed = line.replace(/^[^:]*:\d+:\s*/, "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return true;
  });
  assert.equal(
    lines.join("\n"),
    "",
    `Found bare login-class field strict compares. ALL such comparisons MUST route through loginsEqual() (extension path: append to GITHUB_LOGIN_FIELD_NAMES):\n${lines.join("\n")}`,
  );
});

test("structural_sweep_with_extended_localvar_ssot_empty", () => {
  // Post-iter-5 sweep against the EXTENDED local-var SSOT. Catches bare
  // strict compares on recLogin / login / victimLogin / adminLogin local
  // vars anywhere in .claude/hooks/.
  delete require.cache[require.resolve(GITHUB_LOGIN)];
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
    // typeof <expr> === "..."
    if (/typeof\s+[\w.]+\s*[!=]==\s*"\w+"/.test(line)) return false;
    // <var> === null / undefined
    if (/\b\w+\s*[!=]==\s*(null|undefined)\b/.test(line)) return false;
    const trimmed = line.replace(/^[^:]*:\d+:\s*/, "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return true;
  });
  assert.equal(
    lines.join("\n"),
    "",
    `Found bare login-class local-var strict compares (extended SSOT). Route through loginsEqual():\n${lines.join("\n")}`,
  );
});

// ============================================================================
// Constants invariants (uniqueness + non-empty)
// ============================================================================

test("ssot_constants_have_no_duplicates_post_iter5", () => {
  delete require.cache[require.resolve(GITHUB_LOGIN)];
  const { GITHUB_LOGIN_FIELD_NAMES, GITHUB_LOGIN_LOCAL_VARS } = require(
    GITHUB_LOGIN,
  );
  const fieldSet = new Set(GITHUB_LOGIN_FIELD_NAMES);
  assert.equal(
    fieldSet.size,
    GITHUB_LOGIN_FIELD_NAMES.length,
    `GITHUB_LOGIN_FIELD_NAMES has duplicates: ${GITHUB_LOGIN_FIELD_NAMES}`,
  );
  const varSet = new Set(GITHUB_LOGIN_LOCAL_VARS);
  assert.equal(
    varSet.size,
    GITHUB_LOGIN_LOCAL_VARS.length,
    `GITHUB_LOGIN_LOCAL_VARS has duplicates: ${GITHUB_LOGIN_LOCAL_VARS}`,
  );
});
