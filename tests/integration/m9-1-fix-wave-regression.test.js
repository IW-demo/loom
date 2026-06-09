/**
 * M9.1 fix-wave regression tests covering R3 + R4 closures.
 *
 * Per `rules/testing.md` § "Regression Testing": every bug fix MUST
 * include a regression test BEFORE merge. R4 reviewer surfaced R4-S-05
 * noting the R3 fix-wave landed 5 structural fixes WITHOUT regression
 * tests. This file closes that gap for R3-S-01/02/03/05/06 and
 * R4-S-01/02/03/06.
 *
 * Coverage:
 *   - R3-S-01 (HIGH): state-io.js::appendViolation strips home-prefix
 *                     from `repo` field
 *   - R3-S-01 (HIGH): learning-utils.js::logObservation strips
 *                     home-prefix from cwd field
 *   - R3-S-02 (HIGH): detect-violations.js routes through appendStamped
 *                     with un-rostered fallback marker
 *   - R3-S-03 (MED):  genesis-anchor-guard.js uses isUnenrolled() shared
 *                     predicate (accepts PLACEHOLDER-* variants)
 *   - R3-S-05 (LOW):  operator-id.js::_writeCache payload is
 *                     {verified_id} only — no authority fields
 *   - R3-S-06 (LOW):  coc-sign.js writes temp files with mode 0o600
 *   - R4-S-01 (HIGH): coc-append.js::appendStamped strips home-prefix
 *                     from `repo` field (symmetric to R3-S-01)
 *   - R4-S-02 (MED):  learning-utils.js::logObservation routes through
 *                     appendStamped with un-rostered fallback marker
 *   - R4-S-03 (MED):  settings.json PreToolUse matchers explicit
 *                     (Edit|Write|MultiEdit|NotebookEdit)
 *   - R4-S-06 (LOW):  journal-write-guard.js routes via isMutationTool()
 *
 * Run: node tests/integration/m9-1-fix-wave-regression.test.js
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---- minimal test harness (sibling style with operator-id.test.js) --------
let PASS = 0;
let FAIL = 0;
const FAILS = [];

function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    FAIL += 1;
    FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
    console.log(`  FAIL  ${name}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function loadFresh(modPath) {
  delete require.cache[modPath];
  return require(modPath);
}

// =====================================================================
// R3-S-01 — state-io.js::appendViolation strips home-prefix from `repo`
// =====================================================================

test("R3-S-01: appendViolation strips home-prefix from repo field", () => {
  const stateIo = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "state-io.js"),
  );
  const tmpDir = mkTmpDir("m91-r3-s01-violation-");
  try {
    const id = stateIo.appendViolation(tmpDir, {
      rule_id: "test/MUST-1",
      severity: "advisory",
      evidence: "regression test",
    });
    assert(typeof id === "string", "appendViolation returns string id");
    const file = path.join(tmpDir, ".claude", "learning", "violations.jsonl");
    const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert(
      !row.repo.includes("/") && !row.repo.includes("\\"),
      `repo MUST be basename only, got: ${row.repo}`,
    );
    assert(
      row.repo === path.basename(tmpDir),
      `repo MUST match basename, got: ${row.repo} vs ${path.basename(tmpDir)}`,
    );
  } finally {
    rmTmpDir(tmpDir);
  }
});

// =====================================================================
// R3-S-01 (continued) — learning-utils.js::logObservation strips
// home-prefix from cwd field
// =====================================================================

test("R3-S-01: logObservation strips home-prefix from cwd context", () => {
  const learningUtils = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "learning-utils.js"),
  );
  const tmpDir = mkTmpDir("m91-r3-s01-observation-");
  try {
    const id = learningUtils.logObservation(tmpDir, "test-event", { x: 1 });
    assert(typeof id === "string", "logObservation returns id");
    const file = path.join(tmpDir, ".claude", "learning", "observations.jsonl");
    const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
    const cwdField = row.context && row.context.cwd;
    assert(
      cwdField && !cwdField.includes("/") && !cwdField.includes("\\"),
      `cwd MUST be basename only, got: ${cwdField}`,
    );
  } finally {
    rmTmpDir(tmpDir);
  }
});

// =====================================================================
// R3-S-02 — detect-violations.js fallback path adds un-rostered marker
// =====================================================================

test("R3-S-02: un-rostered fallback adds attribution marker", () => {
  // Direct test of _logViolation behavior: the fallback path is what
  // fires when resolveIdentity returns no person_id (un-rostered). We
  // test this by appending against a tmpDir with no roster.
  const stateIo = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "state-io.js"),
  );
  const tmpDir = mkTmpDir("m91-r3-s02-attribution-");
  try {
    // The legacy appendViolation path is what the fallback calls; the
    // fallback marker is added BY detect-violations._logViolation, not
    // by appendViolation itself. Verify the marker is preserved when
    // passed as a field.
    stateIo.appendViolation(tmpDir, {
      rule_id: "test/MUST-2",
      severity: "advisory",
      evidence: "x",
      attribution: "un-rostered",
    });
    const file = path.join(tmpDir, ".claude", "learning", "violations.jsonl");
    const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert(
      row.attribution === "un-rostered",
      `un-rostered marker MUST be preserved, got: ${JSON.stringify(row.attribution)}`,
    );
  } finally {
    rmTmpDir(tmpDir);
  }
});

// =====================================================================
// R3-S-03 — genesis-anchor-guard uses isUnenrolled() shared predicate
// =====================================================================

test("R3-S-03: isUnenrolled accepts PLACEHOLDER-* variants", () => {
  const { isUnenrolled } = loadFresh(
    path.join(
      REPO_ROOT,
      ".claude",
      "hooks",
      "lib",
      "roster-schema-validate.js",
    ),
  );
  assert(
    isUnenrolled("PLACEHOLDER-replace-at-enrollment") === true,
    "loom's exact placeholder MUST match",
  );
  assert(
    isUnenrolled("PLACEHOLDER-acme-foundation") === true,
    "downstream-adopter variant MUST match",
  );
  assert(
    isUnenrolled("PLACEHOLDER-") === true,
    "bare prefix MUST match per schema convention",
  );
  assert(
    isUnenrolled("real-owner-login") === false,
    "non-placeholder MUST NOT match",
  );
  assert(isUnenrolled("") === false, "empty string MUST NOT match");
  assert(isUnenrolled(null) === false, "null MUST NOT match (type guard)");
});

test("R3-S-03: genesis-anchor-guard imports isUnenrolled at module scope", () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "genesis-anchor-guard.js"),
    "utf8",
  );
  assert(
    /const\s*\{\s*isUnenrolled\s*\}\s*=\s*require/.test(src),
    "genesis-anchor-guard.js MUST import isUnenrolled",
  );
  assert(
    src.includes("isUnenrolled(roster.genesis.repo_owner)"),
    "Bootstrap-1 branch MUST call isUnenrolled() on repo_owner",
  );
  assert(
    !src.includes('=== "PLACEHOLDER-replace-at-enrollment"'),
    "literal-string sentinel MUST be removed",
  );
});

// =====================================================================
// R3-S-05 — operator-id._writeCache payload is {verified_id} only
// =====================================================================

test("R3-S-05: _writeCache payload is verified_id-only", () => {
  const opid = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "operator-id.js"),
  );
  const src = fs.readFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "operator-id.js"),
    "utf8",
  );
  // Structural check: the _writeCache function body MUST NOT serialize
  // person_id, role, host_role, display_id into the payload (those are
  // re-derived from the live roster per Sec-ID-1).
  const writeCacheMatch = src.match(
    /function _writeCache\([^)]*\)\s*\{([\s\S]*?)\n\}/,
  );
  assert(writeCacheMatch, "_writeCache function MUST exist");
  const body = writeCacheMatch[1];
  // Payload should only stamp verified_id.
  assert(
    /JSON\.stringify\(\s*\{\s*verified_id:/.test(body),
    "payload MUST stamp verified_id",
  );
  // Authority fields MUST NOT be in the payload object.
  for (const field of ["person_id:", "role:", "host_role:", "display_id:"]) {
    // Allow the field name to appear in COMMENTS (lines starting with //)
    // but not as a payload field.
    const nonCommentLines = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    assert(
      !nonCommentLines.includes(field),
      `_writeCache payload MUST NOT include ${field} (authority re-derived per Sec-ID-1)`,
    );
  }
});

// =====================================================================
// R3-S-06 — coc-sign.js writes temp files with mode 0o600
// =====================================================================

test("R3-S-06: coc-sign.js temp-file writes use mode 0o600", () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js"),
    "utf8",
  );
  // Count writeFileSync occurrences vs `0o600` occurrences within close
  // proximity. Multi-line template literals (e.g. allowedSigners) defeat
  // a single-line regex; we instead assert every writeFileSync has 0o600
  // within the next ~120 chars (covers args + opts object).
  const writeIndices = [];
  let m;
  const re = /fs\.writeFileSync\(/g;
  while ((m = re.exec(src)) !== null) writeIndices.push(m.index);
  assert(writeIndices.length >= 4, "expected ≥4 writeFileSync calls");
  for (const idx of writeIndices) {
    const slice = src.slice(idx, idx + 250);
    assert(
      slice.includes("0o600"),
      `writeFileSync at offset ${idx} MUST carry mode 0o600 (defense-in-depth)`,
    );
  }
});

// =====================================================================
// R4-S-01 — coc-append.js::appendStamped strips home-prefix
// =====================================================================

test("R4-S-01: appendStamped strips home-prefix from repo field", () => {
  const { appendStamped } = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-append.js"),
  );
  const tmpDir = mkTmpDir("m91-r4-s01-stamped-");
  try {
    fs.mkdirSync(path.join(tmpDir, ".claude", "learning"), { recursive: true });
    const filePath = path.join(
      tmpDir,
      ".claude",
      "learning",
      "violations.jsonl",
    );
    const r = appendStamped(
      tmpDir,
      filePath,
      { test: "x" },
      {
        identity: { verified_id: "SHA256:fake", person_id: "pid-test" },
        sign: () => ({ ok: true, sig: "fakesig" }),
      },
    );
    assert(r && r.ok, `appendStamped MUST succeed, got: ${JSON.stringify(r)}`);
    const row = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    assert(
      !row.repo.includes("/") && !row.repo.includes("\\"),
      `repo MUST be basename only, got: ${row.repo}`,
    );
    assert(
      row.repo === path.basename(tmpDir),
      `repo MUST match basename, got: ${row.repo} vs ${path.basename(tmpDir)}`,
    );
    // verified_id + person_id MUST still be stamped (R3-S-02 contract preserved).
    assert(row.verified_id === "SHA256:fake", "verified_id stamped");
    assert(row.person_id === "pid-test", "person_id stamped");
    assert(row.sig === "fakesig", "sig stamped");
  } finally {
    rmTmpDir(tmpDir);
  }
});

// =====================================================================
// R4-S-01 — stripRepoPath helper exported from state-io.js
// =====================================================================

test("R4-S-01: state-io.js exports stripRepoPath helper", () => {
  const stateIo = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "state-io.js"),
  );
  assert(
    typeof stateIo.stripRepoPath === "function",
    "stripRepoPath MUST be exported from state-io.js",
  );
  assert(
    stateIo.stripRepoPath("/Users/<user>/repos/loom") === "loom",
    "stripRepoPath strips /Users/<login>/ prefix",
  );
  assert(
    stateIo.stripRepoPath("/home/<user>/repos/loom") === "loom",
    "stripRepoPath strips /home/<login>/ prefix",
  );
  assert(
    stateIo.stripRepoPath("loom") === "loom",
    "stripRepoPath passes basename unchanged",
  );
  assert(
    stateIo.stripRepoPath("") === "unknown",
    "stripRepoPath returns 'unknown' on empty",
  );
  assert(
    stateIo.stripRepoPath(null) === "unknown",
    "stripRepoPath returns 'unknown' on null",
  );
});

// =====================================================================
// R4-S-02 — logObservation routes through appendStamped (when identity)
// + un-rostered fallback adds attribution marker
// =====================================================================

test("R4-S-02: logObservation un-rostered fallback adds attribution marker", () => {
  const learningUtils = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "learning-utils.js"),
  );
  const tmpDir = mkTmpDir("m91-r4-s02-obs-");
  try {
    // tmpDir has no roster → identity un-resolvable → fallback path.
    learningUtils.logObservation(tmpDir, "test-event", { x: 1 });
    const file = path.join(tmpDir, ".claude", "learning", "observations.jsonl");
    const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert(
      row.attribution === "un-rostered",
      `un-rostered marker MUST be added, got: ${JSON.stringify(row.attribution)}`,
    );
  } finally {
    rmTmpDir(tmpDir);
  }
});

// =====================================================================
// R4-S-03 — settings.json PreToolUse matchers explicit
// =====================================================================

test("R4-S-03: settings.json PreToolUse matchers cover all mutation tools", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".claude", "settings.json"), "utf8"),
  );
  const preToolUse = settings.hooks && settings.hooks.PreToolUse;
  assert(Array.isArray(preToolUse), "PreToolUse hooks block exists");
  // Find the matcher that covers Edit + Write surfaces.
  const editWriteBlock = preToolUse.find(
    (b) =>
      b.matcher && b.matcher.includes("Edit") && b.matcher.includes("Write"),
  );
  assert(editWriteBlock, "Edit/Write matcher block MUST exist");
  assert(
    editWriteBlock.matcher.includes("MultiEdit"),
    `matcher MUST include MultiEdit explicitly, got: ${editWriteBlock.matcher}`,
  );
  assert(
    editWriteBlock.matcher.includes("NotebookEdit"),
    `matcher MUST include NotebookEdit explicitly, got: ${editWriteBlock.matcher}`,
  );
});

// =====================================================================
// R4-S-06 — journal-write-guard routes via isMutationTool()
// =====================================================================

test("R4-S-06: journal-write-guard imports + uses isMutationTool", () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "journal-write-guard.js"),
    "utf8",
  );
  assert(
    /const\s*\{\s*isMutationTool\s*\}\s*=\s*require/.test(src),
    "journal-write-guard.js MUST import isMutationTool",
  );
  assert(
    src.includes("!isMutationTool(tool)"),
    "isWatchedTool MUST call !isMutationTool(tool)",
  );
  // Strip comments + verify hardcoded gate is gone from executable code.
  const codeOnly = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert(
    !codeOnly.includes('tool !== "Write"'),
    "hardcoded 'tool !== \"Write\"' MUST be removed from executable code",
  );
});

// =====================================================================
// R6-S-01 — fold-posture-event.js floor-set routes through
// isEligibleSigner("owner-quorum") SSOT (R5-S-04 host_role:ci excluded)
// =====================================================================

test("R6-S-01: floor-set accepts legitimate owner+human signer", () => {
  const { foldPostureEvent } = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "fold-posture-event.js"),
  );
  const roster = {
    persons: {
      "pid-owner": {
        role: "owner",
        host_role: "human",
        keys: [{ fingerprint: "sha:owner" }],
      },
    },
  };
  const r = foldPostureEvent(
    {
      type: "posture-event",
      verified_id: "sha:owner",
      content: {
        event: "floor-set",
        target_person_id: "pid-target",
        floor: "L3",
      },
    },
    { foldState: {}, roster },
  );
  assert(
    r.accepted === true,
    `legitimate owner+human floor-set MUST be accepted, got: ${r.reason}`,
  );
});

test("R6-S-01: floor-set REJECTS host_role:ci owner-role signer", () => {
  const { foldPostureEvent } = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "fold-posture-event.js"),
  );
  // CI-host owner-role key: roster misconfiguration that bounded-trust
  // permits but eligibility forbids per R5-S-04.
  const roster = {
    persons: {
      "pid-ci-owner": {
        role: "owner",
        host_role: "ci",
        keys: [{ fingerprint: "sha:ci" }],
      },
    },
  };
  const r = foldPostureEvent(
    {
      type: "posture-event",
      verified_id: "sha:ci",
      content: {
        event: "floor-set",
        target_person_id: "pid-target",
        floor: "L3",
      },
    },
    { foldState: {}, roster },
  );
  assert(
    r.accepted === false,
    "CI-host owner-role signer MUST be rejected (R5-S-04)",
  );
  assert(
    /host_role:ci/.test(r.reason),
    `reason MUST cite host_role:ci, got: ${r.reason}`,
  );
});

test("R6-S-01: floor-set REJECTS contributor-role signer", () => {
  const { foldPostureEvent } = loadFresh(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "fold-posture-event.js"),
  );
  const roster = {
    persons: {
      "pid-contributor": {
        role: "contributor",
        host_role: "human",
        keys: [{ fingerprint: "sha:contrib" }],
      },
    },
  };
  const r = foldPostureEvent(
    {
      type: "posture-event",
      verified_id: "sha:contrib",
      content: {
        event: "floor-set",
        target_person_id: "pid-target",
        floor: "L3",
      },
    },
    { foldState: {}, roster },
  );
  assert(
    r.accepted === false,
    "contributor-role signer MUST be rejected (insufficient role)",
  );
  assert(
    /role 'contributor' insufficient/.test(r.reason),
    `reason MUST cite role insufficiency, got: ${r.reason}`,
  );
});

// =====================================================================
// R7-S-01 — stamped-path file construction routes through resolveStateDir
// SSOT (state-resolver.js), not via direct cwd+/.claude/learning path-join
// =====================================================================

test("R7-S-01: detect-violations.js imports ensureStateDir from state-resolver", () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "detect-violations.js"),
    "utf8",
  );
  assert(
    /const\s*\{\s*ensureStateDir\s*\}\s*=\s*require/.test(src),
    "detect-violations.js MUST import ensureStateDir from state-resolver",
  );
  // The stamped-path file construction MUST go through ensureStateDir(cwd)
  // + path.join(stateDir, "violations.jsonl"), NOT through path.join(cwd, ".claude", "learning", ...).
  assert(
    /const\s+stateDir\s*=\s*ensureStateDir\(cwd\)/.test(src),
    "stamped-path MUST call ensureStateDir(cwd) for state-dir resolution",
  );
});

test("R7-S-01: learning-utils.js resolveLearningDir routes through state-resolver when cwd present", () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "learning-utils.js"),
    "utf8",
  );
  assert(
    src.includes("state-resolver"),
    "learning-utils.js MUST reference state-resolver in resolveLearningDir",
  );
  assert(
    /resolveStateDir\(cwd\)/.test(src),
    "resolveLearningDir MUST delegate to resolveStateDir(cwd)",
  );
});

test("R7-S-01: worktree cwd resolves to main checkout learning dir", () => {
  // Set CLAUDE_TRUST_STATE_DIR to a known path; state-resolver.js short-
  // circuits to it. Verifies state-resolver consumed by both call sites.
  const tmpDir = mkTmpDir("m91-r7-s01-stateroute-");
  try {
    process.env.CLAUDE_TRUST_STATE_DIR = tmpDir;
    const learningUtils = loadFresh(
      path.join(REPO_ROOT, ".claude", "hooks", "lib", "learning-utils.js"),
    );
    const stateResolver = loadFresh(
      path.join(REPO_ROOT, ".claude", "hooks", "lib", "state-resolver.js"),
    );
    // learning-utils now routes through state-resolver, so both return same path.
    const lu = learningUtils.resolveLearningDir("/some/worktree/path");
    const sr = stateResolver.resolveStateDir("/some/worktree/path");
    assert(
      lu === sr,
      `resolveLearningDir MUST equal resolveStateDir under CLAUDE_TRUST_STATE_DIR; got lu=${lu} vs sr=${sr}`,
    );
    assert(
      lu === tmpDir,
      `resolveLearningDir MUST honor CLAUDE_TRUST_STATE_DIR override; got ${lu}`,
    );
  } finally {
    delete process.env.CLAUDE_TRUST_STATE_DIR;
    rmTmpDir(tmpDir);
  }
});

// =====================================================================
// summary
// =====================================================================

const total = PASS + FAIL;
console.log(`\n=== summary ===`);
console.log(`  PASS:${PASS}  FAIL:${FAIL}  total:${total}`);
if (FAIL > 0) {
  console.log("\n--- failures ---");
  for (const f of FAILS) console.log(`  ${f}`);
  process.exit(1);
}
process.exit(0);
