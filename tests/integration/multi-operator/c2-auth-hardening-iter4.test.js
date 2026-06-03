/**
 * Tier-2 integration tests for F14 C2-auth-hardening iter-4 shard.
 *
 * /redteam R4 against PR #320 (iter-3) surfaced one MORE level of the
 * same-bug-class pattern: the iter-3 sweep regex was FIELD-NAME-anchored,
 * not SEMANTIC-CLASS-anchored. R4 quality found `repo_owner` (different
 * field name, same semantic class) and R4 security found local-var-
 * assigned login compares (`externalOwner !== declaredOwner`,
 * `authorLogin === declaredOwner`).
 *
 * This is the FINAL hardening shard. After this lands, the structural
 * sweep MUST catch BOTH (a) all known GitHub-login-class field names AND
 * (b) local-var-assigned login compare patterns. Any future drift fails
 * CI immediately because the sweep regex is sourced from two exported
 * SSOT constants in lib/github-login.js (GITHUB_LOGIN_FIELD_NAMES +
 * GITHUB_LOGIN_LOCAL_VARS).
 *
 * Findings closed:
 *
 *   HIGH-R4-1: genesis-ceremony.js line 295-303 + 432-433 — strict `!==`
 *     and `===` on local-var-assigned login compares (externalOwner,
 *     declaredOwner, authorLogin, authorName). Routed through loginsEqual.
 *
 *   MED-R4-1: fold-genesis-anchor.js line 145 — _pinnedFactsMatch
 *     compared `a.repo_owner === b.repo_owner` strict. repo_owner is a
 *     GitHub login (kind=user) or org name (kind=org), both ASCII-only
 *     case-insensitive on GitHub. Routed through loginsEqual.
 *
 *   MED-R4-2: tests/integration/multi-operator/c2-auth-hardening-iter3.test.js
 *     line 199 — sweep regex was field-name-anchored. Tightened to
 *     consume GITHUB_LOGIN_FIELD_NAMES + GITHUB_LOGIN_LOCAL_VARS SSOT
 *     constants exported from lib/github-login.js. Adding a new login-
 *     class field or local-var requires updating the constants — and
 *     the sweep automatically covers the new name.
 *
 *   MED-R4-3: validate-bash-command.js line 204-205 — STATE_PATH_RX did
 *     not cover .claude/operators.roster.json or
 *     .claude/learning/coordination-log.jsonl. A `cat > .claude/
 *     operators.roster.json << EOF` heredoc bypassed both the deny matrix
 *     (no cat: entry) AND the Layer-1 redirect detector. Extended.
 *
 *   LOW-R4-4: lib/tool-classes.js JSDoc + cc-artifacts.md Rule 8 —
 *     documented the extension path for new mutation tools.
 *
 *   LOW-R4-5: lib/github-login.js normalizeLogin — ASCII assertion as
 *     defense-in-depth against Turkish-I / NFC variant case-folding
 *     bypass (`İlhan`.toLowerCase() !== "ilhan" on locale-aware engines).
 *
 * Run via:
 *   node --test tests/integration/multi-operator/c2-auth-hardening-iter4.test.js
 *
 * Tier-2 discipline: real fs + real validate-bash-command + real
 * normalizeLogin + real loginsEqual (rules/testing.md § Tier 2).
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
const GENESIS_CEREMONY = path.join(LIB_DIR, "genesis-ceremony.js");
const FOLD_GENESIS_ANCHOR = path.join(LIB_DIR, "fold-genesis-anchor.js");
const VALIDATE_BASH = path.join(HOOKS_DIR, "validate-bash-command.js");
const VIOLATION_PATTERNS = path.join(LIB_DIR, "violation-patterns.js");

// ============================================================================
// LOW-R4-5 — normalizeLogin ASCII guard (defense-in-depth)
// ============================================================================

test("normalize_login_rejects_non_ascii", () => {
  // Turkish-I / NFC variant: locale-aware case-fold of "İlhan" can resolve
  // to "ilhan" on some engines, which would let a non-ASCII login match
  // an ASCII roster entry. GitHub logins are ASCII-only per
  // `^[a-zA-Z0-9-]` so any non-ASCII input is structurally invalid.
  // Defense-in-depth: reject non-ASCII before .toLowerCase() so the
  // case-fold attack surface is closed even if a malformed login slips
  // past upstream validation.
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin("İlhan"), null);
  assert.equal(normalizeLogin("élise"), null);
  assert.equal(normalizeLogin("useré"), null);
  assert.equal(normalizeLogin("\u{1F600}"), null);
});

test("normalize_login_accepts_ascii_login", () => {
  // Regression-block: the ASCII guard MUST NOT reject valid GitHub
  // logins. Lowercase + uppercase + hyphen + digits are all legal.
  const { normalizeLogin } = require(GITHUB_LOGIN);
  assert.equal(normalizeLogin("Alice"), "alice");
  assert.equal(normalizeLogin("ALICE"), "alice");
  assert.equal(normalizeLogin("alice"), "alice");
  assert.equal(normalizeLogin("alice-bot"), "alice-bot");
  assert.equal(normalizeLogin("user-42"), "user-42");
  // F14 M5-B2 iter-5 R5-LOW-1 update: empty-string was previously preserved
  // (the ASCII regex /^[\x00-\x7f]*$/ allows zero chars). Iter-5 added an
  // explicit length-0 guard inside normalizeLogin, so empty-string now
  // returns null — the safety property is structural rather than
  // upstream-dependent. See `m5-b2-iter5-ssot.test.js::
  // normalize_login_rejects_empty_string_after_iter5` for the iter-5
  // assertion this regression-block was rewritten against.
  assert.equal(normalizeLogin(""), null);
});

test("logins_equal_rejects_non_ascii_after_iter4", () => {
  // Composite: loginsEqual delegates to normalizeLogin, so the ASCII
  // guard cascades through. A non-ASCII login can never equal an ASCII
  // login, even if they share a locale-folded prefix.
  const { loginsEqual } = require(GITHUB_LOGIN);
  assert.equal(loginsEqual("İlhan", "ilhan"), false);
  assert.equal(loginsEqual("ilhan", "İlhan"), false);
  assert.equal(loginsEqual("İlhan", "İlhan"), false); // both non-ASCII → both null → false
});

// ============================================================================
// MED-R4-2 — Semantic-class enumeration SSOT constants
// ============================================================================

test("github_login_field_names_constant_present", () => {
  // SSOT: every GitHub-login-class field name lives in this constant.
  // The structural sweep regex consumes the constant; adding a new
  // login-class field name requires updating this list AND the sweep
  // automatically covers it.
  const { GITHUB_LOGIN_FIELD_NAMES } = require(GITHUB_LOGIN);
  assert.ok(
    Array.isArray(GITHUB_LOGIN_FIELD_NAMES),
    "GITHUB_LOGIN_FIELD_NAMES MUST be an array (SSOT export)",
  );
  // Mandatory field-name coverage (iter-3 set + iter-4 additions):
  const required = ["github_login", "login", "repo_owner", "new_repo_owner"];
  for (const name of required) {
    assert.ok(
      GITHUB_LOGIN_FIELD_NAMES.includes(name),
      `GITHUB_LOGIN_FIELD_NAMES MUST include ${name}; got ${JSON.stringify(GITHUB_LOGIN_FIELD_NAMES)}`,
    );
  }
});

test("github_login_local_vars_constant_present", () => {
  // SSOT: every local-var name that holds a GitHub-login-class value
  // lives in this constant. Catches the iter-3 sweep miss (R4-security):
  // `externalOwner === declaredOwner` was field-name-prefix-less.
  const { GITHUB_LOGIN_LOCAL_VARS } = require(GITHUB_LOGIN);
  assert.ok(
    Array.isArray(GITHUB_LOGIN_LOCAL_VARS),
    "GITHUB_LOGIN_LOCAL_VARS MUST be an array (SSOT export)",
  );
  const required = [
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
  ];
  for (const name of required) {
    assert.ok(
      GITHUB_LOGIN_LOCAL_VARS.includes(name),
      `GITHUB_LOGIN_LOCAL_VARS MUST include ${name}; got ${JSON.stringify(GITHUB_LOGIN_LOCAL_VARS)}`,
    );
  }
});

test("github_login_constants_have_no_duplicates", () => {
  // SSOT hygiene: duplicates in the lists silently inflate the sweep
  // regex without changing coverage. Catch at test-time.
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

// ============================================================================
// MED-R4-2 — Structural sweeps post-iter-4 (semantic-class enumeration)
// ============================================================================

test("structural_sweep_no_bare_field_login_compares_remains", () => {
  // Post-iter-4 sweep: extended field-name list (iter-3 + repo_owner +
  // new_repo_owner). MUST return ZERO hits across .claude/hooks/.
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
  //   (b) comment/docstring lines (// or *) — references in JSDoc to the
  //       deprecated pattern (e.g., backticked `.github_login ===` literals
  //       in the SSOT JSDoc explaining the iter-3→iter-4 transition) are
  //       not real bug sites.
  // F14 M5-B2 iter-5: build the typeof-guard filter from the SAME SSOT
  // constant the sweep regex consumes, so adding a new field name to
  // `GITHUB_LOGIN_FIELD_NAMES` automatically extends both halves —
  // the bare-compare flagger AND the type-guard filter — without
  // requiring a second test-file edit.
  const typeofGuardRe = new RegExp(
    `typeof\\s+[^=]+(\\.|\\s)(${GITHUB_LOGIN_FIELD_NAMES.join("|")})\\s*[!=]==\\s*"string"`,
  );
  const lines = result.split("\n").filter((line) => {
    if (!line.trim()) return false;
    if (typeofGuardRe.test(line)) {
      return false;
    }
    // Strip "file:line:" prefix; check if the remainder is a comment.
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

test("structural_sweep_no_bare_local_var_login_compares", () => {
  // Iter-4 new sweep: local-var-assigned login compares (the R4-security
  // miss). Catches `externalOwner !== declaredOwner` and siblings.
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
  // Filter: comments + null-checks + string-literal compares.
  // The bug class is value-vs-value strict equality on login-class
  // local vars. `typeof X === "string"` / `X === null` / `X === undefined`
  // are type/null checks, not login-value compares.
  const lines = result.split("\n").filter((line) => {
    if (!line.trim()) return false;
    // typeof <var-or-property-access> === "string" / "undefined" / "object"
    // (matches `typeof X === "string"` AND `typeof obj.X === "string"`)
    if (/typeof\s+[\w.]+\s*[!=]==\s*"\w+"/.test(line)) return false;
    // <var> === null / undefined
    if (/\b\w+\s*[!=]==\s*(null|undefined)\b/.test(line)) return false;
    // Comment-only lines (// or *).
    const trimmed = line.replace(/^[^:]*:\d+:\s*/, "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return true;
  });
  assert.equal(
    lines.join("\n"),
    "",
    `Found bare local-var login-class strict compares. ALL such compares MUST route through loginsEqual() from lib/github-login.js (extension path: append to GITHUB_LOGIN_LOCAL_VARS):\n${lines.join("\n")}`,
  );
});

// ============================================================================
// HIGH-R4-1 — genesis-ceremony.js external-owner + author-login case-insensitive
// ============================================================================

test("genesis_ceremony_step2_uses_loginsEqual_for_external_owner", () => {
  // Source check: genesis-ceremony.js line ~295-303 was
  // `if (externalOwner !== declaredOwner)` strict. iter-4 fix routes
  // through loginsEqual.
  const src = fs.readFileSync(GENESIS_CEREMONY, "utf8");
  // The file already required github-login (for validators); now MUST
  // use loginsEqual on the externalOwner compare.
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "genesis-ceremony.js MUST call loginsEqual() (was strict !==)",
  );
  // Negative: NO bare `externalOwner !== declaredOwner` or
  // `externalOwner === declaredOwner`.
  assert.equal(
    /externalOwner\s*[!=]==\s*declaredOwner/.test(src),
    false,
    "genesis-ceremony.js MUST NOT have bare externalOwner strict compare",
  );
});

test("genesis_ceremony_step4_uses_loginsEqual_for_author_login", () => {
  // Source check: genesis-ceremony.js line ~432-433 was
  // `matches = authorLogin === declaredOwner || authorName === declaredOwner`.
  const src = fs.readFileSync(GENESIS_CEREMONY, "utf8");
  // Negative: NO bare `authorLogin === declaredOwner` or
  // `authorName === declaredOwner`.
  assert.equal(
    /authorLogin\s*[!=]==\s*declaredOwner/.test(src),
    false,
    "genesis-ceremony.js MUST NOT have bare authorLogin strict compare",
  );
  assert.equal(
    /authorName\s*[!=]==\s*declaredOwner/.test(src),
    false,
    "genesis-ceremony.js MUST NOT have bare authorName strict compare",
  );
});

test("genesis_ceremony_step2_external_owner_case_insensitive", () => {
  // Behavioral: roster declares "alice", gh-api returns owner.login "Alice".
  // Pre-iter-4, strict `!==` would reject. iter-4 loginsEqual routes
  // through normalizeLogin; ceremony proceeds.
  const cosign = require(path.join(LIB_DIR, "coc-sign.js"));
  const { runEnrollmentCeremony } = require(GENESIS_CEREMONY);

  // Fake gh-api: returns "Alice" for the owner (mixed-case), valid commit.
  const fakeGhApi = (endpoint) => {
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      return {
        ok: true,
        status: 200,
        body: {
          owner: { login: "Alice", id: 1, type: "User" },
          name: "demo",
          full_name: "alice/demo",
          private: false,
        },
      };
    }
    if (/commits/.test(endpoint)) {
      return {
        ok: true,
        status: 200,
        body: {
          sha: "abc123",
          commit: {
            verification: { verified: true, reason: "valid", signature: "s" },
            author: {
              name: "alice",
              email: "a@example.com",
              date: "2026-05-21T00:00:00Z",
            },
          },
          author: { login: "alice", id: 1, type: "User" },
        },
      };
    }
    return { ok: false, status: 404, body: {} };
  };

  const roster = {
    schema_version: 2,
    genesis: {
      repo_owner: "alice", // lowercase in roster
      repo_owner_kind: "user",
      root_commit: "abc123",
      genesis_generation: 0,
    },
    persons: {
      "person:owner-alpha": {
        role: "owner",
        github_login: "alice",
        keys: [{ fingerprint: "SHA256:test-fp", type: "ssh" }],
      },
    },
  };

  // Inject a stub sign function so we don't need real crypto.
  const fakeSign = () => ({ ok: true, sig: "test-signature" });
  const fakeTransportAppend = (_record) => ({ ok: true });

  const result = runEnrollmentCeremony({
    roster,
    repo: { owner: "alice", name: "demo" },
    signingKeyPath: "/dev/null",
    signingKeyFingerprint: "SHA256:test-fp",
    ghApi: fakeGhApi,
    transportAppend: fakeTransportAppend,
    sign: fakeSign,
  });

  // Pre-iter-4: strict `!==` on `externalOwner ("Alice") !== declaredOwner
  // ("alice")` would return {ok: false, error: "owner_mismatch"} at step 2.
  // Post-iter-4 with loginsEqual: ceremony proceeds (step 2 passes).
  assert.ok(
    result.ok,
    `genesis ceremony MUST succeed when gh-api returns case-mismatched login (roster "alice" vs gh-api "Alice"); got ${JSON.stringify(result)}`,
  );
});

test("genesis_ceremony_step4_author_login_case_insensitive", () => {
  // Behavioral: root commit author.login is "Alice" (mixed case) while
  // declaredOwner is "alice". Step 4's match check goes through loginsEqual.
  const { runEnrollmentCeremony } = require(GENESIS_CEREMONY);

  const fakeGhApi = (endpoint) => {
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      return {
        ok: true,
        status: 200,
        body: {
          owner: { login: "alice", id: 1, type: "User" },
          name: "demo",
          full_name: "alice/demo",
          private: false,
        },
      };
    }
    if (/commits/.test(endpoint)) {
      return {
        ok: true,
        status: 200,
        body: {
          sha: "abc123",
          commit: {
            verification: { verified: true, reason: "valid", signature: "s" },
            author: {
              name: "Alice",
              email: "a@example.com",
              date: "2026-05-21T00:00:00Z",
            }, // mixed case
          },
          author: { login: "Alice", id: 1, type: "User" }, // mixed case
        },
      };
    }
    return { ok: false, status: 404, body: {} };
  };

  const roster = {
    schema_version: 2,
    genesis: {
      repo_owner: "alice", // lowercase
      repo_owner_kind: "user",
      root_commit: "abc123",
      genesis_generation: 0,
    },
    persons: {
      "person:owner-alpha": {
        role: "owner",
        github_login: "alice",
        keys: [{ fingerprint: "SHA256:test-fp", type: "ssh" }],
      },
    },
  };

  const fakeSign = () => ({ ok: true, sig: "test-signature" });
  const fakeTransportAppend = (_record) => ({ ok: true });

  const result = runEnrollmentCeremony({
    roster,
    repo: { owner: "alice", name: "demo" },
    signingKeyPath: "/dev/null",
    signingKeyFingerprint: "SHA256:test-fp",
    ghApi: fakeGhApi,
    transportAppend: fakeTransportAppend,
    sign: fakeSign,
  });

  assert.ok(
    result.ok,
    `genesis ceremony step 4 MUST match author.login case-insensitively; got ${JSON.stringify(result)}`,
  );
});

// ============================================================================
// MED-R4-1 — fold-genesis-anchor.js _pinnedFactsMatch case-insensitive
// ============================================================================

test("fold_genesis_anchor_pinned_facts_uses_loginsEqual_for_repo_owner", () => {
  const src = fs.readFileSync(FOLD_GENESIS_ANCHOR, "utf8");
  // Negative: NO bare `a.repo_owner === b.repo_owner` strict compare.
  assert.equal(
    /a\.repo_owner\s*===\s*b\.repo_owner/.test(src),
    false,
    "fold-genesis-anchor.js MUST NOT have bare repo_owner strict compare",
  );
  // Positive: routes through loginsEqual (already imported).
  assert.ok(
    /loginsEqual\s*\(/.test(src),
    "fold-genesis-anchor.js MUST call loginsEqual() for repo_owner compare",
  );
});

test("fold_genesis_anchor_pinned_facts_repo_owner_case_insensitive", () => {
  // Behavioral: two pinned-fact records with case-mismatched repo_owner
  // MUST be recognized as equivalent (not declared a fork).
  const { _internal } = require(FOLD_GENESIS_ANCHOR);
  const { _pinnedFactsMatch } = _internal;
  assert.ok(
    _pinnedFactsMatch(
      { repo_owner: "Alice", repo_owner_kind: "user", root_commit: "abc" },
      { repo_owner: "alice", repo_owner_kind: "user", root_commit: "abc" },
    ),
    "pinned-facts compare MUST be case-insensitive on repo_owner",
  );
  // Negative: different root_commit → still mismatch (the other invariants
  // continue to work).
  assert.equal(
    _pinnedFactsMatch(
      { repo_owner: "Alice", repo_owner_kind: "user", root_commit: "abc" },
      { repo_owner: "alice", repo_owner_kind: "user", root_commit: "xyz" },
    ),
    false,
    "pinned-facts compare MUST still reject when root_commit differs",
  );
  // Negative: different repo_owner_kind → mismatch.
  assert.equal(
    _pinnedFactsMatch(
      { repo_owner: "Alice", repo_owner_kind: "user", root_commit: "abc" },
      { repo_owner: "alice", repo_owner_kind: "org", root_commit: "abc" },
    ),
    false,
    "pinned-facts compare MUST still reject when repo_owner_kind differs",
  );
});

// ============================================================================
// MED-R4-3 — validate-bash-command.js STATE_PATH_RX coverage extension
// ============================================================================

test("state_path_rx_covers_roster_and_coordination_log", () => {
  // Source check: STATE_PATH_RX regex MUST match
  // .claude/operators.roster.json + .claude/learning/coordination-log.jsonl
  // in addition to the iter-3 set (posture.json, violations.jsonl,
  // .initialized).
  const src = fs.readFileSync(VALIDATE_BASH, "utf8");
  const rxMatch = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(rxMatch, "validate-bash-command.js MUST declare STATE_PATH_RX");

  // Reconstruct the regex by evaluating the matched literal — safe
  // because we control the source.
  const rxLiteral = rxMatch[1].trim();
  // Re-parse from source so the test exercises the actual regex.
  // eslint-disable-next-line no-eval
  const rx = eval(rxLiteral);
  assert.ok(
    rx.test(".claude/operators.roster.json"),
    "STATE_PATH_RX MUST cover .claude/operators.roster.json",
  );
  assert.ok(
    rx.test(".claude/learning/coordination-log.jsonl"),
    "STATE_PATH_RX MUST cover .claude/learning/coordination-log.jsonl",
  );
  // Iter-3 coverage preserved:
  assert.ok(
    rx.test(".claude/learning/posture.json"),
    "STATE_PATH_RX MUST still cover .claude/learning/posture.json",
  );
  assert.ok(
    rx.test(".claude/learning/violations.jsonl"),
    "STATE_PATH_RX MUST still cover .claude/learning/violations.jsonl",
  );
  assert.ok(
    rx.test(".claude/learning/.initialized"),
    "STATE_PATH_RX MUST still cover .claude/learning/.initialized",
  );
});

test("state_path_rx_blocks_cat_heredoc_to_roster", () => {
  // End-to-end: synthesize a Bash command that uses a heredoc redirect
  // to write the roster file. The detectStateFileMutation predicate MUST
  // fire (Layer 1: redirect detector).
  const { detectStateFileMutation } = require(VIOLATION_PATTERNS);
  const STATE_PATH_RX =
    /\.claude\/(?:learning\/(?:posture\.json(?:\.bak|\.tmp\.\d+)?|violations\.jsonl(?:\.[A-Za-z0-9_-]+)?|coordination-log\.jsonl|\.initialized)|operators\.roster\.json)\b/;
  const cmd = "cat > .claude/operators.roster.json << EOF\n{}\nEOF";
  const result = detectStateFileMutation(cmd, STATE_PATH_RX);
  assert.ok(
    result,
    `detectStateFileMutation MUST flag cat-heredoc to .claude/operators.roster.json; got ${JSON.stringify(result)}`,
  );
  assert.ok(
    typeof result.layer === "number" || typeof result.layer === "string",
    `result MUST include layer field; got ${JSON.stringify(result)}`,
  );
});

test("state_path_rx_blocks_cat_heredoc_to_coordination_log", () => {
  // Same as above but for coordination-log.jsonl — the other gap.
  const { detectStateFileMutation } = require(VIOLATION_PATTERNS);
  const STATE_PATH_RX =
    /\.claude\/(?:learning\/(?:posture\.json(?:\.bak|\.tmp\.\d+)?|violations\.jsonl(?:\.[A-Za-z0-9_-]+)?|coordination-log\.jsonl|\.initialized)|operators\.roster\.json)\b/;
  const cmd = "cat > .claude/learning/coordination-log.jsonl << EOF\n{}\nEOF";
  const result = detectStateFileMutation(cmd, STATE_PATH_RX);
  assert.ok(
    result,
    `detectStateFileMutation MUST flag cat-heredoc to coordination-log.jsonl; got ${JSON.stringify(result)}`,
  );
});

test("state_path_rx_blocks_echo_redirect_to_roster", () => {
  // Layer-1 redirect detector with `echo` (a denied command but the
  // STATE_PATH_RX must also catch it independently).
  const { detectStateFileMutation } = require(VIOLATION_PATTERNS);
  const STATE_PATH_RX =
    /\.claude\/(?:learning\/(?:posture\.json(?:\.bak|\.tmp\.\d+)?|violations\.jsonl(?:\.[A-Za-z0-9_-]+)?|coordination-log\.jsonl|\.initialized)|operators\.roster\.json)\b/;
  const cmd = 'echo "tampered" > .claude/operators.roster.json';
  const result = detectStateFileMutation(cmd, STATE_PATH_RX);
  assert.ok(
    result,
    `detectStateFileMutation MUST flag echo-redirect to roster; got ${JSON.stringify(result)}`,
  );
});

// ============================================================================
// Iter-3 sweeps still clean post-iter-4 (no regression)
// ============================================================================

test("iter3_structural_sweeps_still_clean_post_iter4", () => {
  // The iter-3 mutation-tool sweep MUST still pass; iter-4 only
  // extended the login-class sweep, not the tool-class sweep.
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
    if (err.status === 1) {
      result = "";
    } else {
      throw err;
    }
  }
  assert.equal(
    result.trim(),
    "",
    `iter-3 mutation-tool sweep MUST remain clean post-iter-4; found:\n${result}`,
  );
});
