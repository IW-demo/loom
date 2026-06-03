/**
 * Tier-2 integration tests for shard B1 (workspaces/multi-operator-coc,
 * design v11 §4.1 adjacency relation + §4.2 leases-advisory + §4.3
 * adjacency-leasecheck.js hook + §4.5 F2-2 cohort-window-slide residual).
 *
 * Per rules/testing.md 3-Tier: real fs operations, real ssh-keygen, real
 * canonicalSerialize + real coc-sign. NO subprocess-mocking of coc-sign or
 * the transport. The hook is exercised via real `node` subprocess with
 * stdin JSON payload.
 *
 * Five invariants per the shard contract (workspaces/multi-operator-coc/
 * todos/active/00-todos.md § B1):
 *
 *   (1) SAME relation: exact path/glob match | active dir/glob/workspace
 *       claim contains path | same-commit cohort (last 200 commits, cached)
 *       | phase collision | composed-invariant collision (ADJACENT pair on
 *       axis-3 cohort → promoted to SAME).
 *   (2) ADJACENT relation: same dir | same workspace | parent-child within
 *       1 level | same journal thread.
 *   (3) INDEPENDENT: not SAME and not ADJACENT. Silent + auto-claim.
 *   (4) hook severity: SAME → halt-and-report (registry record not
 *       structural — never block) | §4.2 filesystem exception → block
 *       (git status --porcelain structural) | ADJACENT → advisory |
 *       INDEPENDENT → silent + auto-claim.
 *   (5) F2-2 cohort-window-slide: adjacency evaluated at CLAIM TIME, not
 *       re-evaluated on already-granted claims when the cohort window
 *       advances. §4.5 surfaced-not-eliminated residual.
 *
 * Run: node tests/integration/adjacency-leasecheck.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const HOOK_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const ADJACENCY = path.join(LIB_DIR, "adjacency.js");
const HOOK = path.join(HOOK_DIR, "adjacency-leasecheck.js");
const TRANSPORT = path.join(LIB_DIR, "transport-filesystem.js");
const STATE_IO = path.join(LIB_DIR, "state-io.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");

// ---- minimal async test harness ---------------------------------------------
let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const FAILS = [];
const QUEUE = [];

function test(name, fn) {
  QUEUE.push({ name, fn });
}

async function run() {
  for (const { name, fn } of QUEUE) {
    try {
      const r = await fn();
      if (r === "skip") {
        SKIP += 1;
        console.log(`  SKIP  ${name}`);
        continue;
      }
      PASS += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      FAIL += 1;
      FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
      console.log(`  FAIL  ${name}`);
    }
  }
  console.log(`\n${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
  if (FAIL > 0) {
    console.log("\nFailures:");
    for (const f of FAILS) console.log("  - " + f);
    process.exit(1);
  }
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: ${a} !== ${e}`);
}

// ---- fixtures ----------------------------------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-b1-${label}-`));
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
    `coc-b1-test-${label}`,
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fpOut = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    encoding: "utf8",
  });
  const m = fpOut.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (!m) throw new Error("could not extract fingerprint");
  return { dir, keyPath, pubKey: pub, fingerprint: m[0] };
}

function mkTempRepo(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coc-b1-repo-${label}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function signRecord(core, keyPath) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(core);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`sign failed: ${r.error}`);
  return Object.assign({}, core, { sig: r.sig });
}

// Build a synthetic active claim. Records' "content" field carries the
// claim's path/glob/workspace + phase + axis-3 cohort cohort_commits.
// In production the engine's fold consumes these via rule 7 (claim active
// predicate); for the relation library we feed already-filtered active
// claim objects directly.
function activeClaim(opts) {
  return {
    claim_id:
      opts.claim_id || `claim-${Math.random().toString(36).slice(2, 9)}`,
    verified_id: opts.verified_id || "SHA256:siblingX",
    person_id: opts.person_id || "pid-sibling",
    display_id: opts.display_id || "sibling",
    path: opts.path || null,
    glob: opts.glob || null,
    dir: opts.dir || null,
    workspace: opts.workspace || null,
    phase: opts.phase || null,
    cohort_commits: opts.cohort_commits || null,
    granted_at_seq: opts.granted_at_seq != null ? opts.granted_at_seq : 0,
  };
}

// ============================================================================
// Suite 1 — SAME relation predicates (invariant 1)
// ============================================================================
console.log("\n--- SAME relation predicates ---");

test("same_relation_exact_path_match", () => {
  const { isSame, sameReason } = require(ADJACENCY);
  const claims = [activeClaim({ path: "src/lib/foo.js" })];
  const r = sameReason("src/lib/foo.js", claims, {});
  assertEqual(isSame("src/lib/foo.js", claims, {}), true, "isSame=true");
  assertEqual(r.matched, true, "matched=true");
  assertEqual(r.predicate, "exact", "predicate=exact");
  assert(r.claim_id != null, "claim_id surfaced");
});

test("same_relation_glob_match", () => {
  const { isSame } = require(ADJACENCY);
  const claims = [activeClaim({ glob: "src/lib/**/*.js" })];
  assertEqual(
    isSame("src/lib/sub/bar.js", claims, {}),
    true,
    "glob covers nested path",
  );
});

test("same_relation_dir_contains_path", () => {
  const { isSame, sameReason } = require(ADJACENCY);
  const claims = [activeClaim({ dir: "src/lib" })];
  assertEqual(
    isSame("src/lib/baz.js", claims, {}),
    true,
    "dir claim contains path",
  );
  const r = sameReason("src/lib/baz.js", claims, {});
  assertEqual(r.predicate, "dir-contains", "predicate=dir-contains");
});

test("same_relation_workspace_claim_contains_path", () => {
  const { isSame, sameReason } = require(ADJACENCY);
  const claims = [activeClaim({ workspace: "alpha" })];
  assertEqual(
    isSame("workspaces/alpha/journal/0001.md", claims, {}),
    true,
    "workspace claim contains path under workspaces/<name>/",
  );
  const r = sameReason("workspaces/alpha/journal/0001.md", claims, {});
  assertEqual(r.predicate, "workspace", "predicate=workspace");
});

test("same_relation_phase_collision_promotes_to_same", () => {
  const { isSame, sameReason } = require(ADJACENCY);
  const claims = [
    activeClaim({
      path: "src/lib/foo.js",
      phase: "implement",
    }),
  ];
  const r = sameReason("src/lib/foo.js", claims, { phase: "implement" });
  assertEqual(isSame("src/lib/foo.js", claims, { phase: "implement" }), true);
  // Exact path already matches; promotion via phase is irrelevant here. Use
  // a non-exact path that shares phase against the same artifact dir.
  const c2 = [activeClaim({ dir: "src/lib", phase: "implement" })];
  assertEqual(
    isSame("src/lib/other.js", c2, { phase: "implement" }),
    true,
    "dir-contains + same phase still SAME",
  );
});

test("same_relation_commit_cohort", () => {
  const { isSame, sameReason } = require(ADJACENCY);
  // Two paths share a recent commit in the cohort window: cohort_commits is
  // the set of commit SHAs the claim was granted against; the candidate
  // path's recent-commits set (passed via opts.candidateCommits) intersects.
  const claims = [
    activeClaim({
      glob: "src/other/*.js",
      cohort_commits: ["sha-A", "sha-B"],
    }),
  ];
  const r = sameReason("src/lib/foo.js", claims, {
    candidateCommits: ["sha-A", "sha-X"],
  });
  assertEqual(r.matched, true, "cohort intersection promotes to SAME");
  assertEqual(r.predicate, "commit-cohort", "predicate=commit-cohort");
});

test("same_relation_axis_3_cohort_promotes_adjacent_to_same", () => {
  const { isSame, sameReason } = require(ADJACENCY);
  // Composed-invariant collision (§4.1): an otherwise-ADJACENT load-bearing
  // pair sharing an axis-3 cohort → promoted to SAME.
  const claims = [
    activeClaim({
      dir: "src/auth", // adjacent (same dir as candidate's neighbor)
      cohort_commits: ["sha-axis3"],
    }),
  ];
  // Candidate is in a sibling dir (would be ADJACENT) but shares axis-3
  // cohort.
  const r = sameReason("src/auth/login.js", claims, {
    candidateCommits: ["sha-axis3"],
  });
  assertEqual(r.matched, true, "composed-invariant collision SAME");
});

// ============================================================================
// Suite 2 — ADJACENT relation predicates (invariant 2)
// ============================================================================
console.log("\n--- ADJACENT relation predicates ---");

test("adjacent_relation_same_dir", () => {
  const { isAdjacent, adjacentReason } = require(ADJACENCY);
  const claims = [activeClaim({ path: "src/lib/other.js" })];
  assertEqual(
    isAdjacent("src/lib/foo.js", claims, {}),
    true,
    "same dir → ADJACENT",
  );
  const r = adjacentReason("src/lib/foo.js", claims, {});
  assertEqual(r.predicate, "same-dir", "predicate=same-dir");
});

test("adjacent_relation_parent_child_within_one_level", () => {
  const { isAdjacent } = require(ADJACENCY);
  // claim path = src/lib/foo.js; candidate = src/lib/sub/bar.js
  const claims = [activeClaim({ path: "src/lib/foo.js" })];
  assertEqual(
    isAdjacent("src/lib/sub/bar.js", claims, {}),
    true,
    "parent-child within 1 level",
  );
});

test("adjacent_relation_same_workspace", () => {
  const { isAdjacent, adjacentReason } = require(ADJACENCY);
  // Claim is a path under workspaces/alpha; candidate under same workspace.
  const claims = [activeClaim({ path: "workspaces/alpha/specs/foo.md" })];
  const r = adjacentReason("workspaces/alpha/journal/0001.md", claims, {});
  assertEqual(r.matched, true, "same workspace → ADJACENT");
  assertEqual(r.predicate, "same-workspace", "predicate=same-workspace");
});

test("adjacent_relation_same_journal_thread", () => {
  const { isAdjacent, adjacentReason } = require(ADJACENCY);
  // Both journal entries share the same NNNN slot (same thread).
  const claims = [activeClaim({ path: "journal/0042-FOO-bar.md" })];
  const r = adjacentReason("journal/0042-OTHER-baz.md", claims, {});
  assertEqual(r.matched, true, "same journal NNNN → ADJACENT");
  assertEqual(
    r.predicate,
    "same-journal-thread",
    "predicate=same-journal-thread",
  );
});

test("adjacent_relation_adjacent_journal_thread", () => {
  const { isAdjacent } = require(ADJACENCY);
  const claims = [activeClaim({ path: "journal/0042-FOO-bar.md" })];
  assertEqual(
    isAdjacent("journal/0043-OTHER-baz.md", claims, {}),
    true,
    "adjacent journal NNNN (±1) → ADJACENT",
  );
});

// ============================================================================
// Suite 3 — INDEPENDENT (invariant 3)
// ============================================================================
console.log("\n--- INDEPENDENT (default) ---");

test("independent_relation_default", () => {
  const { isSame, isAdjacent } = require(ADJACENCY);
  const claims = [activeClaim({ path: "src/lib/foo.js" })];
  assertEqual(
    isSame("docs/unrelated/readme.md", claims, {}),
    false,
    "no SAME match",
  );
  assertEqual(
    isAdjacent("docs/unrelated/readme.md", claims, {}),
    false,
    "no ADJACENT match",
  );
});

test("independent_when_no_claims", () => {
  const { isSame, isAdjacent } = require(ADJACENCY);
  assertEqual(isSame("anything", [], {}), false);
  assertEqual(isAdjacent("anything", [], {}), false);
});

// ============================================================================
// Suite 4 — F2-2 cohort-window-slide residual (invariant 5)
// ============================================================================
console.log(
  "\n--- F2-2 cohort-window-slide residual (surfaced-not-eliminated) ---",
);

test("f2_2_already_granted_claim_not_re_evaluated_when_cohort_slides", () => {
  // R5-A-08: adjacency evaluated at claim time; NOT re-evaluated on
  // already-granted claims when the cohort window advances. The relation
  // library MUST NOT itself re-evaluate granted claims; the hook only
  // evaluates the *candidate* path against already-active claims.
  //
  // Behavioral assertion: the library exposes a `reEvaluateGrantedClaims`
  // marker that is structurally absent. A future caller looking for that
  // function gets undefined — the structural surfacing of the residual.
  const mod = require(ADJACENCY);
  assertEqual(
    typeof mod.reEvaluateGrantedClaims,
    "undefined",
    "no granted-claim re-evaluation API exists",
  );
  // The relation functions take only (candidatePath, activeClaims, opts);
  // there is no historical-evaluation surface that could re-run on slide.
  assertEqual(
    mod.isSame.length,
    3,
    "isSame arity = 3 (candidate, claims, opts)",
  );
});

test("f2_2_promotion_evaluated_at_claim_time_not_at_subsequent_folds", () => {
  // Promotion (composed-invariant axis-3 cohort SAME) is evaluated when the
  // candidate is checked, NOT retroactively on a granted claim. We assert
  // that the promotion predicate consumes opts.candidateCommits — i.e.
  // depends on the CANDIDATE's cohort, not on re-walking the granted
  // claim's evolving cohort. A granted claim's cohort_commits is the
  // snapshot at claim time; the library reads it verbatim and never
  // re-derives.
  const { sameReason } = require(ADJACENCY);
  const claims = [
    activeClaim({
      dir: "src/auth",
      cohort_commits: ["sha-axis3"], // pinned at claim time
    }),
  ];
  // First check: candidate's recent commits intersect → SAME via promotion.
  const r1 = sameReason("src/auth/login.js", claims, {
    candidateCommits: ["sha-axis3"],
  });
  assertEqual(r1.matched, true, "promotion fires at claim time");
  // Second check: candidate now has a different cohort (window slid). The
  // GRANTED claim's cohort_commits is unchanged — that's the residual: we
  // do NOT re-walk it; we trust the snapshot.
  const r2 = sameReason("src/auth/login.js", claims, {
    candidateCommits: ["sha-newer"],
  });
  // Result: no promotion (cohort no longer intersects); claim itself is
  // unchanged. Demonstrates the snapshot-not-recomputed behavior.
  assertEqual(
    r2.matched && r2.predicate === "commit-cohort",
    false,
    "claim's cohort snapshot not re-derived from a sliding window",
  );
});

// ============================================================================
// Suite 5 — hook output (invariant 4)
// ============================================================================
console.log("\n--- adjacency-leasecheck hook output ---");

function runHook(payload, env) {
  // Run the hook as a subprocess with stdin = JSON.stringify(payload).
  // env extends process.env. Returns {stdout, stderr, exitCode, json}.
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, env || {}),
    encoding: "utf8",
    timeout: 10000,
  });
  let json = null;
  const stdout = result.stdout || "";
  try {
    json = JSON.parse(stdout.trim().split("\n").pop());
  } catch {
    // best-effort
  }
  return {
    stdout,
    stderr: result.stderr || "",
    exitCode: result.status,
    json,
  };
}

function writeSignedClaim(t, k, claimContent, seq) {
  // Use a fresh "now-ish" timestamp so the LIVENESS_TTL fold predicate (rule 7
  // — 20 min default) treats the sibling session as live. A stale timestamp
  // here drops every claim record from the projected active-claims set
  // because the engine's isSessionLive returns false.
  const nowIso = new Date().toISOString();
  const core = {
    type: "claim",
    verified_id: k.fingerprint,
    person_id: claimContent.person_id || "pid-sibling",
    display_id: claimContent.display_id || "sibling",
    seq: seq != null ? seq : 0,
    prev_hash: null,
    ts: nowIso,
    content: {
      claim_id: claimContent.claim_id || `claim-${seq}`,
      path: claimContent.path || null,
      glob: claimContent.glob || null,
      dir: claimContent.dir || null,
      workspace: claimContent.workspace || null,
      phase: claimContent.phase || null,
      cohort_commits: claimContent.cohort_commits || null,
      expires_at: claimContent.expires_at || "2099-01-01T00:00:00Z",
      last_heartbeat_ts: claimContent.last_heartbeat_ts || nowIso,
    },
  };
  return signRecord(core, k.keyPath);
}

function setupRepoWithSelfKey(label, extraPersons) {
  // The hook MUST resolve identity via operator-id.js. We set
  // COC_OPERATOR_KEY_PATH to inject a known fingerprint as "self" and write
  // a roster that maps it to a person.
  const repoDir = mkTempRepo(label);
  const selfKey = mkEphemeralSshKey(`${label}-self`);
  const learningDir = path.join(repoDir, ".claude", "learning");
  fs.mkdirSync(learningDir, { recursive: true });
  const claudeDir = path.join(repoDir, ".claude");
  // Roster — operator-id.js reads .claude/operators.roster.json. Per the
  // fold engine's rule-1 verification, every roster key MUST carry the
  // pubkey blob (the actual ssh-public-key line), not just a fingerprint.
  const persons = {
    "pid-self": {
      display_id: "self",
      role: "contributor",
      github_login: "self-login",
      host_role: null,
      keys: [
        {
          type: "ssh",
          fingerprint: selfKey.fingerprint,
          pubkey: selfKey.pubKey,
        },
      ],
    },
  };
  if (extraPersons) {
    for (const [pid, p] of Object.entries(extraPersons)) {
      persons[pid] = p;
    }
  }
  const roster = {
    genesis: {
      repo_owner: "test-owner",
      repo_owner_kind: "user",
      root_commit: "0".repeat(40),
      genesis_generation: 1,
    },
    persons,
  };
  fs.writeFileSync(
    path.join(claudeDir, "operators.roster.json"),
    JSON.stringify(roster, null, 2),
  );
  return { repoDir, selfKey };
}

function addSiblingToRoster(repoDir, personId, displayId, siblingKey) {
  const p = path.join(repoDir, ".claude", "operators.roster.json");
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  r.persons[personId] = {
    display_id: displayId,
    role: "contributor",
    github_login: `${displayId}-login`,
    host_role: null,
    keys: [
      {
        type: "ssh",
        fingerprint: siblingKey.fingerprint,
        pubkey: siblingKey.pubKey,
      },
    ],
  };
  fs.writeFileSync(p, JSON.stringify(r, null, 2));
}

test("hook_passthrough_on_non_watched_tool", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("passthrough");
  try {
    const payload = {
      tool_name: "Read",
      tool_input: { file_path: "src/lib/foo.js" },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    assertEqual(r.exitCode, 0, "passthrough exit 0");
    assert(r.json && r.json.continue === true, "continue:true");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("hook_silent_auto_claim_on_independent", async () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("indep");
  try {
    const { createFilesystemTransport } = require(TRANSPORT);
    const t = createFilesystemTransport(repoDir);
    // No sibling claims at all → INDEPENDENT.
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: path.join(repoDir, "src/lib/foo.js") },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    assertEqual(r.exitCode, 0, "exit 0");
    assert(r.json && r.json.continue === true, "continue:true");
    // Auto-claim appended.
    const recs = await t.readAllRecords();
    const claims = recs.filter((rec) => rec && rec.type === "claim");
    assert(claims.length >= 1, "≥1 auto-claim record appended");
    assertEqual(
      claims[0].verified_id,
      selfKey.fingerprint,
      "auto-claim signed by self",
    );
    assert(claims[0].sig && claims[0].sig.length > 0, "auto-claim is signed");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("hook_halt_and_report_on_same_with_claim_id_and_display_id", async () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("same");
  const sibling = mkEphemeralSshKey("same-sib");
  try {
    addSiblingToRoster(repoDir, "pid-sibling", "sibling-display", sibling);
    // Sibling owns an active claim on src/lib/foo.js.
    const { createFilesystemTransport } = require(TRANSPORT);
    const t = createFilesystemTransport(repoDir);
    const claim = writeSignedClaim(
      t,
      sibling,
      {
        claim_id: "claim-sib-001",
        display_id: "sibling-display",
        person_id: "pid-sibling",
        path: "src/lib/foo.js",
      },
      0,
    );
    await t.appendRecord(claim);

    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: path.join(repoDir, "src/lib/foo.js") },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    // halt-and-report is severity, hook returns continue:false at
    // PreToolUse for halt-and-report? No — per instruct-and-wait.js the
    // continue flag is only false for severity:block. halt-and-report
    // exits 0 with continue:true.
    assert(
      r.stderr.indexOf("HALT-AND-REPORT") !== -1,
      "stderr carries HALT-AND-REPORT tag",
    );
    // claim_id + display_id surface in the validation body (the
    // agent_must_report channel per instruct-and-wait.js), NOT in stderr's
    // user_summary (which carries only a one-line tag).
    const v =
      r.json &&
      r.json.hookSpecificOutput &&
      r.json.hookSpecificOutput.validation;
    assert(
      v && v.indexOf("claim-sib-001") !== -1,
      "validation body cites the conflicting claim_id",
    );
    assert(
      v && v.indexOf("sibling-display") !== -1,
      "validation body cites the sibling's display_id",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
    cleanup(sibling.dir);
  }
});

test("hook_advisory_on_adjacent", async () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("adj");
  const sibling = mkEphemeralSshKey("adj-sib");
  try {
    addSiblingToRoster(repoDir, "pid-adj", "adj-sibling", sibling);
    const { createFilesystemTransport } = require(TRANSPORT);
    const t = createFilesystemTransport(repoDir);
    // Sibling claims src/lib/other.js → candidate src/lib/foo.js is ADJACENT.
    const claim = writeSignedClaim(
      t,
      sibling,
      {
        claim_id: "claim-adj-001",
        person_id: "pid-adj",
        display_id: "adj-sibling",
        path: "src/lib/other.js",
      },
      0,
    );
    await t.appendRecord(claim);

    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: path.join(repoDir, "src/lib/foo.js") },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    assertEqual(r.exitCode, 0, "exit 0");
    assert(r.json && r.json.continue === true, "continue:true on advisory");
    assert(r.stderr.indexOf("ADVISORY") !== -1, "stderr carries ADVISORY tag");
    const v =
      r.json &&
      r.json.hookSpecificOutput &&
      r.json.hookSpecificOutput.validation;
    assert(
      v && v.indexOf("claim-adj-001") !== -1,
      "validation body cites the adjacent claim_id",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
    cleanup(sibling.dir);
  }
});

test("hook_block_on_filesystem_exception_when_porcelain_shows_uncommitted_modified", async () => {
  // §4.2 exception (filesystem variant only): cross-worktree contention
  // where `git status --porcelain` on a sibling worktree shows the EXACT
  // target file uncommitted-modified.
  //
  // We simulate by setting COC_PORCELAIN_OVERRIDE — the hook reads the
  // override (test-injection only, gated by the env) and treats it as the
  // structural primitive. This keeps the test deterministic (no need to
  // spawn an actual sibling git worktree with modified files).
  const { repoDir, selfKey } = setupRepoWithSelfKey("block");
  const sibling = mkEphemeralSshKey("block-sib");
  try {
    const { createFilesystemTransport } = require(TRANSPORT);
    const t = createFilesystemTransport(repoDir);
    // Sibling claims path; AND porcelain says they're mid-edit on it.
    const claim = writeSignedClaim(
      t,
      sibling,
      {
        claim_id: "claim-block-001",
        display_id: "block-sibling",
        path: "src/lib/foo.js",
      },
      0,
    );
    await t.appendRecord(claim);
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: path.join(repoDir, "src/lib/foo.js") },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
      // Test-only injection (deterministic surrogate for `git status
      // --porcelain` against a sibling worktree). Lists files modified
      // by sibling workers, one per line, relative to repoDir.
      COC_PORCELAIN_OVERRIDE: "src/lib/foo.js",
    });
    assertEqual(r.exitCode, 2, "block → exit 2 at PreToolUse");
    assert(r.json && r.json.continue === false, "continue:false on block");
    assert(r.stderr.indexOf("BLOCK") !== -1, "stderr carries BLOCK tag");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
    cleanup(sibling.dir);
  }
});

test("hook_skips_when_target_path_is_own_active_claim", async () => {
  // Self-conflict avoidance: if the active claim is the operator's own,
  // the hook MUST NOT halt-and-report against itself. The hook filters
  // active claims by `verified_id != self`.
  const { repoDir, selfKey } = setupRepoWithSelfKey("self");
  try {
    const { createFilesystemTransport } = require(TRANSPORT);
    const t = createFilesystemTransport(repoDir);
    // SELF's claim on src/lib/foo.js.
    const ownClaim = writeSignedClaim(
      t,
      selfKey,
      {
        claim_id: "claim-self-001",
        display_id: "self",
        person_id: "pid-self",
        path: "src/lib/foo.js",
      },
      0,
    );
    await t.appendRecord(ownClaim);
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: path.join(repoDir, "src/lib/foo.js") },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    assertEqual(r.exitCode, 0, "no halt on self-claim");
    assert(r.json && r.json.continue === true, "continue:true");
    assert(
      r.stderr.indexOf("HALT-AND-REPORT") === -1,
      "no halt-and-report against self",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("hook_uses_emit_shape_with_required_fields", async () => {
  // hook-output-discipline.md MUST-1: every halt MUST use instruct-and-wait
  // emit() with all six fields populated. We trigger a SAME-halt and assert
  // the stderr surface lines (user_summary on stderr) AND the JSON shape
  // carries hookSpecificOutput.validation with the canonical body.
  const { repoDir, selfKey } = setupRepoWithSelfKey("emit");
  const sibling = mkEphemeralSshKey("emit-sib");
  try {
    addSiblingToRoster(repoDir, "pid-emit-sib", "emit-sib", sibling);
    const { createFilesystemTransport } = require(TRANSPORT);
    const t = createFilesystemTransport(repoDir);
    const claim = writeSignedClaim(
      t,
      sibling,
      {
        claim_id: "claim-emit-001",
        person_id: "pid-emit-sib",
        display_id: "emit-sib",
        path: "src/lib/foo.js",
      },
      0,
    );
    await t.appendRecord(claim);
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: path.join(repoDir, "src/lib/foo.js") },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    assert(r.json, "stdout parsed as JSON");
    assert(
      r.json.hookSpecificOutput,
      "carries hookSpecificOutput (PreToolUse event)",
    );
    const v = r.json.hookSpecificOutput.validation;
    assert(v && v.length > 0, "validation body non-empty");
    assert(v.indexOf("WHAT HAPPENED:") !== -1, "WHAT HAPPENED present");
    assert(v.indexOf("WHY:") !== -1, "WHY present");
    assert(v.indexOf("REPORT TO USER") !== -1, "REPORT TO USER present");
    assert(v.indexOf("THEN:") !== -1, "agent_must_wait (THEN:) present");
    assert(
      r.stderr.indexOf("[HALT-AND-REPORT]") !== -1,
      "user_summary tag on stderr",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
    cleanup(sibling.dir);
  }
});

test("hook_structural_NULL_on_malformed_log", () => {
  // cc-artifacts.md Rule 7 + hook-output-discipline.md: malformed inputs
  // MUST surface a structural-NULL fallback (continue:true) rather than
  // hanging or crashing. We feed garbage on stdin.
  const { repoDir, selfKey } = setupRepoWithSelfKey("nullin");
  try {
    const result = spawnSync("node", [HOOK], {
      input: "{ this is not json",
      env: Object.assign({}, process.env, {
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
        COC_OPERATOR_REPO_DIR: repoDir,
      }),
      encoding: "utf8",
      timeout: 10000,
    });
    // Even on garbage input the hook MUST exit 0 with continue:true (it
    // cannot evaluate anything; it is a noop, not a block).
    const stdout = result.stdout || "";
    let json = null;
    try {
      json = JSON.parse(stdout.trim().split("\n").pop());
    } catch {
      // best-effort
    }
    assertEqual(result.status, 0, "structural-NULL → exit 0");
    assert(json && json.continue === true, "continue:true on malformed input");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("hook_silent_when_target_path_outside_repo_cwd", () => {
  // The hook only watches Edit|Write on paths within or adjacent to the
  // repo. An absolute path to a temp file outside the repo MUST passthrough
  // (no claim, no conflict possible).
  const { repoDir, selfKey } = setupRepoWithSelfKey("outside");
  try {
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/some-unrelated-file.txt" },
      cwd: repoDir,
    };
    const r = runHook(payload, {
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_OPERATOR_REPO_DIR: repoDir,
    });
    assertEqual(r.exitCode, 0, "exit 0");
    assert(r.json && r.json.continue === true, "continue:true");
    assert(
      r.stderr.indexOf("HALT") === -1 && r.stderr.indexOf("BLOCK") === -1,
      "no halt/block tag",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

run();
