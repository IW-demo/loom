/**
 * Tier-2 integration tests for F14 M7 Shard E codify-lease.
 *
 * Validates: two concurrent /codify attempts on the same scope → one acquires,
 * one loses with typed conflict; release flow; mandatory-scope union.
 *
 * Per probe-driven-verification.md Rule 3: assertions are structural — return
 * shape checks against the acquireCodifyLease helper, lease-file inspection
 * via fs, branch-name assertion against the lease object.
 *
 * Tier 2 discipline (rules/testing.md): NO mocking; real fs + real git +
 * real lease state file under a temp repo.
 *
 * Run via:
 *   node --test tests/integration/multi-operator/m7-shard-e-codify-lease.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CODIFY_LEASE = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "codify-lease.js",
);

const {
  acquireCodifyLease,
  releaseCodifyLease,
  readActiveLease,
  MANDATORY_SCOPE,
  BRANCH_PREFIX,
  LEASE_FILE,
  _test_sortDedupRel,
} = require(CODIFY_LEASE);

// ---- temp repo scaffold -----------------------------------------------------

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m7-shard-e-lease-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", ".proposals"), { recursive: true });
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

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

test("acquireCodifyLease succeeds on a clean repo with valid display_id", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  // CLAUDE_TRUST_STATE_DIR not set; state-resolver falls back to git toplevel.
  const r = acquireCodifyLease({
    scopeFiles: ["rules/foo.md"],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  assert.ok(r.lease, "expected lease object");
  assert.equal(r.lease.display_id, "alice");
  assert.ok(
    r.branch.startsWith(BRANCH_PREFIX + "alice-"),
    `branch should start with ${BRANCH_PREFIX}alice-, got ${r.branch}`,
  );
  // Mandatory scope was unioned in.
  for (const m of MANDATORY_SCOPE) {
    assert.ok(
      r.scope.includes(m),
      `scope should include mandatory ${m}, got ${JSON.stringify(r.scope)}`,
    );
  }
  // Caller's file is preserved.
  assert.ok(r.scope.includes("rules/foo.md"));
  // Lease file landed.
  assert.ok(fs.existsSync(r.leasePath), `lease file ${r.leasePath} missing`);
});

test("acquireCodifyLease rejects invalid display_id", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  const bad = acquireCodifyLease({
    scopeFiles: [],
    displayId: "Alice With Spaces",
    repoDir: repo,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid-display-id");
});

test("two concurrent acquires on overlapping scope: one wins, one loses with conflict reason", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  const a = acquireCodifyLease({
    scopeFiles: ["rules/foo.md"],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
  const b = acquireCodifyLease({
    scopeFiles: ["rules/foo.md"], // overlapping
    displayId: "bob",
    repoDir: repo,
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "conflict");
  assert.ok(b.conflicting, "conflict result must carry conflicting payload");
  assert.equal(b.conflicting.display_id, "alice");
  assert.ok(b.conflicting.acquired_at);
  assert.ok(b.error.includes("Scope overlaps"));
});

test("two concurrent acquires on DISJOINT scope still conflict — one lease per repo", (t) => {
  // The lease is repo-scoped, not file-scoped: even disjoint scope files
  // require the active lease holder to release first. This is intentional —
  // .proposals/latest.yaml is always in scope (mandatory), so true disjoint
  // is impossible. The test asserts the design.
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  const a = acquireCodifyLease({
    scopeFiles: ["rules/foo.md"],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
  const b = acquireCodifyLease({
    scopeFiles: ["skills/bar/SKILL.md"], // no overlap with rules/foo.md per se,
    // but mandatory scope still applies.
    displayId: "bob",
    repoDir: repo,
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "conflict");
});

test("releaseCodifyLease by holder allows a subsequent acquire", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  const a = acquireCodifyLease({
    scopeFiles: ["rules/foo.md"],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
  const rel = releaseCodifyLease({
    repoDir: repo,
    displayId: "alice",
  });
  assert.equal(rel.ok, true);
  const b = acquireCodifyLease({
    scopeFiles: ["rules/bar.md"],
    displayId: "bob",
    repoDir: repo,
  });
  assert.equal(
    b.ok,
    true,
    `expected re-acquire after release, got: ${JSON.stringify(b)}`,
  );
  assert.equal(b.lease.display_id, "bob");
});

test("releaseCodifyLease by non-holder is rejected (wrong-owner)", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  const a = acquireCodifyLease({
    scopeFiles: [],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
  const r = releaseCodifyLease({
    repoDir: repo,
    displayId: "bob",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong-owner");
});

test("releaseCodifyLease ignores caller-supplied leasePath (Sec-MED-3 — no misroute)", (t) => {
  // Sec-MED-3 fix: a caller passing a leasePath: argument MUST NOT misroute
  // the release write to another file under .claude/learning/. The function
  // derives the leasePath from repoDir internally and reads/writes ONLY the
  // canonical path (.claude/learning/codify-lease.json under the resolved
  // git toplevel). A caller-supplied leasePath is silently ignored.
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));

  // Alice acquires the canonical lease.
  const a = acquireCodifyLease({
    scopeFiles: [],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);

  // Create a DECOY lease file under .claude/learning/ with bob as holder.
  // If the implementation honored caller-supplied leasePath, the release
  // call below could be tricked into reading/writing the decoy and would
  // succeed for bob (since the decoy says bob owns it).
  const decoyPath = path.join(repo, ".claude", "learning", "decoy-lease.json");
  fs.writeFileSync(
    decoyPath,
    JSON.stringify({
      lease_id: "lease_decoy",
      display_id: "bob",
      _released: false,
      _version: 1,
    }) + "\n",
  );

  // Attacker bob attempts release supplying the decoy path. The function
  // MUST derive leasePath from repoDir and refuse — the canonical lease
  // is held by alice, so bob gets wrong-owner.
  const evilRelease = releaseCodifyLease({
    leasePath: decoyPath, // ignored — must NOT misroute
    repoDir: repo,
    displayId: "bob",
  });
  assert.equal(evilRelease.ok, false);
  assert.equal(
    evilRelease.reason,
    "wrong-owner",
    `expected wrong-owner (canonical lease is alice's); got ${JSON.stringify(evilRelease)}`,
  );

  // The decoy file remains untouched (no canonical-path write to it).
  const decoyAfter = JSON.parse(fs.readFileSync(decoyPath, "utf8"));
  assert.equal(
    decoyAfter._released,
    false,
    "decoy file MUST NOT be mutated by the release call",
  );

  // The canonical lease (alice's) remains acquired (read-only check by alice).
  const stillHeld = readActiveLease(repo);
  assert.ok(stillHeld.lease, "canonical lease must still be active");
  assert.equal(stillHeld.lease.display_id, "alice");
});

test("readActiveLease returns null for fresh repo, surfaces lease post-acquire", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  const empty = readActiveLease(repo);
  assert.equal(empty.lease, null);
  const a = acquireCodifyLease({
    scopeFiles: [],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
  const held = readActiveLease(repo);
  assert.ok(held.lease, "expected active lease after acquire");
  assert.equal(held.lease.display_id, "alice");
});

test("scope-dirty refuses to acquire (uncommitted edits to scope file)", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  // Create the mandatory-scope file as uncommitted.
  const proposalsDir = path.join(repo, ".claude", ".proposals");
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.writeFileSync(path.join(proposalsDir, "latest.yaml"), "uncommitted\n");
  const r = acquireCodifyLease({
    scopeFiles: [],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "scope-dirty");
  assert.ok(Array.isArray(r.dirty));
  assert.ok(r.dirty.length > 0);
});

test("corrupt lease file is surfaced, not silently treated as no-lease", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));
  // Write invalid JSON directly to the lease path.
  const leasePath = path.join(repo, ".claude", "learning", LEASE_FILE);
  fs.writeFileSync(leasePath, "{not json}");
  const r = acquireCodifyLease({
    scopeFiles: [],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "lease-corrupt");
});

test("_test_sortDedupRel normalizes + sorts + unions mandatory scope", () => {
  const out = _test_sortDedupRel(["rules/z.md", " rules/a.md ", "rules/z.md"]);
  // Expect alphabetical, dedup, mandatory unioned.
  assert.ok(out.includes("rules/z.md"));
  assert.ok(out.includes("rules/a.md"));
  for (const m of MANDATORY_SCOPE) assert.ok(out.includes(m));
  // Sorted.
  const sorted = [...out].sort();
  assert.deepEqual(out, sorted);
});

test("acquireCodifyLease fails cleanly when repoDir is not a git repo", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m7-shard-e-nongit-"));
  t.after(() => cleanup(dir));
  const r = acquireCodifyLease({
    scopeFiles: [],
    displayId: "alice",
    repoDir: dir,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-a-git-repo");
});
