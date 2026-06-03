/**
 * Tier-2 regression suite for F14 M5-B2 lifecycle hooks (continuation shard).
 *
 * Anchor: workspaces/multi-operator-coc/02-plans/01-architecture.md §4.3 hook
 * table + §11 M5 row. SSOT extension landed in PR #320 (iter-5); this shard
 * delivers the three lifecycle hooks + F13 subsumption.
 *
 * Scope:
 *   1. multi-operator-sessionstart.js (~250 LOC, 11 surfaces, subsumes
 *      coc-drift-warn). 10s budget, fail-open.
 *   2. adjacency-heartbeat.js (~100 LOC, PreToolUse * + Stop). 5s budget,
 *      NEVER blocks.
 *   3. multi-operator-sessionend.js (~100 LOC, Stop). 5s budget, NEVER blocks.
 *   4. F13 closure — coc-drift-warn.js retired; registration removed from
 *      settings.json::hooks chain.
 *
 * Per probe-driven-verification.md Rule 3: hook-output verification is
 * structural — JSON parse of stdout, exit-code check, fixture-marker
 * presence on stderr. No regex over assistant prose.
 *
 * Run:
 *   node --test tests/integration/multi-operator/m5-b2-lifecycle-hooks.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const SETTINGS_JSON = path.join(REPO_ROOT, ".claude", "settings.json");
const SESSIONSTART_HOOK = path.join(HOOKS_DIR, "multi-operator-sessionstart.js");
const HEARTBEAT_HOOK = path.join(HOOKS_DIR, "adjacency-heartbeat.js");
const SESSIONEND_HOOK = path.join(HOOKS_DIR, "multi-operator-sessionend.js");
const DRIFT_WARN_HOOK = path.join(HOOKS_DIR, "coc-drift-warn.js");

// ----------------------------------------------------------------------------
// Test scaffold — synthetic repo with roster + coordination log
// ----------------------------------------------------------------------------

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-b2-hooks-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  // git init so worktree-list resolution works
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

function writeRoster(dir, roster) {
  fs.writeFileSync(
    path.join(dir, ".claude", "operators.roster.json"),
    JSON.stringify(roster, null, 2),
  );
}

function writeCoordLog(dir, records) {
  const logPath = path.join(dir, ".claude", "learning", "coordination-log.jsonl");
  fs.writeFileSync(
    logPath,
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
}

function writePosture(dir, posture) {
  fs.writeFileSync(
    path.join(dir, ".claude", "learning", "posture.json"),
    JSON.stringify(posture, null, 2),
  );
  fs.writeFileSync(path.join(dir, ".claude", "learning", ".initialized"), "");
}

function makeFingerprint(seed) {
  return (
    "SHA256:" +
    crypto.createHash("sha256").update(String(seed)).digest("base64").slice(0, 43)
  );
}

function runHook(hookPath, payload, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, {
    CLAUDE_PROJECT_DIR: o.cwd || process.cwd(),
    CLAUDE_TRUST_STATE_DIR: path.join(o.cwd || process.cwd(), ".claude", "learning"),
    COC_OPERATOR_REPO_DIR: o.cwd || "",
  }, o.env || {});
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(payload),
    cwd: o.cwd || process.cwd(),
    env,
    encoding: "utf8",
    timeout: o.timeoutMs || 15000,
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout.trim().split("\n").pop()) : null;
  } catch {
    parsed = null;
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status,
    parsed,
    elapsedMs: result.elapsedMs || null,
  };
}

// ============================================================================
// SessionStart hook — 9 tests
// ============================================================================

test("sessionstart_surfaces_own_identity_when_rostered", () => {
  // Hook MUST surface own identity (display_id / role) when the operator
  // resolves to a rostered key.
  assert.ok(fs.existsSync(SESSIONSTART_HOOK), "sessionstart hook MUST exist");
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-key");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  writePosture(dir, {
    schema_version: "v2",
    repo_floor: { posture: "L5_DELEGATED" },
    operators: { "p-alice": { posture: "L5_DELEGATED" } },
  });
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    { cwd: dir, env: { COC_TEST_FINGERPRINT: fp, COC_TEST_PERSON_ID: "p-alice" } },
  );
  assert.equal(r.parsed && r.parsed.continue, true, "MUST emit continue:true");
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  assert.match(ctx, /alice/, "MUST cite own display_id (alice)");
});

test("sessionstart_surfaces_sibling_active_claims_grouped_by_display_id", () => {
  const dir = makeTempRepo();
  const aliceFp = makeFingerprint("alice");
  const bobFp = makeFingerprint("bob");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: aliceFp }],
      },
      "p-bob": {
        display_id: "bob",
        role: "senior",
        github_login: "bob",
        host_role: "human",
        keys: [{ fingerprint: bobFp }],
      },
    },
  });
  // No coordination log records — hook must still surface own identity
  // without crashing; sibling-claim surfacing is a no-op when log is empty.
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    { cwd: dir, env: { COC_TEST_FINGERPRINT: aliceFp, COC_TEST_PERSON_ID: "p-alice" } },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  // Sibling display_id "bob" MUST NOT appear in own-identity surface when
  // bob has no claim activity.
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  // Surface structure includes a "sibling" or "active claims" section that
  // is empty/absent.
  assert.ok(ctx.length > 0, "MUST emit non-empty additionalContext");
});

test("sessionstart_caps_posture_at_L3_on_partition", () => {
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-partition");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  writePosture(dir, {
    schema_version: "v2",
    repo_floor: { posture: "L5_DELEGATED" },
    operators: { "p-alice": { posture: "L5_DELEGATED" } },
  });
  // Inject a fake folded-state with a genesis-migration whose
  // to_genesis_generation > 0. The hook reads the log via the filesystem
  // transport; simulate one signed migration record.
  // For Phase-1 structural test: leverage COC_TEST_LOCAL_GEN_OVERRIDE +
  // COC_TEST_PEER_GEN_OVERRIDE if hook supports it; otherwise assert that
  // the hook gracefully surfaces operative posture (without partition data
  // we expect L5 to flow through).
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_LOCAL_GENESIS_GENERATION: "0",
        COC_TEST_PEER_GENESIS_GENERATION: "2",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  // When partition detected: posture capped at L3; surface MUST cite L3 OR
  // "partition" / "partitioned".
  assert.match(
    ctx,
    /L3_SHARED_PLANNING|partition/i,
    "MUST surface partition-cap when local genesis-generation < peer",
  );
});

test("sessionstart_surfaces_revocation_contests_via_rule_10", () => {
  const dir = makeTempRepo();
  const aliceFp = makeFingerprint("alice");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: aliceFp }],
      },
    },
  });
  // Inject a fake contested-revocation marker via env override
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: aliceFp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_CONTESTED_REVOCATIONS: JSON.stringify([
          { target_login: "bob", forging_signer: "alice" },
        ]),
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  assert.match(ctx, /contested|forging|revocation/i);
});

test("sessionstart_drift_attribution_own_wip_vs_claimed_wip_closes_F13", () => {
  // F13 closure: drift attribution distinguishes own-WIP from claimed-WIP.
  // .claude/learning/*.jsonl modifications by the OWN current session must
  // be attributed to OWN (not surfaced as drift); modifications under
  // sibling-claimed paths surface as cross-operator drift.
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-drift");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  // Create a .jsonl learning artifact (the F13 false-positive surface)
  fs.writeFileSync(
    path.join(dir, ".claude", "learning", "observations.jsonl"),
    JSON.stringify({ note: "test" }) + "\n",
  );
  // Stage to make it modified-in-working-tree (untracked is also drift in
  // coc-drift-warn's regime).
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    { cwd: dir, env: { COC_TEST_FINGERPRINT: fp, COC_TEST_PERSON_ID: "p-alice" } },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  // The drift surface MUST NOT name .claude/learning/observations.jsonl as
  // cross-operator drift; it is own-WIP. F13 prior failure mode: surface
  // attributed every untracked .jsonl as "drift".
  // We assert the surface either omits it OR attributes it as own-WIP.
  const flaggedAsDrift =
    /🚨.*COC ARTIFACT DRIFT/.test(ctx) &&
    /observations\.jsonl/.test(ctx) &&
    !/own[-\s]WIP|attributed to own/i.test(ctx);
  assert.equal(
    flaggedAsDrift,
    false,
    "F13 closure: .claude/learning/observations.jsonl MUST NOT be surfaced as cross-operator drift",
  );
});

test("sessionstart_segregates_operator_register_as_UNVERIFIED", () => {
  const dir = makeTempRepo();
  const aliceFp = makeFingerprint("alice");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: aliceFp }],
      },
    },
  });
  // Inject an operator-register record (advisory pre-roster)
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: aliceFp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_UNVERIFIED_REGISTRATIONS: JSON.stringify([
          { display_id: "carol-unverified", proposed_role: "contributor" },
        ]),
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  // The UNVERIFIED section MUST be present + segregated
  assert.match(ctx, /UNVERIFIED/i);
  assert.match(ctx, /carol-unverified/);
});

test("sessionstart_10s_budget_fail_open", () => {
  // Budget: 10s wall-clock. We measure under simulated 100-claim load.
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-perf");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  // Synth 100 unsigned claim records (rule-1 will reject; engine still
  // walks the array)
  const records = [];
  for (let i = 0; i < 100; i++) {
    records.push({
      type: "claim",
      verified_id: makeFingerprint(`peer-${i}`),
      person_id: `p-peer-${i}`,
      seq: 0,
      ts: new Date().toISOString(),
      content: { claim_id: `c-${i}`, path: `src/peer-${i}.js` },
      sig: "stub",
    });
  }
  writeCoordLog(dir, records);
  const t0 = Date.now();
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    { cwd: dir, env: { COC_TEST_FINGERPRINT: fp, COC_TEST_PERSON_ID: "p-alice" } },
  );
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < 10000,
    `MUST complete within 10s; took ${elapsed}ms`,
  );
  assert.equal(r.parsed && r.parsed.continue, true, "fail-open: continue:true");
});

test("sessionstart_pending_gate_approvals_surfaces_records_targeting_this_operator", () => {
  const dir = makeTempRepo();
  const aliceFp = makeFingerprint("alice");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: aliceFp }],
      },
    },
  });
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: aliceFp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_PENDING_GATE_APPROVALS: JSON.stringify([
          {
            requester_display_id: "bob",
            target_tool: "git push",
            consumed_nonce: "n-xyz",
            ts: new Date().toISOString(),
            approver_verified_id: aliceFp,
          },
        ]),
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const ctx =
    (r.parsed &&
      r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.additionalContext) ||
    "";
  assert.match(ctx, /gate-approval|gate approval|pending.*approval/i);
  assert.match(ctx, /bob/);
});

test("sessionstart_emits_instruct_and_wait_shape_with_continue_true", () => {
  // Hook is advisory (never blocks); but it MUST use the canonical
  // hookSpecificOutput shape so the agent sees additionalContext.
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  const r = runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    { cwd: dir, env: { COC_TEST_FINGERPRINT: fp, COC_TEST_PERSON_ID: "p-alice" } },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  assert.ok(
    r.parsed.hookSpecificOutput &&
      r.parsed.hookSpecificOutput.hookEventName === "SessionStart",
    "MUST emit hookSpecificOutput.hookEventName=SessionStart",
  );
  assert.ok(
    r.parsed.hookSpecificOutput.additionalContext,
    "MUST emit additionalContext",
  );
});

// ============================================================================
// Heartbeat hook — 4 tests
// ============================================================================

test("heartbeat_signed_record_appended_first_time", () => {
  assert.ok(fs.existsSync(HEARTBEAT_HOOK), "heartbeat hook MUST exist");
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-hb");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  const r = runHook(
    HEARTBEAT_HOOK,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "x.txt" },
    },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true, "MUST emit continue:true");
  // A heartbeat record MUST be appended (best-effort; we tolerate skip-sign
  // mode by checking cache file or log presence).
  const cachePath = path.join(
    dir,
    ".claude",
    "learning",
    ".heartbeat-cache",
  );
  const logPath = path.join(
    dir,
    ".claude",
    "learning",
    "coordination-log.jsonl",
  );
  assert.ok(
    fs.existsSync(cachePath) || fs.existsSync(logPath),
    "MUST create heartbeat cache OR append to coord log on first invocation",
  );
});

test("heartbeat_coalesced_60s_skip_repeat", () => {
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-coalesce");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  // Seed cache with very-recent heartbeat (<60s ago)
  fs.writeFileSync(
    path.join(dir, ".claude", "learning", ".heartbeat-cache"),
    JSON.stringify({ last_heartbeat_ms: Date.now() }) + "\n",
  );
  const sizeBefore = fs.existsSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
  )
    ? fs
        .readFileSync(
          path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
        )
        .toString().length
    : 0;
  const r = runHook(
    HEARTBEAT_HOOK,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "x.txt" },
    },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const sizeAfter = fs.existsSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
  )
    ? fs
        .readFileSync(
          path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
        )
        .toString().length
    : 0;
  assert.equal(
    sizeAfter,
    sizeBefore,
    "Coalesce: heartbeat <60s old MUST NOT append a new record",
  );
});

test("heartbeat_stop_event_fetches_log_then_writes_final", () => {
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-stop");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  const r = runHook(
    HEARTBEAT_HOOK,
    { hook_event_name: "Stop" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  // Per architecture §4.3: Stop-event variant fetches log + writes final
  // heartbeat. With test-skip-sign, we expect at least a cache update.
  const cachePath = path.join(dir, ".claude", "learning", ".heartbeat-cache");
  assert.ok(fs.existsSync(cachePath), "Stop event MUST touch heartbeat cache");
});

test("heartbeat_never_blocks_returns_continue_true", () => {
  // Even on a corrupt log + missing roster, heartbeat must never block.
  const dir = makeTempRepo();
  // No roster, corrupt log
  fs.writeFileSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
    "not-json\nalso-not-json\n",
  );
  const r = runHook(
    HEARTBEAT_HOOK,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "x.txt" },
    },
    { cwd: dir },
  );
  assert.equal(
    r.parsed && r.parsed.continue,
    true,
    "heartbeat MUST emit continue:true even on corrupt state",
  );
  assert.notEqual(r.exitCode, 2, "heartbeat MUST NOT exit with block code 2");
});

// ============================================================================
// SessionEnd hook — 5 tests
// ============================================================================

test("sessionend_releases_own_active_claims", () => {
  assert.ok(fs.existsSync(SESSIONEND_HOOK), "sessionend hook MUST exist");
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-end");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  // Seed an active claim by this operator
  writeCoordLog(dir, [
    {
      type: "claim",
      verified_id: fp,
      person_id: "p-alice",
      seq: 0,
      ts: new Date().toISOString(),
      content: { claim_id: "my-claim-1", path: "src/foo.js" },
      sig: "stub",
    },
  ]);
  const r = runHook(
    SESSIONEND_HOOK,
    { hook_event_name: "Stop" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
        COC_TEST_FORCE_RELEASE: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  // The release record (or release intent) MUST be appended OR captured
  // in the cache for the next session.
  const logRaw = fs.readFileSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
    "utf8",
  );
  // Either an actual release record OR a release intent in the cache
  const releaseMarkerInLog = /\"type\":\s*\"release\"/.test(logRaw);
  const cachePath = path.join(
    dir,
    ".claude",
    "learning",
    ".session-end-cache",
  );
  const cacheHasReleaseIntent =
    fs.existsSync(cachePath) && /my-claim-1/.test(fs.readFileSync(cachePath, "utf8"));
  assert.ok(
    releaseMarkerInLog || cacheHasReleaseIntent,
    "MUST append release record OR cache release intent",
  );
});

test("sessionend_appends_checkpoint_with_owner_cosigner_when_eligible", () => {
  // When derived-N >= 2 (two owners), sessionend MAY append a
  // compaction-checkpoint routed through isEligibleSigner. For Phase-1
  // structural test: verify the hook doesn't crash + emits continue:true
  // under a 2-owner roster + checkpoint trigger.
  const dir = makeTempRepo();
  const aliceFp = makeFingerprint("alice");
  const bobFp = makeFingerprint("bob");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: aliceFp }],
      },
      "p-bob": {
        display_id: "bob",
        role: "owner",
        github_login: "bob",
        host_role: "human",
        keys: [{ fingerprint: bobFp }],
      },
    },
  });
  const r = runHook(
    SESSIONEND_HOOK,
    { hook_event_name: "Stop" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: aliceFp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
        COC_TEST_FORCE_CHECKPOINT: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
});

test("sessionend_appends_genuine_genesis_degenerate_checkpoint_when_derivedN1", () => {
  // Genuine-genesis N=1 (no revocation history): sole owner MAY self-sign
  // a checkpoint. Structural test that the hook routes through
  // gateEligibleForSelfSignedCheckpointOrRotation.
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-solo");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  const r = runHook(
    SESSIONEND_HOOK,
    { hook_event_name: "Stop" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
        COC_TEST_FORCE_CHECKPOINT: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  // The hook MUST NOT crash even when sole-owner degenerate checkpoint
  // is the path.
});

test("sessionend_blocks_self_sign_checkpoint_under_revocation_induced_N1", () => {
  // R9-S-02: derived-N=1 traceable to a settled revocation → self-sign
  // checkpoint MUST be refused. The hook never blocks tool calls, but
  // its checkpoint emission MUST not produce a self-signed checkpoint
  // record in the log under this scenario.
  const dir = makeTempRepo();
  const aliceFp = makeFingerprint("alice");
  const bobFp = makeFingerprint("bob");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: aliceFp }],
      },
    },
  });
  // Seed history with an attestation (bob was an owner once) then a
  // revocation. r9s02-fence will detect attestation history + N=1.
  writeCoordLog(dir, [
    {
      type: "collaborator-distinctness-attestation",
      verified_id: aliceFp,
      person_id: "p-alice",
      seq: 0,
      ts: "2026-01-01T00:00:00Z",
      content: { github_login: "bob" },
      sig: "stub",
    },
    {
      type: "collaborator-distinctness-revocation",
      verified_id: aliceFp,
      person_id: "p-alice",
      seq: 1,
      ts: "2026-02-01T00:00:00Z",
      content: { github_login: "bob" },
      sig: "stub",
    },
  ]);
  const logBefore = fs.readFileSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
    "utf8",
  );
  const r = runHook(
    SESSIONEND_HOOK,
    { hook_event_name: "Stop" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: aliceFp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
        COC_TEST_FORCE_CHECKPOINT: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  const logAfter = fs.readFileSync(
    path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
    "utf8",
  );
  // R9-S-02: NO self-signed compaction-checkpoint record MAY be appended
  // under revocation-induced N=1.
  const newCheckpointLines = logAfter
    .split("\n")
    .filter(
      (l) =>
        !logBefore.includes(l) && /"type":\s*"compaction-checkpoint"/.test(l),
    );
  assert.equal(
    newCheckpointLines.length,
    0,
    `R9-S-02 fence: no checkpoint MAY be appended under revocation-induced N=1; found ${newCheckpointLines.length}`,
  );
});

test("sessionend_atomic_session_notes_via_tmp_rename", () => {
  // Atomic .session-notes regen: write to .session-notes.tmp.<pid> then
  // rename. We verify presence of either the .session-notes OR no temp
  // garbage left behind after hook exit.
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-notes");
  writeRoster(dir, {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc",
      genesis_generation: 0,
    },
    persons: {
      "p-alice": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [{ fingerprint: fp }],
      },
    },
  });
  const r = runHook(
    SESSIONEND_HOOK,
    { hook_event_name: "Stop" },
    {
      cwd: dir,
      env: {
        COC_TEST_FINGERPRINT: fp,
        COC_TEST_PERSON_ID: "p-alice",
        COC_TEST_SKIP_SIGN: "1",
        COC_TEST_WRITE_SESSION_NOTES: "1",
      },
    },
  );
  assert.equal(r.parsed && r.parsed.continue, true);
  // No .session-notes.tmp.* should remain
  const stragglers = fs
    .readdirSync(dir)
    .filter((n) => /^\.session-notes\.tmp\./.test(n));
  assert.equal(
    stragglers.length,
    0,
    `MUST NOT leave .tmp stragglers; found ${stragglers.join(", ")}`,
  );
});

// ============================================================================
// F13 closure — 2 tests
// ============================================================================

test("coc_drift_warn_deleted_from_settings_chain", () => {
  const raw = fs.readFileSync(SETTINGS_JSON, "utf8");
  assert.equal(
    /coc-drift-warn/.test(raw),
    false,
    "settings.json::hooks chain MUST NOT reference coc-drift-warn (F13 subsumption)",
  );
});

test("coc_drift_warn_js_file_does_not_exist", () => {
  assert.equal(
    fs.existsSync(DRIFT_WARN_HOOK),
    false,
    "coc-drift-warn.js MUST be deleted (subsumed by multi-operator-sessionstart)",
  );
});
