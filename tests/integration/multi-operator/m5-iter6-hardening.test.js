/**
 * Tier-2 integration tests for F14 M5 iter-6 hardening shard
 * (workspaces/multi-operator-coc — /redteam R7 security findings).
 *
 * This suite is the pre-ship contract for:
 *   Sec-MED-A1 — sessionend release/checkpoint records unsigned in production
 *   Sec-MED-A2 — heartbeat-cache + session-end-cache deny matrix gap +
 *                cross-operator cache poisoning
 *   Sec-MED-A3 — detectPendingGateApprovals signer-vs-requester cross-check
 *
 * Run via:
 *   node --test tests/integration/multi-operator/m5-iter6-hardening.test.js
 *
 * Tier-2 discipline: real ssh-keygen + real coc-sign verify; no mocking
 * of crypto / signature / fold semantics (rules/testing.md § Tier 2).
 *
 * Per probe-driven-verification.md Rule 3: assertions are structural —
 * JSON parse of stdout, exit-code check, file-existence and grep on
 * deny-matrix entries, end-to-end fold-rule-1 acceptance via foldLog().
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
const LIB_DIR = path.join(HOOKS_DIR, "lib");
const SETTINGS_JSON = path.join(REPO_ROOT, ".claude", "settings.json");
const SESSIONEND_HOOK = path.join(HOOKS_DIR, "multi-operator-sessionend.js");
const SESSIONSTART_HOOK = path.join(
  HOOKS_DIR,
  "multi-operator-sessionstart.js",
);
const HEARTBEAT_HOOK = path.join(HOOKS_DIR, "adjacency-heartbeat.js");
const VALIDATE_BASH = path.join(HOOKS_DIR, "validate-bash-command.js");
const VIOLATION_PATTERNS = path.join(LIB_DIR, "violation-patterns.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const COORDINATION_LOG = path.join(LIB_DIR, "coordination-log.js");

// ---- ephemeral ssh-key fixture ----------------------------------------------

function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m5-iter6-${label}-`));
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
    `m5-iter6-test-${label}`,
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

// ---- temp repo scaffold -----------------------------------------------------

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-iter6-repo-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
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

function readLog(dir) {
  const p = path.join(dir, ".claude", "learning", "coordination-log.jsonl");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

function makeFingerprint(seed) {
  return (
    "SHA256:" +
    crypto
      .createHash("sha256")
      .update(String(seed))
      .digest("base64")
      .slice(0, 43)
  );
}

function signRecord(core, keyPath) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(core);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`sign failed: ${r.error}: ${r.reason}`);
  return { ...core, sig: r.sig };
}

function runHook(hookPath, payload, opts) {
  const o = opts || {};
  const env = Object.assign(
    {},
    process.env,
    {
      CLAUDE_PROJECT_DIR: o.cwd || process.cwd(),
      CLAUDE_TRUST_STATE_DIR: path.join(
        o.cwd || process.cwd(),
        ".claude",
        "learning",
      ),
      COC_OPERATOR_REPO_DIR: o.cwd || "",
    },
    o.env || {},
  );
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(payload),
    cwd: o.cwd || process.cwd(),
    env,
    encoding: "utf8",
    timeout: o.timeoutMs || 15000,
  });
  let parsed = null;
  try {
    parsed = result.stdout
      ? JSON.parse(result.stdout.trim().split("\n").pop())
      : null;
  } catch {
    parsed = null;
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    parsed,
  };
}

// ============================================================================
// Sec-MED-A1 — sessionend signs release/checkpoint records in production
// ============================================================================

test("sessionend_release_record_is_signed_in_production", () => {
  // PRODUCTION mode: COC_TEST_SKIP_SIGN unset; COC_OPERATOR_KEY_PATH set.
  // Sessionend MUST sign the release record via coc-sign.js::sign and the
  // resulting record MUST have a non-stub `sig` field that verify()s.
  const key = mkEphemeralSshKey("a1-prod");
  const dir = makeTempRepo();
  try {
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
          keys: [
            {
              type: "ssh",
              fingerprint: key.fingerprint,
              pubkey: key.pubKey,
            },
          ],
        },
      },
    });
    // Seed a SIGNED claim by this operator that sessionend will release.
    const claimCore = {
      type: "claim",
      verified_id: key.fingerprint,
      person_id: "p-alice",
      seq: 0,
      prev_hash: null,
      ts: new Date().toISOString(),
      content: { claim_id: "prod-claim-1", path: "src/foo.js" },
    };
    const signedClaim = signRecord(claimCore, key.keyPath);
    fs.writeFileSync(
      path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
      JSON.stringify(signedClaim) + "\n",
    );
    const r = runHook(
      SESSIONEND_HOOK,
      { hook_event_name: "Stop" },
      {
        cwd: dir,
        env: {
          COC_TEST_FINGERPRINT: key.fingerprint,
          COC_TEST_PERSON_ID: "p-alice",
          COC_OPERATOR_KEY_PATH: key.keyPath,
          COC_TEST_FORCE_RELEASE: "1",
          // NB: COC_TEST_SKIP_SIGN intentionally unset → production path
        },
      },
    );
    assert.equal(r.parsed && r.parsed.continue, true, "MUST passthrough");
    const log = readLog(dir);
    const releases = log.filter((rec) => rec.type === "release");
    assert.ok(
      releases.length >= 1,
      `MUST emit at least one release record; found ${releases.length}`,
    );
    const release = releases[0];
    assert.ok(
      typeof release.sig === "string" && release.sig.length > 0,
      "release record MUST have a non-empty `sig` field in production",
    );
    assert.notEqual(
      release.sig,
      "test-stub",
      "release record MUST NOT carry the test-stub literal in production",
    );
    // The sig MUST verify against the signer's pubkey.
    const { canonicalSerialize, verify } = require(COC_SIGN);
    const { sig, ...core } = release;
    const bytes = canonicalSerialize(core);
    const v = verify(bytes, sig, key.pubKey, { keyType: "ssh" });
    assert.ok(
      v.ok && v.valid,
      `release sig MUST verify; got ${JSON.stringify(v)}`,
    );
  } finally {
    cleanup(key.dir);
    cleanup(dir);
  }
});

test("sessionend_signed_release_passes_rule_1_fold", () => {
  // End-to-end fold acceptance: synthesize a signed release record via
  // sessionend in production mode, then fold the entire log via
  // coordination-log.js::foldLog and assert the release lands in accepted[].
  const key = mkEphemeralSshKey("a1-fold");
  const dir = makeTempRepo();
  try {
    const roster = {
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
          keys: [
            {
              type: "ssh",
              fingerprint: key.fingerprint,
              pubkey: key.pubKey,
            },
          ],
        },
      },
    };
    writeRoster(dir, roster);
    const claimCore = {
      type: "claim",
      verified_id: key.fingerprint,
      person_id: "p-alice",
      seq: 0,
      prev_hash: null,
      ts: new Date().toISOString(),
      content: { claim_id: "fold-claim-1", path: "src/bar.js" },
    };
    const signedClaim = signRecord(claimCore, key.keyPath);
    fs.writeFileSync(
      path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
      JSON.stringify(signedClaim) + "\n",
    );
    runHook(
      SESSIONEND_HOOK,
      { hook_event_name: "Stop" },
      {
        cwd: dir,
        env: {
          COC_TEST_FINGERPRINT: key.fingerprint,
          COC_TEST_PERSON_ID: "p-alice",
          COC_OPERATOR_KEY_PATH: key.keyPath,
          COC_TEST_FORCE_RELEASE: "1",
        },
      },
    );
    // Fold the full log; the signed release MUST be accepted.
    const { foldLog } = require(COORDINATION_LOG);
    const log = readLog(dir);
    const result = foldLog(log, roster, {});
    const accepted = result.accepted || [];
    const acceptedReleases = accepted.filter((r) => r.type === "release");
    assert.ok(
      acceptedReleases.length >= 1,
      `fold MUST accept signed release; accepted=${accepted
        .map((r) => r.type)
        .join(",")}`,
    );
  } finally {
    cleanup(key.dir);
    cleanup(dir);
  }
});

test("sessionend_unsigned_release_in_test_skip_sign_mode", () => {
  // The COC_TEST_SKIP_SIGN=1 env path MUST still produce a record (with
  // a sig of "test-stub") for Tier-2 determinism. This is the existing
  // m5-b2-lifecycle test contract; iter-6 MUST NOT regress it.
  const dir = makeTempRepo();
  const fp = makeFingerprint("alice-skip-sign");
  try {
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
    fs.writeFileSync(
      path.join(dir, ".claude", "learning", "coordination-log.jsonl"),
      JSON.stringify({
        type: "claim",
        verified_id: fp,
        person_id: "p-alice",
        seq: 0,
        ts: new Date().toISOString(),
        content: { claim_id: "skip-sign-claim", path: "src/x.js" },
        sig: "test-stub",
      }) + "\n",
    );
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
    const log = readLog(dir);
    const releases = log.filter((rec) => rec.type === "release");
    assert.ok(
      releases.length >= 1,
      "MUST still emit release in skip-sign mode",
    );
    assert.equal(
      releases[0].sig,
      "test-stub",
      'skip-sign mode MUST emit `sig: "test-stub"` for Tier-2 determinism',
    );
  } finally {
    cleanup(dir);
  }
});

test("sessionend_no_stub_cosig_string_literal", () => {
  // R7 closure: the literal `sig: "stub-cosig"` emission pattern MUST be
  // removed from multi-operator-sessionend.js. Real cosig sig or
  // genuine-genesis degenerate self-sign is the only valid emission path.
  // The string MAY appear in comments documenting the historical removal.
  const src = fs.readFileSync(SESSIONEND_HOOK, "utf8");
  // Strip line comments and block-comment content before scanning.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.equal(
    /sig\s*:\s*"stub-cosig"/.test(codeOnly),
    false,
    'multi-operator-sessionend.js MUST NOT emit `sig: "stub-cosig"` (R7 / Sec-MED-A1)',
  );
});

// ============================================================================
// Sec-MED-A2 — cache deny matrix + readCache identity guard
// ============================================================================

function readDenyMatrix() {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8"));
  return (settings.permissions && settings.permissions.deny) || [];
}

// F123: the per-verb Bash deny-matrix (Bash(rm:<state>), Bash(tee:*<state>),
// ...) was REMOVED from settings.json as structurally incompletable — a verb
// denylist can never cover every write-capable shell verb nor the redirect
// operator. The authoritative Bash control is the path-based hook interceptor
// validate-bash-command.js::detectStateFileMutation, which matches on the
// TARGET PATH regardless of verb. These tests therefore assert (a) the
// Edit/Write tool+path deny rules REMAIN (the cache files have no
// posture-gate/integrity-guard Edit/Write coverage, so those deny entries are
// the sole Edit/Write fence), AND (b) the hook flags Bash mutation of the
// cache files across the redirect / file-util / rm vectors.
const { detectStateFileMutation } = require(VIOLATION_PATTERNS);

function statePathRx() {
  const src = fs.readFileSync(VALIDATE_BASH, "utf8");
  const m = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(m, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval -- reconstruct the source-controlled regex literal
  return eval(m[1]);
}

test("heartbeat_cache_protected", () => {
  const deny = readDenyMatrix();
  for (const entry of [
    "Edit(.claude/learning/.heartbeat-cache*)",
    "Write(.claude/learning/.heartbeat-cache*)",
    "MultiEdit(.claude/learning/.heartbeat-cache*)",
    "NotebookEdit(.claude/learning/.heartbeat-cache*)",
  ]) {
    assert.ok(
      deny.includes(entry),
      `deny matrix MUST retain Edit/Write fence: ${entry}`,
    );
  }
  const rx = statePathRx();
  const cache = ".claude/learning/.heartbeat-cache";
  for (const cmd of [
    `cat /tmp/x > ${cache}`, // Layer 1 redirect
    `truncate -s0 ${cache}`, // Layer 2
    `cp /tmp/forged ${cache}`, // Layer 2
    `rm ${cache}`, // Layer 2 (rm — F123 parity addition)
  ]) {
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag Bash mutation of heartbeat-cache: ${cmd}`,
    );
  }
});

test("session_end_cache_protected", () => {
  const deny = readDenyMatrix();
  for (const entry of [
    "Edit(.claude/learning/.session-end-cache*)",
    "Write(.claude/learning/.session-end-cache*)",
    "MultiEdit(.claude/learning/.session-end-cache*)",
    "NotebookEdit(.claude/learning/.session-end-cache*)",
  ]) {
    assert.ok(
      deny.includes(entry),
      `deny matrix MUST retain Edit/Write fence: ${entry}`,
    );
  }
  const rx = statePathRx();
  const cache = ".claude/learning/.session-end-cache";
  for (const cmd of [
    `cat /tmp/x > ${cache}`,
    `truncate -s0 ${cache}`,
    `rm ${cache}`,
  ]) {
    assert.ok(
      detectStateFileMutation(cmd, rx),
      `hook MUST flag Bash mutation of session-end-cache: ${cmd}`,
    );
  }
});

test("f123_hook_covers_rm_and_sponge_without_false_positives", () => {
  // The hook interceptor that replaced the Bash deny-matrix MUST be at least
  // as strong as the removed entries (rm) AND close a verb the deny-matrix
  // never covered (sponge), WITHOUT flagging benign rm of non-state paths.
  const rx = statePathRx();
  assert.ok(
    detectStateFileMutation("rm .claude/learning/posture.json", rx),
    "rm of posture.json MUST flag (parity with removed Bash(rm:) deny entry)",
  );
  assert.ok(
    detectStateFileMutation("rm .claude/learning/.initialized", rx),
    "rm of .initialized MUST flag (Sec-MED-1 fresh-vs-corrupt downgrade)",
  );
  assert.ok(
    detectStateFileMutation(
      "grep -v drop /tmp/x | sponge .claude/learning/coordination-log.jsonl",
      rx,
    ),
    "sponge write-back to coordination-log MUST flag",
  );
  assert.equal(
    detectStateFileMutation("rm .claude/test-harness/foo.json", rx),
    null,
    "benign rm of a non-state path MUST NOT flag (rm fires only when pathRx hits)",
  );
  assert.equal(
    detectStateFileMutation("rm -rf node_modules", rx),
    null,
    "rm of an unrelated path MUST NOT flag",
  );
});

test("heartbeat_readcache_rejects_other_operator", () => {
  // Cross-operator cache poisoning: a heartbeat-cache containing a
  // different operator's verified_id MUST be rejected (treated as null) by
  // the heartbeat readCache identity guard. This forces the heartbeat to
  // re-emit rather than coalesce on a foreign cache.
  const dir = makeTempRepo();
  const ourFp = makeFingerprint("self-op");
  const otherFp = makeFingerprint("other-op");
  try {
    writeRoster(dir, {
      genesis: {
        repo_owner: "alice",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "p-self": {
          display_id: "self",
          role: "owner",
          github_login: "alice",
          host_role: "human",
          keys: [{ fingerprint: ourFp }],
        },
      },
    });
    // Seed the cache with the OTHER operator's verified_id and a recent
    // last_heartbeat_ms (would normally coalesce within the 60s window).
    const cachePath = path.join(dir, ".claude", "learning", ".heartbeat-cache");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        last_heartbeat_ms: Date.now(),
        seq: 99,
        verified_id: otherFp,
      }) + "\n",
    );
    // Run heartbeat (PreToolUse) — identity guard MUST reject the cache,
    // so the heartbeat MUST emit a new record despite the recent cache.
    const r = runHook(
      HEARTBEAT_HOOK,
      { hook_event_name: "PreToolUse" },
      {
        cwd: dir,
        env: {
          COC_TEST_FINGERPRINT: ourFp,
          COC_TEST_PERSON_ID: "p-self",
          COC_TEST_SKIP_SIGN: "1",
        },
      },
    );
    assert.equal(r.parsed && r.parsed.continue, true);
    const log = readLog(dir);
    const heartbeats = log.filter((rec) => rec.type === "heartbeat");
    assert.ok(
      heartbeats.length >= 1,
      "MUST emit fresh heartbeat when cache belongs to a different operator",
    );
    // The new cache MUST belong to OUR operator.
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      assert.equal(
        cache.verified_id,
        ourFp,
        "after rejection, cache MUST be rewritten with the current operator's verified_id",
      );
    }
  } finally {
    cleanup(dir);
  }
});

test("state_path_rx_covers_heartbeat_cache", () => {
  const src = fs.readFileSync(VALIDATE_BASH, "utf8");
  const rxMatch = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(rxMatch, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval
  const rx = eval(rxMatch[1].trim());
  assert.ok(
    rx.test(".claude/learning/.heartbeat-cache"),
    "STATE_PATH_RX MUST cover .claude/learning/.heartbeat-cache",
  );
});

test("state_path_rx_covers_session_end_cache", () => {
  const src = fs.readFileSync(VALIDATE_BASH, "utf8");
  const rxMatch = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  assert.ok(rxMatch, "validate-bash-command.js MUST declare STATE_PATH_RX");
  // eslint-disable-next-line no-eval
  const rx = eval(rxMatch[1].trim());
  assert.ok(
    rx.test(".claude/learning/.session-end-cache"),
    "STATE_PATH_RX MUST cover .claude/learning/.session-end-cache",
  );
});

test("cat_heredoc_to_heartbeat_cache_blocked", () => {
  // End-to-end Layer-1 redirect detector: a cat-heredoc redirect to the
  // heartbeat cache MUST fire detectStateFileMutation.
  const { detectStateFileMutation } = require(VIOLATION_PATTERNS);
  const src = fs.readFileSync(VALIDATE_BASH, "utf8");
  const rxMatch = src.match(/const STATE_PATH_RX\s*=\s*([^;]+);/);
  // eslint-disable-next-line no-eval
  const rx = eval(rxMatch[1].trim());
  const cmd = "cat > .claude/learning/.heartbeat-cache << EOF\n{}\nEOF";
  const result = detectStateFileMutation(cmd, rx);
  assert.ok(
    result,
    `detectStateFileMutation MUST flag cat-heredoc to .heartbeat-cache; got ${JSON.stringify(result)}`,
  );
});

// ============================================================================
// Sec-MED-A3 — detectPendingGateApprovals signer-vs-requester cross-check
// ============================================================================

function loadDetectPendingGateApprovals() {
  // Source-level extraction of the function for direct unit-style testing.
  // The function is defined inside multi-operator-sessionstart.js. We
  // extract its body via require() since the file does not currently
  // export it — instead, we exercise it through the hook by setting
  // COC_TEST_PENDING_GATE_APPROVALS to inject synthetic records.
  // Strategy: write records into the coordination log AND set
  // COC_TEST_PENDING_GATE_APPROVALS=null to ensure the fold path is
  // exercised. For mismatched-signer cases we directly inspect
  // additionalContext output.
  return null;
}

function runSessionstartWithLog(dir, identity, opts) {
  const o = opts || {};
  return runHook(
    SESSIONSTART_HOOK,
    { hook_event_name: "SessionStart" },
    {
      cwd: dir,
      env: Object.assign(
        {
          COC_TEST_FINGERPRINT: identity.fingerprint,
          COC_TEST_PERSON_ID: identity.personId,
        },
        o.env || {},
      ),
      timeoutMs: 15000,
    },
  );
}

test("detect_pending_gate_approvals_cross_checks_signer_vs_requester", () => {
  // Synthesize a malformed gate-approval: signer (verified_id) ≠
  // content.requester_verified_id. The session-start surface MUST NOT
  // surface this as a legitimate pending approval — either it's skipped
  // entirely or segregated into a MALFORMED section. Either disposition
  // proves the signer cross-check fires.
  const dir = makeTempRepo();
  const ourFp = makeFingerprint("approver-self");
  const attackerFp = makeFingerprint("attacker");
  const realRequesterFp = makeFingerprint("real-requester");
  try {
    writeRoster(dir, {
      genesis: {
        repo_owner: "alice",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "p-self": {
          display_id: "self-approver",
          role: "owner",
          github_login: "alice",
          host_role: "human",
          keys: [{ fingerprint: ourFp }],
        },
      },
    });
    // Inject a malformed gate-approval via the test env-var bypass:
    // signer (verified_id) is attacker; content claims requester is the
    // real requester; approver is THIS operator.
    const malformedApproval = {
      type: "gate-approval",
      verified_id: attackerFp,
      person_id: "p-attacker",
      display_id: "attacker-name",
      content: {
        approver_verified_id: ourFp,
        requester_verified_id: realRequesterFp,
        requester_person_id: "p-real-requester",
        target_tool: "destructive-op",
        consumed_nonce: "nonce-123",
      },
      ts: new Date().toISOString(),
    };
    const r = runSessionstartWithLog(
      dir,
      { fingerprint: ourFp, personId: "p-self" },
      {
        env: {
          COC_TEST_PENDING_GATE_APPROVALS: JSON.stringify([malformedApproval]),
        },
      },
    );
    assert.equal(r.parsed && r.parsed.continue, true, "MUST passthrough");
    // The hook's output text MUST distinguish a malformed approval from a
    // legitimate one. Structural assertion: the additionalContext either
    // (a) omits the malformed approval entirely, or (b) includes a
    // MALFORMED-style marker. We accept either disposition.
    const ctx =
      (r.parsed &&
        r.parsed.hookSpecificOutput &&
        r.parsed.hookSpecificOutput.additionalContext) ||
      "";
    // If the malformed record IS in main surface, the consumed_nonce
    // "nonce-123" appears WITHOUT any MALFORMED tag — that's a fail.
    // Acceptable: nonce missing entirely, or nonce present with a
    // MALFORMED-style segregation marker nearby.
    const nonceSurfaces = ctx.includes("nonce-123");
    const hasMalformedSegregation =
      /MALFORMED|malformed|signer-mismatch|cross-check/i.test(ctx);
    if (nonceSurfaces) {
      assert.ok(
        hasMalformedSegregation,
        `malformed approval surfaced WITHOUT segregation marker; context:\n${ctx.slice(0, 2000)}`,
      );
    }
    // PASS either way: malformed not surfaced, or surfaced with marker.
  } finally {
    cleanup(dir);
  }
});

test("detect_pending_gate_approvals_surfaces_requester_and_approver", () => {
  // For a legitimate (signer == requester_verified_id) approval, the
  // surface MUST display BOTH the requester_person_id (from content) AND
  // the approver claim so the operator can adjudicate.
  const dir = makeTempRepo();
  const ourFp = makeFingerprint("approver-legit");
  const requesterFp = makeFingerprint("legit-requester");
  try {
    writeRoster(dir, {
      genesis: {
        repo_owner: "alice",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "p-self": {
          display_id: "self-approver",
          role: "owner",
          github_login: "alice",
          host_role: "human",
          keys: [{ fingerprint: ourFp }],
        },
      },
    });
    const legitApproval = {
      type: "gate-approval",
      verified_id: requesterFp, // SIGNER == requester
      person_id: "p-legit-requester",
      display_id: "legit-requester-name",
      content: {
        approver_verified_id: ourFp,
        requester_verified_id: requesterFp,
        requester_person_id: "p-legit-requester",
        target_tool: "feature-op",
        consumed_nonce: "nonce-legit",
      },
      ts: new Date().toISOString(),
    };
    const r = runSessionstartWithLog(
      dir,
      { fingerprint: ourFp, personId: "p-self" },
      {
        env: {
          COC_TEST_PENDING_GATE_APPROVALS: JSON.stringify([legitApproval]),
        },
      },
    );
    assert.equal(r.parsed && r.parsed.continue, true);
    const ctx =
      (r.parsed &&
        r.parsed.hookSpecificOutput &&
        r.parsed.hookSpecificOutput.additionalContext) ||
      "";
    // The legitimate approval MUST surface in the main section. We
    // assert presence of the nonce or the target_tool as evidence the
    // approval reached the output.
    assert.ok(
      ctx.includes("nonce-legit") || ctx.includes("feature-op"),
      `legitimate approval MUST surface; context:\n${ctx.slice(0, 2000)}`,
    );
  } finally {
    cleanup(dir);
  }
});

test("detect_pending_gate_approvals_legitimate_record_surfaces_normally", () => {
  // Twin of the previous test — verify NO MALFORMED segregation marker
  // for the legitimate record. A surface that flags every approval as
  // MALFORMED is a different failure mode.
  const dir = makeTempRepo();
  const ourFp = makeFingerprint("approver-legit-2");
  const requesterFp = makeFingerprint("legit-requester-2");
  try {
    writeRoster(dir, {
      genesis: {
        repo_owner: "alice",
        repo_owner_kind: "user",
        root_commit: "abc",
        genesis_generation: 0,
      },
      persons: {
        "p-self": {
          display_id: "self-approver",
          role: "owner",
          github_login: "alice",
          host_role: "human",
          keys: [{ fingerprint: ourFp }],
        },
      },
    });
    const legitApproval = {
      type: "gate-approval",
      verified_id: requesterFp,
      person_id: "p-legit-requester",
      display_id: "legit-requester",
      content: {
        approver_verified_id: ourFp,
        requester_verified_id: requesterFp,
        requester_person_id: "p-legit-requester",
        target_tool: "feature-X",
        consumed_nonce: "nonce-X",
      },
      ts: new Date().toISOString(),
    };
    const r = runSessionstartWithLog(
      dir,
      { fingerprint: ourFp, personId: "p-self" },
      {
        env: {
          COC_TEST_PENDING_GATE_APPROVALS: JSON.stringify([legitApproval]),
        },
      },
    );
    const ctx =
      (r.parsed &&
        r.parsed.hookSpecificOutput &&
        r.parsed.hookSpecificOutput.additionalContext) ||
      "";
    // The legitimate approval MUST NOT be wrapped in a MALFORMED segregation
    // marker — but we accept that section may exist if empty.
    // Structural: if MALFORMED marker present, "feature-X" MUST appear
    // OUTSIDE that block. Accept either: no MALFORMED block, or MALFORMED
    // block does not contain "feature-X".
    if (/MALFORMED gate-approval/i.test(ctx)) {
      // Extract the MALFORMED block (up to next blank-line section).
      const malformedBlock = ctx.match(
        /MALFORMED gate-approval[\s\S]*?(?:\n\n|$)/i,
      );
      if (malformedBlock) {
        assert.equal(
          malformedBlock[0].includes("feature-X"),
          false,
          "legitimate approval MUST NOT be inside MALFORMED block",
        );
      }
    }
  } finally {
    cleanup(dir);
  }
});

// ============================================================================
// Structural sweeps (iter-3 + iter-4) still clean post-iter-6
// ============================================================================

test("iter6_structural_sweeps_still_clean", () => {
  // iter-3 mutation-tool sweep
  let mutToolResult;
  try {
    mutToolResult = execFileSync(
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
      mutToolResult = "";
    } else {
      throw err;
    }
  }
  assert.equal(
    mutToolResult.trim(),
    "",
    `iter-3 mutation-tool sweep MUST remain clean post-iter-6; found:\n${mutToolResult}`,
  );
  // iter-6 stub-cosig emission sweep: the emission pattern
  // `sig: "stub-cosig"` MUST be absent from all production hooks. The
  // literal MAY appear in comments documenting the historical removal.
  let stubCosigResult;
  try {
    stubCosigResult = execFileSync(
      "grep",
      [
        "-rnE",
        "--include=*.js",
        'sig[[:space:]]*:[[:space:]]*"stub-cosig"',
        HOOKS_DIR,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    if (err.status === 1) {
      stubCosigResult = "";
    } else {
      throw err;
    }
  }
  assert.equal(
    stubCosigResult.trim(),
    "",
    `\`sig: "stub-cosig"\` emission MUST remain absent from .claude/hooks/; found:\n${stubCosigResult}`,
  );
});

test("m5_lifecycle_hooks_regression_passes_post_iter6", () => {
  // Re-run the full m5-b2-lifecycle-hooks.test.js suite via subprocess.
  // PASS if exit code is 0 (all tests green).
  const result = spawnSync(
    "node",
    [
      "--test",
      "tests/integration/multi-operator/m5-b2-lifecycle-hooks.test.js",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `m5-b2-lifecycle-hooks suite MUST still pass post-iter-6\nstdout:\n${(result.stdout || "").slice(-2000)}\nstderr:\n${(result.stderr || "").slice(-2000)}`,
  );
});
