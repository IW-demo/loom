/**
 * Tests for resolveIdentity(cwd) + /whoami no-args read surface (shard A1).
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — display_id / verified_id / person_id; resolveIdentity(cwd) returns all three.
 *   §6.1 — un-rostered key runs at L2_SUPERVISED, blocked into /whoami --register.
 *
 * The 3 invariants under test (todos § A1):
 *   1. resolveIdentity(cwd) 3-tier resolution (signing-key fingerprint →
 *      roster lookup → identity tuple) with cache layer.
 *   2. /whoami no-args read surface prints display_id + person_id +
 *      verified_id + role + host_role + posture.
 *   3. .claude/operator-id cache is hint-only (re-derives on mismatch / corrupt / absent).
 *
 * Tier-2 tests use real ephemeral SSH keys via `ssh-keygen` in mktemp -d
 * (rules/testing.md § "3-Tier Testing": NO mocking at Tier 2). Roster
 * fixtures are built inline so the test owns the JSON it loads.
 *
 * Run: node tests/integration/operator-id.test.js
 * Exit: 0 = all PASS or SKIP; 1 = at least one FAIL.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OPERATOR_ID_MODULE = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "operator-id.js",
);
const WHOAMI_COMMAND_PATH = path.join(
  REPO_ROOT,
  ".claude",
  "commands",
  "whoami.md",
);

// ---- minimal test harness (no external deps, sibling style) ------------------
let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const FAILS = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result === "skip") {
      SKIP += 1;
      console.log(`  SKIP  ${name}`);
      return;
    }
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

function loadOperatorId() {
  if (!fs.existsSync(OPERATOR_ID_MODULE)) {
    throw new Error(
      `operator-id module missing at ${OPERATOR_ID_MODULE} — implement first (shard A1)`,
    );
  }
  delete require.cache[OPERATOR_ID_MODULE];
  return require(OPERATOR_ID_MODULE);
}

// ---- ephemeral SSH key + fingerprint helpers (Tier-2 real-key style) --------

function sshKeygenAvailable() {
  const r = spawnSync("ssh-keygen", ["-V"], { stdio: "ignore" });
  // ssh-keygen has no -V flag on most platforms; status != 127 indicates the
  // binary exists. ENOENT surfaces as -2 / errno; check for absence.
  return r.error === undefined || r.error.code !== "ENOENT";
}

function generateEphemeralSshKey(tmpDir, name = "id_ed25519") {
  const keyPath = path.join(tmpDir, name);
  const r = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "operator-id-test"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    throw new Error(
      `ssh-keygen failed (status ${r.status}): ${(r.stderr || "").toString()}`,
    );
  }
  // Read SHA256 fingerprint via `ssh-keygen -lf <pubkey>` → "256 SHA256:abc... comment (ED25519)"
  const lf = spawnSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (lf.status !== 0) {
    throw new Error(
      `ssh-keygen -lf failed (status ${lf.status}): ${(lf.stderr || "").toString()}`,
    );
  }
  const parts = lf.stdout.toString().trim().split(/\s+/);
  const fingerprint = parts[1]; // SHA256:....
  if (!fingerprint || !fingerprint.startsWith("SHA256:")) {
    throw new Error(`unexpected fingerprint format: ${lf.stdout.toString()}`);
  }
  const pubkey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  return { keyPath, pubkey, fingerprint };
}

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

/**
 * Build a clone of a minimal repo layout for resolveIdentity():
 *   <tmp>/.claude/operators.roster.json
 *   <tmp>/.claude/operators.roster.schema.json (symlink/copy)
 *   <tmp>/.claude/hooks/lib/roster-schema-validate.js (used by validator)
 *
 * resolveIdentity(cwd) resolves the repo root via the conventional
 * `.claude/` directory walk, so this fixture mirrors the live shape.
 */
function buildRepoFixture(rosterContent) {
  const repoDir = mkTmpDir("operator-id-repo-");
  const claudeDir = path.join(repoDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "operators.roster.json"),
    JSON.stringify(rosterContent, null, 2) + "\n",
  );
  // resolveIdentity does not validate the roster itself (that's --register's
  // job); but if it ever calls the validator we want the schema reachable.
  fs.copyFileSync(
    path.join(REPO_ROOT, ".claude", "operators.roster.schema.json"),
    path.join(claudeDir, "operators.roster.schema.json"),
  );
  return { repoDir, claudeDir };
}

function rosterWith(persons) {
  return {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc1234567890abc1234567890abc1234567890a",
      genesis_generation: 0,
    },
    persons,
  };
}

// ===== Tier-2: resolveIdentity 3-tier resolution =============================
console.log("\n=== operator-id — resolveIdentity 3-tier resolution ===");

test("resolveIdentity_rostered_key_returns_full_identity", () => {
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-key-");
  try {
    const { keyPath, pubkey, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    const roster = rosterWith({
      "pid-bob-001": {
        display_id: "bob",
        role: "contributor",
        github_login: "bob",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint, pubkey }],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      const id = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id.verified_id === fingerprint,
        `verified_id mismatch: ${id.verified_id}`,
      );
      assert(
        id.person_id === "pid-bob-001",
        `person_id mismatch: ${id.person_id}`,
      );
      assert(id.display_id === "bob", `display_id mismatch: ${id.display_id}`);
      assert(id.role === "contributor", `role mismatch: ${id.role}`);
      assert(id.host_role === "human", `host_role mismatch: ${id.host_role}`);
      assert(
        id.posture === "L5_DELEGATED" || id.posture === undefined,
        `unexpected posture downgrade: ${id.posture}`,
      );
    } finally {
      rmTmpDir(fixture.repoDir);
    }
  } finally {
    rmTmpDir(tmpKeyDir);
  }
});

test("resolveIdentity_unrostered_key_returns_L2_supervised", () => {
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-key-");
  try {
    const { keyPath, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    // Roster has a different person; this key is un-rostered.
    const roster = rosterWith({
      "pid-alice-001": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [
          {
            type: "ssh",
            fingerprint: "SHA256:DIFFERENT-FINGERPRINT-NOT-MATCHING",
            pubkey: "ssh-ed25519 AAAADifferentKey alice@example",
          },
        ],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      const id = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id.verified_id === fingerprint,
        `verified_id should be the un-rostered key fingerprint: ${id.verified_id}`,
      );
      assert(
        id.person_id === null,
        `person_id should be null for un-rostered: ${id.person_id}`,
      );
      assert(
        id.display_id === null,
        `display_id should be null for un-rostered: ${id.display_id}`,
      );
      assert(id.role === null, "role should be null for un-rostered");
      assert(id.host_role === null, "host_role should be null for un-rostered");
      assert(
        id.posture === "L2_SUPERVISED",
        `posture must be L2_SUPERVISED: ${id.posture}`,
      );
      assert(
        typeof id.blocked_into === "string" &&
          /--register/.test(id.blocked_into),
        `blocked_into must direct to /whoami --register: ${id.blocked_into}`,
      );
    } finally {
      rmTmpDir(fixture.repoDir);
    }
  } finally {
    rmTmpDir(tmpKeyDir);
  }
});

test("resolveIdentity_no_signing_key_configured_returns_L2_supervised_with_setup_action", () => {
  const roster = rosterWith({
    "pid-alice-001": {
      display_id: "alice",
      role: "owner",
      github_login: "alice",
      host_role: "human",
      keys: [
        {
          type: "ssh",
          fingerprint: "SHA256:abcdef0123456789",
          pubkey: "ssh-ed25519 AAAAExampleKey alice@example",
        },
      ],
    },
  });
  const fixture = buildRepoFixture(roster);
  try {
    const opid = loadOperatorId();
    // Pass empty options; module's signing-key discovery returns null when
    // git config user.signingkey is unset AND no explicit key path supplied.
    const id = opid.resolveIdentity(fixture.repoDir, {
      // Explicitly signal no key. Implementation MUST honour this; it MUST
      // NOT fall through to ambient git config (tests need determinism).
      signingKeyPath: null,
      gitConfigSigningKey: null,
    });
    assert(
      id.verified_id === null,
      `verified_id should be null when no key: ${id.verified_id}`,
    );
    assert(id.person_id === null, "person_id null when no key");
    assert(id.display_id === null, "display_id null when no key");
    assert(
      id.posture === "L2_SUPERVISED",
      `posture must be L2_SUPERVISED: ${id.posture}`,
    );
    assert(
      typeof id.blocked_into === "string" &&
        /signing key/i.test(id.blocked_into) &&
        /--register/.test(id.blocked_into),
      `blocked_into must mention configure signing key + /whoami --register: ${id.blocked_into}`,
    );
  } finally {
    rmTmpDir(fixture.repoDir);
  }
});

// ===== Tier-2: cache hint-only semantics ======================================
console.log("\n=== operator-id — cache hint-only semantics ===");

function readMtimeMs(p) {
  return fs.statSync(p).mtimeMs;
}

test("resolveIdentity_always_re_derives_from_roster_M9_1_Sec_ID_1", () => {
  // M9.1 R1 Sec-ID-1 — the cache is NO LONGER the authority cache; it is
  // a hint-only trust-anchor cache that may hold `verified_id` but MUST
  // NOT short-circuit roster lookup for person_id / role / host_role.
  // Pre-fix: a stale cache restored a departed person_id binding on the
  // next session. Post-fix: every resolveIdentity call re-walks the
  // roster; the only operation the cache skips is the ssh-keygen
  // subprocess (the cache file's existence proves the fingerprint was
  // resolved once; future invocations may re-invoke ssh-keygen anyway).
  // This test now asserts ALWAYS-re-derive: derive_count MUST increment
  // on every call, regardless of cache presence.
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-key-");
  try {
    const { keyPath, pubkey, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    const roster = rosterWith({
      "pid-cache-001": {
        display_id: "cacheop",
        role: "contributor",
        github_login: "cacheop",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint, pubkey }],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      // First call populates the cache.
      const id1 = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id1.person_id === "pid-cache-001",
        "first resolution must succeed",
      );
      const rosterPath = path.join(fixture.claudeDir, "operators.roster.json");
      // Force a 10ms delay so atime/mtime resolutions can distinguish.
      const beforeAtime = fs.statSync(rosterPath).atimeMs;
      // Second call SHOULD hit the cache and skip the roster read.
      const id2 = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id2.person_id === "pid-cache-001",
        "cached resolution must return same person",
      );
      const afterAtime = fs.statSync(rosterPath).atimeMs;
      // atime is filesystem-dependent. Robust assertion: cache file must
      // exist; resolveIdentity_test_internals exposes a counter the impl
      // increments on every full re-derivation. Use that if exposed, else
      // assert the cache file exists with matching verified_id.
      const cachePath = path.join(fixture.claudeDir, "operator-id");
      assert(
        fs.existsSync(cachePath),
        "cache file must exist after resolution",
      );
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      assert(
        cached.verified_id === fingerprint,
        "cache file must record verified_id",
      );
      // M9.1 R1 Sec-ID-1 — derive_count MUST increment on every call (the
      // roster is ALWAYS re-walked). Pre-fix expected 0 (cache short-
      // circuited roster lookup); post-fix expects ≥1 (no short-circuit).
      if (typeof opid._test_getDeriveCount === "function") {
        opid._test_resetDeriveCount();
        opid.resolveIdentity(fixture.repoDir, { signingKeyPath: keyPath });
        assert(
          opid._test_getDeriveCount() >= 1,
          "Sec-ID-1: roster MUST be re-walked on every call (derive count >= 1)",
        );
      } else {
        // Soft signal: atime should not have advanced (assert only when
        // the OS supports it; many CI runners disable atime).
        if (afterAtime >= 0 && beforeAtime >= 0 && afterAtime !== beforeAtime) {
          // atime advanced — implementation may have re-read; that's OK if
          // the cache file still records the correct verified_id (which we
          // already asserted above).
        }
      }
    } finally {
      rmTmpDir(fixture.repoDir);
    }
  } finally {
    rmTmpDir(tmpKeyDir);
  }
});

test("resolveIdentity_cache_miss_when_verified_id_mismatches_fingerprint", () => {
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-key-");
  try {
    const { keyPath, pubkey, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    const roster = rosterWith({
      "pid-miss-001": {
        display_id: "missop",
        role: "contributor",
        github_login: "missop",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint, pubkey }],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      // Hand-write a cache with a DIFFERENT verified_id; the resolver MUST
      // detect the mismatch and re-derive.
      const cachePath = path.join(fixture.claudeDir, "operator-id");
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          verified_id: "SHA256:STALE-CACHED-FINGERPRINT-DOES-NOT-MATCH",
          person_id: "pid-stale-999",
          display_id: "stale",
          role: "contributor",
          host_role: "human",
        }) + "\n",
      );
      const id = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id.verified_id === fingerprint,
        "must re-derive verified_id from real key, not stale cache",
      );
      assert(
        id.person_id === "pid-miss-001",
        "must re-derive person_id from roster",
      );
    } finally {
      rmTmpDir(fixture.repoDir);
    }
  } finally {
    rmTmpDir(tmpKeyDir);
  }
});

test("resolveIdentity_cache_corrupt_falls_back_to_full_derivation", () => {
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-key-");
  try {
    const { keyPath, pubkey, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    const roster = rosterWith({
      "pid-corrupt-001": {
        display_id: "corruptop",
        role: "contributor",
        github_login: "corruptop",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint, pubkey }],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      const cachePath = path.join(fixture.claudeDir, "operator-id");
      // Garbage JSON.
      fs.writeFileSync(cachePath, "{ not valid json !!!\n");
      const id = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id.verified_id === fingerprint,
        "corrupt cache must trigger re-derivation",
      );
      assert(
        id.person_id === "pid-corrupt-001",
        "must re-derive person_id ignoring corrupt cache",
      );
      // After re-derivation, the cache MUST be rewritten with valid JSON.
      const after = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      assert(
        after.verified_id === fingerprint,
        "cache must be rewritten with fresh verified_id",
      );
    } finally {
      rmTmpDir(fixture.repoDir);
    }
  } finally {
    rmTmpDir(tmpKeyDir);
  }
});

test("resolveIdentity_cache_absent_falls_back_to_full_derivation", () => {
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-key-");
  try {
    const { keyPath, pubkey, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    const roster = rosterWith({
      "pid-absent-001": {
        display_id: "absentop",
        role: "contributor",
        github_login: "absentop",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint, pubkey }],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      const cachePath = path.join(fixture.claudeDir, "operator-id");
      assert(!fs.existsSync(cachePath), "precondition: cache must not exist");
      const id = opid.resolveIdentity(fixture.repoDir, {
        signingKeyPath: keyPath,
      });
      assert(
        id.person_id === "pid-absent-001",
        "must resolve from roster when cache absent",
      );
      assert(
        fs.existsSync(cachePath),
        "cache must be created after first resolution",
      );
    } finally {
      rmTmpDir(fixture.repoDir);
    }
  } finally {
    rmTmpDir(tmpKeyDir);
  }
});

// ===== Tier-2: /whoami no-args read surface output format ====================
console.log("\n=== operator-id — /whoami no-args read surface format ===");

test("whoami_no_args_prints_full_identity_for_rostered_key", () => {
  // Structural probe per probe-driven-verification.md MUST-3: verify the
  // command body documents the no-args read surface — line items for
  // display_id, person_id, verified_id, role, host_role, posture.
  assert(
    fs.existsSync(WHOAMI_COMMAND_PATH),
    `whoami.md missing at ${WHOAMI_COMMAND_PATH}`,
  );
  const body = fs.readFileSync(WHOAMI_COMMAND_PATH, "utf8");
  // The no-args section MUST list each identity field.
  for (const field of [
    "display_id",
    "person_id",
    "verified_id",
    "role",
    "host_role",
    "posture",
  ]) {
    assert(
      body.includes(field),
      `whoami.md must document the '${field}' line in the no-args output (per shard A1)`,
    );
  }
  // The placeholder text from A0b-1 MUST be replaced — the literal "A1 not
  // shipped" sentinel must no longer appear.
  assert(
    !/A1 not shipped/.test(body),
    "whoami.md must no longer carry the 'A1 not shipped' placeholder (shard A1 wires the read surface)",
  );
});

test("whoami_no_args_prints_L2_supervised_for_unrostered_key", () => {
  const body = fs.readFileSync(WHOAMI_COMMAND_PATH, "utf8");
  // The un-rostered branch MUST document L2_SUPERVISED + next step
  // /whoami --register per architecture §6.1.
  assert(
    /L2_SUPERVISED/.test(body),
    "whoami.md no-args section must document the L2_SUPERVISED posture for un-rostered keys",
  );
  assert(
    /unregistered/i.test(body) || /not.*roster/i.test(body),
    "whoami.md must surface the unregistered/not-in-roster state in the no-args output",
  );
  assert(
    /--register/.test(body),
    "whoami.md no-args section must direct the operator to /whoami --register on L2_SUPERVISED",
  );
});

test("whoami_no_args_prints_setup_action_for_missing_key", () => {
  const body = fs.readFileSync(WHOAMI_COMMAND_PATH, "utf8");
  // The no-signing-key branch MUST document the configuration step
  // ("configure signing key" or equivalent).
  assert(
    /signing key/i.test(body),
    "whoami.md no-args section must mention the signing-key configuration step",
  );
});

// ===== M0 security review regression tests (MED-2 + LOW-1) ===================
console.log("\n=== M0 security review regression tests ===");

test("operator_id_cache_mode_is_0o600", () => {
  if (!sshKeygenAvailable()) return "skip";
  const tmpKeyDir = mkTmpDir("operator-id-mode-");
  try {
    const { keyPath, pubkey, fingerprint } = generateEphemeralSshKey(tmpKeyDir);
    const roster = rosterWith({
      "pid-mode-001": {
        display_id: "mode-test",
        role: "contributor",
        github_login: "mode-test",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint, pubkey }],
      },
    });
    const fixture = buildRepoFixture(roster);
    try {
      const opid = loadOperatorId();
      // resolveIdentity writes the cache as a side-effect.
      opid.resolveIdentity(fixture.repoDir, { signingKeyPath: keyPath });
      const cachePath = path.join(fixture.claudeDir, "operator-id");
      assert(fs.existsSync(cachePath), "cache file MUST be written");
      const mode = fs.statSync(cachePath).mode & 0o777;
      assert(
        mode === 0o600,
        `MED-2: cache mode MUST be 0o600 (owner-only); got 0o${mode.toString(8)}`,
      );
    } finally {
      fs.rmSync(fixture.repoDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpKeyDir, { recursive: true, force: true });
  }
});

test("unrostered_blocked_into_constant_is_non_empty_string", () => {
  const opid = loadOperatorId();
  assert(
    typeof opid.UNROSTERED_BLOCKED_INTO === "string" &&
      opid.UNROSTERED_BLOCKED_INTO.length > 0,
    "UNROSTERED_BLOCKED_INTO MUST be a non-empty string export",
  );
});

test("no_key_blocked_into_constant_is_non_empty_string", () => {
  const opid = loadOperatorId();
  assert(
    typeof opid.NO_KEY_BLOCKED_INTO === "string" &&
      opid.NO_KEY_BLOCKED_INTO.length > 0,
    "NO_KEY_BLOCKED_INTO MUST be a non-empty string export",
  );
});

// ---- #366: GPG verified_id 40-hex normalization -----------------------------
// Bug: _fingerprintFromKey returned the git-config user.signingkey verbatim for
// GPG (commonly a 16-hex short/long key id), but the roster schema mandates the
// 40-hex fingerprint → strict-=== roster match failed → every GPG operator fell
// back to L2_SUPERVISED. Fix normalizes the key id to the canonical 40-hex via
// `gpg --with-colons --fingerprint`. Tests below are keyring-free + deterministic
// (pure parser + injected resolver + fallback); the live-gpg path was verified
// manually against the session key 70552B12…→548F2C…4755B685 (PR body receipt).

test("issue366_parseGpgColonFingerprint_extracts_40hex_primary_fpr", () => {
  const opid = loadOperatorId();
  // Real `gpg --list-keys --with-colons --fingerprint` shape (primary + sub).
  const fixture = [
    "tru::1:1700000000:0:3:1:5",
    "pub:u:4096:1:70552B124755B685:1713600000:::u:::scESC::::::23::0:",
    "fpr:::::::::DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF:",
    "uid:u::::1713600000::ABC123::Example Maintainer <maintainer@example.com>::::::::::0:",
    "sub:u:4096:1:DEADBEEFDEADBEEF:1713600000::::::e::::::23:",
    "fpr:::::::::1111111111111111111111111111111111111111:",
  ].join("\n");
  const fpr = opid._parseGpgColonFingerprint(fixture);
  assert(
    fpr === "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
    `expected primary 40-hex fpr, got ${fpr}`,
  );
});

test("issue366_parseGpgColonFingerprint_returns_null_on_no_fpr", () => {
  const opid = loadOperatorId();
  assert(opid._parseGpgColonFingerprint("") === null, "empty → null");
  assert(
    opid._parseGpgColonFingerprint("pub:u:4096:1:KEYID:::::::::") === null,
    "no fpr record → null",
  );
  // redteam R2: a lone valid fpr with NO owning pub/sec (malformed / non-gpg
  // stream) → primaryCount===0 → null (the `!== 1` tightening, not just `> 1`).
  assert(
    opid._parseGpgColonFingerprint(
      "fpr:::::::::DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF:",
    ) === null,
    "valid fpr with no primary pub → null",
  );
});

test("issue366_fingerprintFromKey_gpg_normalizes_shortid_to_40hex", () => {
  const opid = loadOperatorId();
  // Inject a resolver mapping the short id → 40-hex (keyring-free). This is the
  // function resolveIdentity uses, so a normalized 40-hex now === the roster's
  // schema-mandated 40-hex fingerprint instead of the un-matchable short id.
  const FULL = "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
  const out = opid._fingerprintFromKey("70552B124755B685", "gpg", () => FULL);
  assert(out === FULL, `expected normalized 40-hex, got ${out}`);
});

test("issue366_parseGpgColonFingerprint_ambiguous_collision_returns_null", () => {
  const opid = loadOperatorId();
  // redteam R1 MEDIUM: a colliding short/long key-id makes gpg emit MULTIPLE
  // primary keys. Returning the first fpr would bind to an arbitrary one →
  // role-view escalation. >1 pub/sec record MUST return null (→ fallback →
  // fails 40-hex roster === → safe L2), never an arbitrary first fpr.
  const colliding = [
    "pub:u:4096:1:70552B124755B685:1713600000:::u:::scESC::::::23::0:",
    "fpr:::::::::DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF:",
    "uid:u::::1713600000::AAA::Real Owner <real@example.com>::::::::::0:",
    "pub:-:4096:1:70552B124755B685:1713600001:::-:::scESC::::::23::0:",
    "fpr:::::::::DEADDEADDEADDEADDEADDEADDEADDEADDEADDEAD:",
    "uid:-::::1713600001::BBB::Attacker <evil@elsewhere>::::::::::0:",
  ].join("\n");
  assert(
    opid._parseGpgColonFingerprint(colliding) === null,
    "ambiguous (>1 primary) MUST return null, not an arbitrary first fpr",
  );
});

test("issue366_fingerprintFromKey_gpg_falls_back_to_verbatim_when_unresolvable", () => {
  const opid = loadOperatorId();
  // gpg absent / key not in keyring → resolver returns null → verbatim id
  // (preserves prior behavior; no regression for un-resolvable keys).
  const out = opid._fingerprintFromKey("70552B124755B685", "gpg", () => null);
  assert(out === "70552B124755B685", `expected verbatim fallback, got ${out}`);
});

// ---- summary -----------------------------------------------------------------
console.log("\n=== summary ===");
console.log(`  PASS:${PASS}  FAIL:${FAIL}  SKIP:${SKIP}`);
if (FAIL > 0) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
