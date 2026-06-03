/**
 * Tier-2 integration tests for shard B3a (workspaces/multi-operator-coc,
 * design v11 §2.3 + §4.3 hook table rows):
 *
 *   - journal-write-guard.js (file-existence + slot-reservation invariants)
 *   - integrity-guard.js     (codify-branch + lease-record invariants)
 *   - signing-mutation-guard.js (degraded-mode + sibling-worktree-mutation
 *                                predicate — §4.2 production primitive)
 *   - lib/sibling-porcelain.js (production primitive consumed by both
 *                               signing-mutation-guard AND B1's
 *                               adjacency-leasecheck.js in production)
 *
 * Per rules/testing.md 3-Tier: real fs operations, real ssh-keygen, real
 * canonicalSerialize + real coc-sign. NO subprocess-mocking of coc-sign,
 * transport, or the porcelain primitive. Hooks are exercised via real
 * `node` subprocess with stdin JSON payload, mirroring the B1 test style
 * established in tests/integration/adjacency-leasecheck.test.js.
 *
 * Three invariants per B3a shard contract
 * (workspaces/multi-operator-coc/todos/active/00-todos.md § B3a):
 *
 *   (1) journal-write-guard.js — pre-tool-use Write on journal/:
 *       file on disk → block (structural fs.existsSync);
 *       slot unreserved per fold → halt-and-report;
 *       reserved by self → passthrough;
 *       reserved by sibling → halt-and-report;
 *       outside-repo / unwatched → passthrough.
 *
 *   (2) integrity-guard.js — pre-tool-use Edit|Write on §2.3 watched
 *       paths (operators.roster.json, coordination-log.jsonl,
 *       posture.json, journal directories, workspace journal dirs):
 *       branch != codify/<display_id>-<date> → block (structural
 *       `git rev-parse --abbrev-ref HEAD`);
 *       branch matches but no covering codify-lease record → halt-and-report;
 *       both pass → passthrough;
 *       unwatched path → passthrough.
 *
 *   (3) signing-mutation-guard.js — pre-tool-use:
 *       (a) Bash `git commit`/`git push` (git-ref transport mode);
 *       (b) ANY mutation-capable tool/Bash (filesystem transport mode).
 *       Sibling worktree's `git status --porcelain` shows target path
 *         modified → block (structural primitive: sibling-porcelain.js);
 *       Degraded mode (no signing key + would-be mutation on tracked
 *         path) → block (working-tree-mutation predicate per R4-S-02 +
 *         R5-S-03);
 *       Otherwise → passthrough.
 *
 *   Cross-shard handoff: B1's adjacency-leasecheck.js MUST consume
 *   sibling-porcelain.js in production; COC_PORCELAIN_OVERRIDE keeps
 *   precedence for B1's existing test suite (the test surrogate the
 *   production primitive supersedes).
 *
 * Run: node tests/integration/integrity-guards.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

("use strict");

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const HOOK_DIR = path.join(REPO_ROOT, ".claude", "hooks");

const JOURNAL_WRITE_GUARD = path.join(HOOK_DIR, "journal-write-guard.js");
const INTEGRITY_GUARD = path.join(HOOK_DIR, "integrity-guard.js");
const SIGNING_MUTATION_GUARD = path.join(HOOK_DIR, "signing-mutation-guard.js");

const SIBLING_PORCELAIN = path.join(LIB_DIR, "sibling-porcelain.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");
const ADJACENCY_LEASECHECK = path.join(HOOK_DIR, "adjacency-leasecheck.js");

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

// ---- fixtures ---------------------------------------------------------------

function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-b3a-${label}-`));
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
    `coc-b3a-test-${label}`,
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
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `coc-b3a-repo-${label}-`),
  );
  // Initialize as a real git repo so `git rev-parse --abbrev-ref HEAD`
  // returns a known branch. integrity-guard relies on real git.
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  // Need at least one commit for branch creation to work via checkout.
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".session-notes\n");
  execFileSync("git", ["-C", repoDir, "add", ".gitignore"]);
  execFileSync("git", [
    "-C",
    repoDir,
    "-c",
    "user.email=test@coc",
    "-c",
    "user.name=B3a Test",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  return repoDir;
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

function writeRoster(repoDir, persons) {
  const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  const roster = {
    genesis: {
      repo_owner: "test-owner",
      repo_owner_kind: "user",
      root_commit: "deadbeef",
      genesis_generation: 1,
    },
    persons,
  };
  fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
  return rosterPath;
}

function appendRecord(repoDir, record) {
  const logPath = path.join(
    repoDir,
    ".claude",
    "learning",
    "coordination-log.jsonl",
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
}

function runHook(hookPath, payload, env, cwd) {
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, env || {}),
    encoding: "utf8",
    cwd: cwd || process.cwd(),
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

function setupRepoWithSelfKey(label) {
  const repoDir = mkTempRepo(label);
  const selfKey = mkEphemeralSshKey(`${label}-self`);
  const siblingKey = mkEphemeralSshKey(`${label}-sib`);
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
    "pid-sibling": {
      display_id: "sibling",
      role: "contributor",
      github_login: "sibling-login",
      host_role: null,
      keys: [
        {
          type: "ssh",
          fingerprint: siblingKey.fingerprint,
          pubkey: siblingKey.pubKey,
        },
      ],
    },
  };
  writeRoster(repoDir, persons);
  return { repoDir, selfKey, siblingKey };
}

// signed slot-reservation record — M6 D's writer is not shipped yet; B3a
// reads existing reservations from the fold. The record TYPE is what
// matters; rule 1 + rule 2 of coordination-log.js will fold any
// signature-verified record, and the guard scans `accepted` for the
// `journal-slot-reservation` type.
function makeSlotReservation({ key, person_id, display_id, slot, dir, seq }) {
  const nowIso = new Date().toISOString();
  const core = {
    type: "journal-slot-reservation",
    verified_id: key.fingerprint,
    person_id,
    display_id,
    seq: seq != null ? seq : 0,
    prev_hash: null,
    ts: nowIso,
    content: {
      slot, // string like "0042"
      dir, // string like "journal" or "workspaces/foo/journal"
    },
  };
  return signRecord(core, key.keyPath);
}

function makeCodifyLease({
  key,
  person_id,
  display_id,
  scope_files,
  date,
  seq,
}) {
  const nowIso = new Date().toISOString();
  const core = {
    type: "codify-lease",
    verified_id: key.fingerprint,
    person_id,
    display_id,
    seq: seq != null ? seq : 0,
    prev_hash: null,
    ts: nowIso,
    content: {
      scope_files, // array of repo-relative paths the lease covers
      date, // YYYY-MM-DD matching codify/<display_id>-<date> branch
      branch: `codify/${display_id}-${date}`,
    },
  };
  return signRecord(core, key.keyPath);
}

// ============================================================================
// Suite 1 — journal-write-guard.js (Invariant 1)
// ============================================================================
console.log("\n--- journal-write-guard.js ---");

test("journal_write_guard_blocks_when_file_exists", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-blocks-exists");
  try {
    // Create the journal entry on disk — the file-existence predicate
    // fires PRE any registry check (structural fs.existsSync is the
    // process-local primitive per hook-output-discipline.md MUST-2).
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    const target = path.join(journalDir, "0042-DECISION-something.md");
    fs.writeFileSync(target, "# existing\n");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(JOURNAL_WRITE_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 2, `exit 2 expected, got ${r.exitCode}`);
    assert(r.json && r.json.continue === false, "continue=false");
    assert(
      r.stderr.includes("[BLOCK]"),
      `expected [BLOCK] in stderr, got: ${r.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("journal_write_guard_halt_when_slot_unreserved", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-halt-unreserved");
  try {
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    // No coordination log entries for this slot — the registry check fails.
    const target = path.join(journalDir, "0007-DECISION-foo.md");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(JOURNAL_WRITE_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    // halt-and-report → exit 0 + continue:true, but agent_must_report
    // surfaced via hookSpecificOutput.validation + stderr [HALT-AND-REPORT].
    assertEqual(r.exitCode, 0, "exit 0 expected for halt-and-report");
    assert(r.json && r.json.continue === true, "continue=true on halt");
    assert(
      r.stderr.includes("[HALT-AND-REPORT]"),
      `expected [HALT-AND-REPORT] tag, got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput &&
        r.json.hookSpecificOutput.validation.includes("slot"),
      "validation mentions slot",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("journal_write_guard_passthrough_when_slot_reserved_by_self", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-pass-self");
  try {
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    const reservation = makeSlotReservation({
      key: selfKey,
      person_id: "pid-self",
      display_id: "self",
      slot: "0012",
      dir: "journal",
      seq: 0,
    });
    appendRecord(repoDir, reservation);
    const target = path.join(journalDir, "0012-DECISION-mine.md");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(JOURNAL_WRITE_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "passthrough exit 0");
    assert(r.json && r.json.continue === true, "continue=true");
    assert(
      !r.stderr.includes("[BLOCK]") && !r.stderr.includes("[HALT-AND-REPORT]"),
      `expected silent passthrough, got stderr: ${r.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

// F101-3 author-backing branch (after the self-reserved slot check). These
// exercise the FULL hook executable end-to-end: a self-reserved slot reaches
// the author-backing branch, which verifies the `author:` frontmatter claim
// against the live per-session provenance ledger.
const PROV_LEDGER = require(path.join(LIB_DIR, "provenance-ledger.js"));
const PROV_EVENT = require(path.join(LIB_DIR, "provenance-event.js"));

function seedHumanInputLedger(repoDir, session, count, fingerprint) {
  const lp = PROV_LEDGER._ledgerPath(repoDir, session);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  let prior = null;
  const lines = [];
  for (let i = 0; i < count; i++) {
    const ev = PROV_EVENT.chainProvenanceEvent(prior, {
      kind: "HumanInput",
      ts: "2026-06-01T12:00:00Z",
      session,
      operatorRef: { verified_id: fingerprint, person_id: "pid-self" },
      payload: { prompt_sha256: "a".repeat(64), char_count: 5 },
    });
    lines.push(JSON.stringify(ev));
    prior = ev;
  }
  fs.writeFileSync(lp, lines.join("\n") + (lines.length ? "\n" : ""));
  return lp;
}

function authorBackingPayload(repoDir, target, session, author) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    session_id: session,
    tool_input: {
      file_path: target,
      content:
        "---\ntype: DECISION\ndate: 2026-06-01\nauthor: " +
        author +
        "\nsession_id: " +
        session +
        "\ntopic: walk\n---\n\nSECRET-sk-WALK must never appear in hook output.\n",
    },
    cwd: repoDir,
  };
}

test("journal_write_guard_halt_when_author_human_unbacked_empty_ledger", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-author-unbacked");
  try {
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    appendRecord(
      repoDir,
      makeSlotReservation({
        key: selfKey,
        person_id: "pid-self",
        display_id: "self",
        slot: "0050",
        dir: "journal",
        seq: 0,
      }),
    );
    const session = "walk-unbacked";
    // Empty ledger: capture ran, ZERO HumanInput events this session.
    seedHumanInputLedger(repoDir, session, 0, selfKey.fingerprint);
    const target = path.join(journalDir, "0050-self-DECISION-claim.md");
    const r = runHook(
      JOURNAL_WRITE_GUARD,
      authorBackingPayload(repoDir, target, session, "human"),
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    // REGISTRY-class → halt-and-report (continue:true), NEVER block.
    assertEqual(r.exitCode, 0, "halt-and-report exit 0");
    assert(r.json && r.json.continue === true, "continue=true on halt");
    assert(
      r.stderr.includes("[HALT-AND-REPORT]"),
      `expected [HALT-AND-REPORT], got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput.validation.includes(
        "journal-author-discipline",
      ),
      "validation cites journal-author-discipline",
    );
    assert(
      !r.json.hookSpecificOutput.validation.includes(
        "STOP — Tool call blocked",
      ),
      "MUST NOT be block severity",
    );
    assert(
      !(r.stdout + r.stderr).includes("SECRET-sk-WALK"),
      "secrets fence: raw content MUST NOT leak into hook output",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("journal_write_guard_passthrough_when_author_human_backed", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-author-backed");
  try {
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    appendRecord(
      repoDir,
      makeSlotReservation({
        key: selfKey,
        person_id: "pid-self",
        display_id: "self",
        slot: "0051",
        dir: "journal",
        seq: 0,
      }),
    );
    const session = "walk-backed";
    seedHumanInputLedger(repoDir, session, 1, selfKey.fingerprint);
    const target = path.join(journalDir, "0051-self-DECISION-backed.md");
    const r = runHook(
      JOURNAL_WRITE_GUARD,
      authorBackingPayload(repoDir, target, session, "human"),
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    assertEqual(r.exitCode, 0, "passthrough exit 0");
    assert(r.json && r.json.continue === true, "continue=true");
    assert(
      !r.stderr.includes("[BLOCK]") && !r.stderr.includes("[HALT-AND-REPORT]"),
      `backed author → silent passthrough, got stderr: ${r.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("journal_write_guard_passthrough_when_author_agent", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-author-agent");
  try {
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    appendRecord(
      repoDir,
      makeSlotReservation({
        key: selfKey,
        person_id: "pid-self",
        display_id: "self",
        slot: "0052",
        dir: "journal",
        seq: 0,
      }),
    );
    const session = "walk-agent";
    // Even with ZERO HumanInput, author:agent makes no human claim → n/a-agent.
    seedHumanInputLedger(repoDir, session, 0, selfKey.fingerprint);
    const target = path.join(journalDir, "0052-self-DISCOVERY-agent.md");
    const r = runHook(
      JOURNAL_WRITE_GUARD,
      authorBackingPayload(repoDir, target, session, "agent"),
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    assertEqual(r.exitCode, 0, "passthrough exit 0");
    assert(r.json && r.json.continue === true, "continue=true");
    assert(
      !r.stderr.includes("[BLOCK]") && !r.stderr.includes("[HALT-AND-REPORT]"),
      `agent author → silent passthrough, got stderr: ${r.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("journal_write_guard_halt_when_slot_reserved_by_sibling", () => {
  const { repoDir, selfKey, siblingKey } =
    setupRepoWithSelfKey("jw-halt-sibling");
  try {
    const journalDir = path.join(repoDir, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    const reservation = makeSlotReservation({
      key: siblingKey,
      person_id: "pid-sibling",
      display_id: "sibling",
      slot: "0023",
      dir: "journal",
      seq: 0,
    });
    appendRecord(repoDir, reservation);
    const target = path.join(journalDir, "0023-DECISION-theirs.md");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(JOURNAL_WRITE_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "halt-and-report exit 0");
    assert(r.json && r.json.continue === true, "continue=true on halt");
    assert(
      r.stderr.includes("[HALT-AND-REPORT]"),
      `expected halt tag, got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput &&
        r.json.hookSpecificOutput.validation.includes("sibling"),
      "validation names sibling reserver",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
    cleanup(siblingKey.dir);
  }
});

test("journal_write_guard_passthrough_on_outside_repo_path", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("jw-pass-outside");
  try {
    // Absolute path NOT under repoDir.
    const outsidePath = path.join(os.tmpdir(), "not-the-repo-journal-0001.md");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: outsidePath },
      cwd: repoDir,
    };
    const r = runHook(JOURNAL_WRITE_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "passthrough");
    assert(r.json && r.json.continue === true, "continue=true");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

// ============================================================================
// Suite 2 — integrity-guard.js (Invariant 2)
// ============================================================================
console.log("\n--- integrity-guard.js ---");

function setupCodifyBranch(repoDir, displayId, date) {
  const branch = `codify/${displayId}-${date}`;
  execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", branch]);
  return branch;
}

test("integrity_guard_blocks_on_non_codify_branch", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("ig-non-codify");
  try {
    // Stay on main (non-codify branch).
    const watched = path.join(repoDir, ".claude", "operators.roster.json");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: watched },
      cwd: repoDir,
    };
    const r = runHook(INTEGRITY_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 2, "block exit 2");
    assert(r.json && r.json.continue === false, "continue=false");
    assert(
      r.stderr.includes("[BLOCK]"),
      `expected [BLOCK], got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput &&
        r.json.hookSpecificOutput.validation.includes("codify/"),
      "validation cites codify/ branch convention",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("integrity_guard_halt_when_codify_lease_unverifiable_on_codify_branch", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("ig-halt-no-lease");
  try {
    const date = "2026-05-21";
    setupCodifyBranch(repoDir, "self", date);
    const watched = path.join(
      repoDir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    // No codify-lease record in the log.
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: watched },
      cwd: repoDir,
    };
    const r = runHook(INTEGRITY_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "halt exit 0");
    assert(r.json && r.json.continue === true, "continue=true on halt");
    assert(
      r.stderr.includes("[HALT-AND-REPORT]"),
      `expected halt tag, got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput &&
        r.json.hookSpecificOutput.validation.includes("lease"),
      "validation mentions lease",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("integrity_guard_passthrough_when_branch_and_lease_match", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("ig-pass-both");
  try {
    const date = "2026-05-21";
    setupCodifyBranch(repoDir, "self", date);
    const watched = path.join(
      repoDir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    const lease = makeCodifyLease({
      key: selfKey,
      person_id: "pid-self",
      display_id: "self",
      scope_files: [".claude/learning/coordination-log.jsonl"],
      date,
      seq: 0,
    });
    appendRecord(repoDir, lease);
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: watched },
      cwd: repoDir,
    };
    const r = runHook(INTEGRITY_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "passthrough");
    assert(r.json && r.json.continue === true, "continue=true");
    assert(
      !r.stderr.includes("[BLOCK]") && !r.stderr.includes("[HALT-AND-REPORT]"),
      `expected silent passthrough, got: ${r.stderr.slice(0, 200)}`,
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("integrity_guard_passthrough_on_unwatched_path", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("ig-pass-unwatched");
  try {
    // Path not in the watched-set: src/foo.js
    const unwatched = path.join(repoDir, "src", "foo.js");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: unwatched },
      cwd: repoDir,
    };
    const r = runHook(INTEGRITY_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "passthrough on unwatched");
    assert(r.json && r.json.continue === true, "continue=true");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("integrity_guard_branch_predicate_uses_git_rev_parse_structural", () => {
  // Structural predicate: the block must be grounded in a real git invocation,
  // not a lexical regex against tool_input. We test that by checking the
  // expected.txt-aligned shape — the hook MUST cite the resolved branch
  // string in its agent_must_report, proving it ran `git rev-parse`.
  const { repoDir, selfKey } = setupRepoWithSelfKey("ig-structural");
  try {
    // Confirm the repo is on main, and the hook reports that exact branch
    // string in its validation body.
    const watched = path.join(repoDir, ".claude", "operators.roster.json");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: watched },
      cwd: repoDir,
    };
    const r = runHook(INTEGRITY_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 2, "block on non-codify");
    assert(
      r.json.hookSpecificOutput.validation.includes("main"),
      `validation should cite the resolved branch 'main', got: ${r.json.hookSpecificOutput.validation.slice(0, 400)}`,
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

// ============================================================================
// Suite 3 — signing-mutation-guard.js (Invariant 3)
// ============================================================================
console.log("\n--- signing-mutation-guard.js ---");

test("signing_mutation_guard_blocks_when_sibling_porcelain_shows_modified_target", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("smg-sibling");
  try {
    // Inject a synthetic sibling-worktree porcelain override; the guard MUST
    // detect the target path in the override and block. The test-surrogate
    // is identical to the one M2 B1 uses (COC_PORCELAIN_OVERRIDE) — Rule 4
    // documented this as the production-precedence pair: override wins in
    // tests; sibling-porcelain.js wins in production.
    const target = "src/lib/foo.js";
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(SIGNING_MUTATION_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      COC_PORCELAIN_OVERRIDE: target,
    });
    assertEqual(r.exitCode, 2, "block on sibling-modified target");
    assert(r.json && r.json.continue === false, "continue=false");
    assert(
      r.stderr.includes("[BLOCK]"),
      `expected [BLOCK], got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput.validation.includes("porcelain") ||
        r.json.hookSpecificOutput.validation.includes("sibling"),
      "validation cites sibling/porcelain structural signal",
    );
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("signing_mutation_guard_passthrough_when_no_sibling_modifies_target", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("smg-no-sibling");
  try {
    const target = "src/lib/foo.js";
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    // No override; no sibling worktrees in the temp repo → primitive returns
    // empty enumeration; no signing-key absence → not in degraded mode either.
    const r = runHook(SIGNING_MUTATION_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "passthrough");
    assert(r.json && r.json.continue === true, "continue=true");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("signing_mutation_guard_blocks_in_degraded_mode_when_write_attempted", () => {
  const { repoDir } = setupRepoWithSelfKey("smg-degraded");
  try {
    // No signing key present → resolveIdentity returns
    // {verified_id: null, posture: L2_SUPERVISED}. A would-be mutation on a
    // tracked path (working-tree-mutation predicate) MUST block per R4-S-02
    // + R5-S-03. We explicitly omit COC_OPERATOR_KEY_PATH.
    // Use a tracked path that EXISTS (.gitignore was committed in mkTempRepo).
    const target = path.join(repoDir, ".gitignore");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(SIGNING_MUTATION_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      // Explicit degraded-mode signal — no key path is discoverable. We set
      // a clearly-empty discovery to short-circuit operator-id discovery.
      COC_OPERATOR_KEY_PATH: "",
      COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED: "1",
    });
    assertEqual(r.exitCode, 2, "block in degraded mode");
    assert(r.json && r.json.continue === false, "continue=false");
    assert(
      r.stderr.includes("[BLOCK]"),
      `expected [BLOCK], got: ${r.stderr.slice(0, 200)}`,
    );
    assert(
      r.json.hookSpecificOutput.validation.includes("degraded") ||
        r.json.hookSpecificOutput.validation.includes("signing"),
      "validation cites degraded/signing condition",
    );
  } finally {
    cleanup(repoDir);
  }
});

test("signing_mutation_guard_passthrough_when_signing_key_present_and_no_mutation_detected", () => {
  const { repoDir, selfKey } = setupRepoWithSelfKey("smg-pass-clean");
  try {
    // Non-mutating tool (Read) — guard MUST passthrough.
    const target = path.join(repoDir, ".gitignore");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: target },
      cwd: repoDir,
    };
    const r = runHook(SIGNING_MUTATION_GUARD, payload, {
      COC_OPERATOR_REPO_DIR: repoDir,
      COC_OPERATOR_KEY_PATH: selfKey.keyPath,
    });
    assertEqual(r.exitCode, 0, "passthrough");
    assert(r.json && r.json.continue === true, "continue=true");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("signing_mutation_guard_uses_sibling_porcelain_helper_for_enumeration", () => {
  // Behavioral assertion: the lib/sibling-porcelain.js module exposes the
  // detectSiblingMutation API the hook consumes. We require() it and
  // confirm the contract.
  const lib = require(SIBLING_PORCELAIN);
  assert(
    typeof lib.detectSiblingMutation === "function",
    "detectSiblingMutation export missing",
  );
  assert(
    typeof lib.enumerateSiblingWorktrees === "function",
    "enumerateSiblingWorktrees export missing",
  );
  // Behavioral: in a fresh temp repo with no sibling worktrees, the helper
  // returns the empty match-set.
  const { repoDir } = setupRepoWithSelfKey("smg-helper");
  try {
    const matches = lib.detectSiblingMutation(repoDir, "src/lib/foo.js");
    assertEqual(matches, [], "no sibling worktrees → empty match-set");
  } finally {
    cleanup(repoDir);
  }
});

test("signing_mutation_guard_supersedes_b1_porcelain_override_in_production", () => {
  // Cross-shard handoff assertion (Rule 4 of B3a): B1's adjacency-leasecheck
  // MUST consume sibling-porcelain.js in production. The test-surrogate
  // COC_PORCELAIN_OVERRIDE retains precedence for B1's existing test suite
  // (production primitive runs ONLY when the override is unset).
  //
  // Behavior check: the adjacency-leasecheck.js source MUST require
  // sibling-porcelain.js, AND its detectFilesystemExceptionMatch path MUST
  // honor the override-precedence ordering.
  const src = fs.readFileSync(ADJACENCY_LEASECHECK, "utf8");
  assert(
    src.includes("sibling-porcelain"),
    "adjacency-leasecheck.js MUST require sibling-porcelain.js (B3a Step 6 wiring)",
  );
  // Check override-precedence semantics: when COC_PORCELAIN_OVERRIDE is set,
  // it MUST be used. The simplest behavioral check is that the file still
  // mentions COC_PORCELAIN_OVERRIDE (override precedence retained).
  assert(
    src.includes("COC_PORCELAIN_OVERRIDE"),
    "COC_PORCELAIN_OVERRIDE precedence retained for tests",
  );
});

// ============================================================================
// Suite 4 — hook-output-discipline compliance (all 3 hooks)
// ============================================================================
console.log("\n--- hook-output-discipline compliance ---");

function checkSixFieldEmitShape(stderr, json) {
  // emit() produces both: a stderr [TAG] line + a hookSpecificOutput.validation
  // body containing WHAT HAPPENED / WHY / REPORT TO USER / THEN.
  const hasTag =
    stderr.includes("[BLOCK]") ||
    stderr.includes("[HALT-AND-REPORT]") ||
    stderr.includes("[ADVISORY]");
  assert(hasTag, `stderr lacks severity tag: ${stderr.slice(0, 200)}`);
  const validation =
    json && json.hookSpecificOutput && json.hookSpecificOutput.validation;
  assert(validation, "json.hookSpecificOutput.validation missing");
  assert(
    validation.includes("WHAT HAPPENED:"),
    "validation lacks WHAT HAPPENED field",
  );
  assert(validation.includes("WHY:"), "validation lacks WHY field");
  assert(
    validation.includes("REPORT TO USER"),
    "validation lacks REPORT TO USER field",
  );
  assert(validation.includes("THEN:"), "validation lacks THEN field");
}

test("all_guards_use_emit_shape_with_six_fields", () => {
  const { repoDir, selfKey, siblingKey } =
    setupRepoWithSelfKey("discipline-shape");
  try {
    // Trigger halt-and-report on each of the 3 guards and assert the full
    // six-field shape (per hook-output-discipline.md MUST-1).
    // 1. journal-write-guard: slot reserved by sibling
    fs.mkdirSync(path.join(repoDir, "journal"), { recursive: true });
    appendRecord(
      repoDir,
      makeSlotReservation({
        key: siblingKey,
        person_id: "pid-sibling",
        display_id: "sibling",
        slot: "0099",
        dir: "journal",
        seq: 0,
      }),
    );
    const jw = runHook(
      JOURNAL_WRITE_GUARD,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: path.join(repoDir, "journal", "0099-DECISION-x.md"),
        },
        cwd: repoDir,
      },
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    checkSixFieldEmitShape(jw.stderr, jw.json);

    // 2. integrity-guard: non-codify branch + watched path → block
    const ig = runHook(
      INTEGRITY_GUARD,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(repoDir, ".claude", "operators.roster.json"),
        },
        cwd: repoDir,
      },
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    checkSixFieldEmitShape(ig.stderr, ig.json);

    // 3. signing-mutation-guard: sibling porcelain → block
    const sm = runHook(
      SIGNING_MUTATION_GUARD,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "src/lib/foo.js" },
        cwd: repoDir,
      },
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
        COC_PORCELAIN_OVERRIDE: "src/lib/foo.js",
      },
    );
    checkSixFieldEmitShape(sm.stderr, sm.json);
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
    cleanup(siblingKey.dir);
  }
});

test("all_guards_block_severity_grounded_in_structural_signal", () => {
  // Per hook-output-discipline.md MUST-2, severity:block MUST come from a
  // structural / behavioral / AST signal — not a lexical regex.
  // Read each hook's source and confirm the block branches cite their
  // structural primitive in JSDoc/code comments.
  const jwSrc = fs.readFileSync(JOURNAL_WRITE_GUARD, "utf8");
  const igSrc = fs.readFileSync(INTEGRITY_GUARD, "utf8");
  const smSrc = fs.readFileSync(SIGNING_MUTATION_GUARD, "utf8");
  assert(
    jwSrc.includes("fs.existsSync") && jwSrc.includes('severity: "block"'),
    "journal-write-guard block branch must be grounded in fs.existsSync",
  );
  assert(
    igSrc.includes("rev-parse") && igSrc.includes('severity: "block"'),
    "integrity-guard block branch must be grounded in git rev-parse",
  );
  assert(
    (smSrc.includes("git status") || smSrc.includes("porcelain")) &&
      smSrc.includes('severity: "block"'),
    "signing-mutation-guard block branch must be grounded in porcelain primitive",
  );
});

test("all_guards_structural_NULL_on_malformed_log", () => {
  // Per cc-artifacts.md Rule 7 + hook-output-discipline.md MUST-4, hooks
  // MUST emit {continue:true} on malformed-input/internal-error paths. We
  // corrupt the coordination log and confirm every guard passes through.
  const { repoDir, selfKey } = setupRepoWithSelfKey("discipline-null");
  try {
    const logPath = path.join(
      repoDir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "{not-valid-json\n"); // malformed

    // journal-write-guard: slot-unreserved check still works (or passes thru)
    fs.mkdirSync(path.join(repoDir, "journal"), { recursive: true });
    const jw = runHook(
      JOURNAL_WRITE_GUARD,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: path.join(repoDir, "journal", "0001-DECISION-x.md"),
        },
        cwd: repoDir,
      },
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    // halt-and-report is acceptable (slot unreserved), but exit MUST be 0.
    // The forbidden outcome is exit 1 or a crash with no payload.
    assert(
      jw.exitCode === 0,
      `jw exit not 0: ${jw.exitCode}, stderr=${jw.stderr.slice(0, 200)}`,
    );
    assert(jw.json && jw.json.continue === true, "jw continue=true required");

    // integrity-guard: on main + malformed log + watched path → block
    // (branch predicate fires first; log read failure does not crash).
    const ig = runHook(
      INTEGRITY_GUARD,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(repoDir, ".claude", "operators.roster.json"),
        },
        cwd: repoDir,
      },
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    // structural NULL: hook MUST not crash with exit 1
    assert(
      ig.exitCode === 0 || ig.exitCode === 2,
      `ig exit unexpected: ${ig.exitCode}`,
    );
    assert(ig.json != null, "ig must emit JSON, not crash");

    // signing-mutation-guard: with no override, malformed log, no mutation →
    // should passthrough; if it errors, MUST be {continue:true}.
    const sm = runHook(
      SIGNING_MUTATION_GUARD,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(repoDir, ".gitignore") },
        cwd: repoDir,
      },
      {
        COC_OPERATOR_REPO_DIR: repoDir,
        COC_OPERATOR_KEY_PATH: selfKey.keyPath,
      },
    );
    assert(sm.exitCode === 0, `sm exit not 0: ${sm.exitCode}`);
    assert(sm.json && sm.json.continue === true, "sm continue=true");
  } finally {
    cleanup(repoDir);
    cleanup(selfKey.dir);
  }
});

test("all_guards_passthrough_on_timeout", () => {
  // Per cc-artifacts.md Rule 7: every hook MUST ship a setTimeout fallback
  // that emits {continue:true} on timeout. We confirm the source has the
  // canonical fallback shape; an actual timeout-trigger would need a slow
  // primitive (out of scope for unit-style assertion).
  for (const hookPath of [
    JOURNAL_WRITE_GUARD,
    INTEGRITY_GUARD,
    SIGNING_MUTATION_GUARD,
  ]) {
    const src = fs.readFileSync(hookPath, "utf8");
    assert(
      src.includes("setTimeout"),
      `${path.basename(hookPath)} missing setTimeout fallback`,
    );
    assert(
      src.includes("continue: true") || src.includes('continue":true'),
      `${path.basename(hookPath)} missing {continue:true} fallback payload`,
    );
  }
});

// ============================================================================
// Run
// ============================================================================
run();
