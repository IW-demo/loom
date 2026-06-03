/**
 * Tier-2 integration test: R8 follow-ups (Shard M6 D Step 4a/4b/4c).
 *
 * Verifies the three R8 fixes:
 *
 *   R8-LOW-2: sessionend's computeOwnChainHead wraps the SSOT helper
 *             at coordination-log.js::computeOwnChainHead. The parity
 *             test at m6-d-coordination-log-helper.test.js verifies
 *             the helper itself; this test verifies sessionend's
 *             wrapper now delegates (the consumer-migration check).
 *
 *   R8-MED:  detectPendingGateApprovals's legacy flat-shape branch
 *             at multi-operator-sessionstart.js:493-506 only fires
 *             under COC_TEST_PENDING_GATE_APPROVALS. In production
 *             (env-var absent) the flat shape is ignored.
 *
 *   R8-LOW-1: sessionend's checkpoint-skipped path now emits a
 *             visible advisory — stderr line + signed coordination-
 *             log `checkpoint-skipped` record naming the cosigner's
 *             person_id.
 *
 * Tier-2 discipline: real Node subprocess invocation of the hooks,
 * real filesystem, no mocking of crypto/fold semantics.
 *
 * Per probe-driven-verification.md Rule 3: structural assertions —
 * function-source grep for delegation pattern, JSON parse of hook
 * output, file-presence + JSON parse of emitted records.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SESSIONEND_HOOK = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "multi-operator-sessionend.js",
);
const SESSIONSTART_HOOK = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "multi-operator-sessionstart.js",
);
const COORDINATION_LOG = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "coordination-log.js",
);

function mkTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m6d-r8-followup-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "learning", ".initialized"), "");
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ---- R8-LOW-2: consumer-migration verification ----------------------------

test("R8-LOW-2: sessionend.computeOwnChainHead delegates to coordination-log SSOT", () => {
  // Structural verification: grep the sessionend source for the
  // delegation pattern. The wrapper MUST call the SSOT helper via
  // require(...) — NOT contain an inline copy of the chain-head walk.
  const src = fs.readFileSync(SESSIONEND_HOOK, "utf8");
  // Wrapper present.
  assert.match(src, /function computeOwnChainHead\(folded, ownVerifiedId\)/);
  // Delegation pattern (require of coordination-log + ssot call).
  assert.match(src, /require\(\s*[^)]*"coordination-log\.js"[^)]*\)/);
  assert.match(src, /computeOwnChainHead: ssot/);
  // Inline copy of the walk MUST be gone (no `let head = null;` + the
  // record loop together inside this function). The inlined version
  // had both; the SSOT-delegating version has neither.
  const fn = src.match(
    /function computeOwnChainHead\(folded, ownVerifiedId\)[\s\S]{0,1500}/,
  );
  assert.ok(fn, "function body found");
  // The remaining body MUST NOT include the inline walk markers.
  assert.equal(
    /let head = null;[\s\S]+for \(const r of records\)/.test(fn[0]),
    false,
    "inline walk MUST NOT survive in the wrapper",
  );
});

test("R8-LOW-2: coordination-log exports computeOwnChainHead as public helper", () => {
  const mod = require(COORDINATION_LOG);
  assert.equal(typeof mod.computeOwnChainHead, "function");
});

// ---- R8-MED: env-gate on legacy flat-shape branch -------------------------

test("R8-MED: legacy flat-shape branch only fires under COC_TEST_PENDING_GATE_APPROVALS", () => {
  const src = fs.readFileSync(SESSIONSTART_HOOK, "utf8");
  const lines = src.split("\n");
  // Locate the legacy-flat-shape region by its comment anchor (the
  // line beginning "// Legacy flat shape — pre-iter-6 test fixtures").
  // Within the next 25 lines, verify the env-gate `continue` appears
  // BEFORE the flat-shape `r.approver_verified_id` filter.
  const legacyIdx = lines.findIndex((l) =>
    /\/\/ Legacy flat shape — pre-iter-6 test fixtures/.test(l),
  );
  assert.notEqual(legacyIdx, -1, "legacy flat-shape comment anchor present");
  const window = lines.slice(legacyIdx, legacyIdx + 25).join("\n");
  const envGateMatch = window.match(
    /if \(!process\.env\.COC_TEST_PENDING_GATE_APPROVALS\) continue;/,
  );
  assert.ok(envGateMatch, "env-gate continue MUST be in the legacy region");
  const approverIdx = window.indexOf(
    "r.approver_verified_id !== ownVerifiedId",
  );
  const gateIdx = window.indexOf(envGateMatch[0]);
  assert.ok(
    gateIdx >= 0 && approverIdx > gateIdx,
    "env-gate continue MUST precede the flat-shape approver filter",
  );
});

// ---- R8-LOW-1: visible advisory on cosigner-skip --------------------------

test("R8-LOW-1: sessionend cosigner-skip emits stderr + coordination-log advisory", () => {
  const src = fs.readFileSync(SESSIONEND_HOOK, "utf8");
  // Stderr emission.
  assert.match(
    src,
    /process\.stderr\.write\([^)]*checkpoint skipped — cosigner coordination required/,
  );
  // Coordination-log record emission with correct shape.
  assert.match(src, /type:\s*"checkpoint-skipped"/);
  assert.match(src, /reason:\s*"cosigner-coordination-required"/);
  assert.match(src, /cosigner_person_id:\s*cosigner\.person_id/);
});

test("R8-LOW-1: cosigner-skip end-to-end — sessionend emits checkpoint-skipped record", () => {
  // E2E: invoke the sessionend hook with a roster carrying TWO owner
  // entries (so findOwnerCosigner returns non-null) under
  // COC_TEST_FORCE_CHECKPOINT=1 + COC_TEST_SKIP_SIGN=1; verify the
  // coordination-log.jsonl carries the checkpoint-skipped record.
  const dir = mkTempRepo();
  try {
    // Two-owner roster — alice runs sessionend, bob is the cosigner.
    const roster = {
      schema_version: 2,
      genesis: { generation: 0, anchor_seq: 0 },
      persons: {
        alice: {
          person_id: "alice",
          role: "owner",
          display_id: "alice",
          fingerprints: ["fp-alice"],
          gh_login: "alice-gh",
        },
        bob: {
          person_id: "bob",
          role: "owner",
          display_id: "bob",
          fingerprints: ["fp-bob"],
          gh_login: "bob-gh",
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, ".claude", "operators.roster.json"),
      JSON.stringify(roster, null, 2),
    );

    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      COC_TEST_FINGERPRINT: "fp-alice",
      COC_TEST_PERSON_ID: "alice",
      COC_TEST_FORCE_CHECKPOINT: "1",
      COC_TEST_SKIP_SIGN: "1",
    };
    const r = spawnSync("node", [SESSIONEND_HOOK], {
      env,
      input: "",
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(r.status, 0, `hook exit 0; stderr=${r.stderr}`);

    // The stderr advisory MUST be present.
    assert.match(
      r.stderr,
      /checkpoint skipped — cosigner coordination required/,
    );
    assert.match(r.stderr, /cosigner\.person_id=bob/);

    // The coordination-log record MUST be appended.
    const logPath = path.join(
      dir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    assert.equal(fs.existsSync(logPath), true);
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const skip = lines.find((l) => l.type === "checkpoint-skipped");
    assert.ok(skip, "checkpoint-skipped record present");
    assert.equal(skip.content.reason, "cosigner-coordination-required");
    assert.equal(skip.content.cosigner_person_id, "bob");
    assert.equal(skip.verified_id, "fp-alice");
    assert.equal(skip.person_id, "alice");
  } finally {
    cleanup(dir);
  }
});
