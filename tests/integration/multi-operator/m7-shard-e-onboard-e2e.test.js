/**
 * Tier-3 E2E tests for F14 M7 Shard E /onboard deterministic read-path.
 *
 * Validates: against a populated temp repo with roster + team-memory facts
 * + active workspace + posture + codify lease, the helpers /onboard composes
 * return the expected sections in the documented shape.
 *
 * The /onboard *command* is procedural prose; the *helpers* it calls are the
 * surface that must compose correctly. This E2E exercises every helper the
 * command names in the order it names them.
 *
 * Tier 3 discipline (rules/testing.md): real fs + real git + real helpers;
 * read-back-verify every write.
 *
 * Run via:
 *   node --test tests/integration/multi-operator/m7-shard-e-onboard-e2e.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib");

const codifyLease = require(path.join(LIB, "codify-lease.js"));
const stateIo = require(path.join(LIB, "state-io.js"));
const workspaceUtils = require(path.join(LIB, "workspace-utils.js"));

function makeOnboardRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m7-shard-e-onboard-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", ".proposals"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "team-memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workspaces"), { recursive: true });
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

function populateWorkspace(repo, name) {
  const wsDir = path.join(repo, "workspaces", name);
  fs.mkdirSync(path.join(wsDir, "journal"), { recursive: true });
  fs.mkdirSync(path.join(wsDir, "01-discover"), { recursive: true });
  fs.mkdirSync(path.join(wsDir, "briefs"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "briefs", "00-brief.md"), "# brief\n");
  fs.writeFileSync(
    path.join(wsDir, "journal", "0001-DECISION-test.md"),
    "# DECISION: test\n\nbody\n",
  );
  fs.writeFileSync(
    path.join(wsDir, "journal", "0002-DISCOVERY-thing.md"),
    "# DISCOVERY: thing\n\nbody\n",
  );
  return wsDir;
}

function populateTeamMemory(repo) {
  const tmDir = path.join(repo, ".claude", "team-memory");
  fs.writeFileSync(
    path.join(tmDir, "README.md"),
    "# team memory\nGovernance file.\n",
  );
  fs.writeFileSync(
    path.join(tmDir, "fact-one.md"),
    [
      "---",
      "topic: fact-one",
      "signed: true",
      "promoted_at: 2026-05-22",
      "superseded_by: null",
      "---",
      "body of fact one",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tmDir, "fact-two.md"),
    [
      "---",
      "topic: fact-two",
      "signed: false",
      "promoted_at: 2026-05-21",
      "superseded_by: null",
      "---",
      "body of fact two",
    ].join("\n"),
  );
}

// ---- the onboard reader (executes the read-path the command body documents)
// This mirrors the section-by-section runbook in skills/41-onboard/SKILL.md.

function runOnboardReadPath(repoDir) {
  const briefing = {};

  // Section 2: team-memory
  const tmDir = path.join(repoDir, ".claude", "team-memory");
  const facts = [];
  const failed = [];
  if (fs.existsSync(tmDir)) {
    for (const entry of fs.readdirSync(tmDir)) {
      if (!entry.endsWith(".md")) continue;
      if (entry === "README.md") continue;
      const content = fs.readFileSync(path.join(tmDir, entry), "utf8");
      const m = content.match(/^---\n([\s\S]*?)\n---/);
      if (!m) {
        failed.push({ slug: entry, reason: "no frontmatter" });
        continue;
      }
      const fm = {};
      for (const line of m[1].split("\n")) {
        const kv = line.match(/^([a-z_]+):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
      }
      if (fm.superseded_by && fm.superseded_by !== "null") continue;
      facts.push({ slug: entry.replace(/\.md$/, ""), frontmatter: fm });
    }
  }
  briefing.team_memory = { facts, failed_integrity: failed };

  // Section 3: active workspace
  briefing.workspace = workspaceUtils.detectActiveWorkspace(repoDir);

  // Section 4: posture
  briefing.posture = stateIo.readPosture(repoDir);

  // Section 5: codify lease
  briefing.codify_lease = codifyLease.readActiveLease(repoDir);

  return briefing;
}

test("onboard read-path: empty repo emits null lease + fail-closed-or-fresh posture + no facts", (t) => {
  const repo = makeOnboardRepo();
  t.after(() => cleanup(repo));
  const b = runOnboardReadPath(repo);
  // Team memory empty (no <slug>.md files yet).
  assert.equal(b.team_memory.facts.length, 0);
  assert.equal(b.team_memory.failed_integrity.length, 0);
  // Posture present (state-io always returns a posture; fresh repo without
  // .initialized may fail-closed depending on resolver).
  assert.ok(b.posture);
  assert.ok(typeof b.posture.posture === "string");
  // No codify lease.
  assert.equal(b.codify_lease.lease, null);
});

test("onboard read-path: populated team-memory surfaces facts + skips README + skips superseded", (t) => {
  const repo = makeOnboardRepo();
  t.after(() => cleanup(repo));
  populateTeamMemory(repo);
  // Add a superseded fact — MUST be skipped.
  fs.writeFileSync(
    path.join(repo, ".claude", "team-memory", "old-fact.md"),
    [
      "---",
      "topic: old-fact",
      "signed: true",
      "superseded_by: new-fact.md",
      "---",
      "old body",
    ].join("\n"),
  );

  const b = runOnboardReadPath(repo);
  const slugs = b.team_memory.facts.map((f) => f.slug).sort();
  assert.deepEqual(slugs, ["fact-one", "fact-two"]);
  // Verify the README is NOT in facts.
  assert.ok(!slugs.includes("README"));
  // Verify signed metadata present.
  const factOne = b.team_memory.facts.find((f) => f.slug === "fact-one");
  assert.equal(factOne.frontmatter.signed, "true");
});

test("onboard read-path: failed-integrity facts (no frontmatter) appear in failed_integrity, NOT facts", (t) => {
  const repo = makeOnboardRepo();
  t.after(() => cleanup(repo));
  fs.writeFileSync(
    path.join(repo, ".claude", "team-memory", "broken.md"),
    "no frontmatter at all\njust body\n",
  );
  const b = runOnboardReadPath(repo);
  assert.equal(b.team_memory.facts.length, 0);
  assert.equal(b.team_memory.failed_integrity.length, 1);
  assert.equal(b.team_memory.failed_integrity[0].slug, "broken.md");
});

test("onboard read-path: active codify lease is surfaced verbatim", (t) => {
  const repo = makeOnboardRepo();
  t.after(() => cleanup(repo));
  const a = codifyLease.acquireCodifyLease({
    scopeFiles: ["rules/foo.md"],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
  const b = runOnboardReadPath(repo);
  assert.ok(b.codify_lease.lease, "expected active lease in briefing");
  assert.equal(b.codify_lease.lease.display_id, "alice");
  assert.ok(b.codify_lease.lease.branch.startsWith("codify/alice-"));
});

test("onboard read-path: active workspace detected from populated workspaces/ tree", (t) => {
  const repo = makeOnboardRepo();
  t.after(() => cleanup(repo));
  populateWorkspace(repo, "demo-workspace");
  const b = runOnboardReadPath(repo);
  assert.ok(b.workspace, "expected workspace summary");
  // workspace-utils returns {workspace, ...} or {name: ...} depending on
  // implementation. Accept either shape; the load-bearing assertion is that
  // the demo-workspace name appears somewhere.
  const stringified = JSON.stringify(b.workspace);
  assert.ok(
    stringified.includes("demo-workspace"),
    `expected demo-workspace name in workspace summary, got: ${stringified}`,
  );
});

test("onboard read-path: posture transitions are visible via state-io after a downgrade", (t) => {
  const repo = makeOnboardRepo();
  t.after(() => cleanup(repo));
  // Mark the repo as initialized so subsequent reads use posture.json, not
  // the fresh-repo default.
  const learning = path.join(repo, ".claude", "learning");
  fs.writeFileSync(path.join(learning, ".initialized"), "");
  const posture = {
    posture: "L4_CONTINUOUS_INSIGHT",
    since: new Date().toISOString(),
    transition_history: [
      {
        from: "L5_DELEGATED",
        to: "L4_CONTINUOUS_INSIGHT",
        type: "EMERGENCY",
        reason: "test downgrade",
        ts: new Date().toISOString(),
      },
    ],
    pending_verification: ["m7-shard-e/test-rule"],
    violation_window_30d: {},
  };
  fs.writeFileSync(
    path.join(learning, "posture.json"),
    JSON.stringify(posture, null, 2),
  );
  const b = runOnboardReadPath(repo);
  assert.equal(b.posture.posture, "L4_CONTINUOUS_INSIGHT");
  assert.ok(Array.isArray(b.posture.pending_verification));
  assert.ok(b.posture.pending_verification.includes("m7-shard-e/test-rule"));
});

test("onboard command body ≤150 lines (cc-artifacts.md Rule 3)", () => {
  const cmd = path.join(REPO_ROOT, ".claude", "commands", "onboard.md");
  const content = fs.readFileSync(cmd, "utf8");
  const lines = content.split("\n").length;
  assert.ok(
    lines <= 150,
    `onboard.md must be ≤150 lines per cc-artifacts.md Rule 3, got ${lines}`,
  );
});

test("onboard skill exists at the documented path", () => {
  const sk = path.join(
    REPO_ROOT,
    ".claude",
    "skills",
    "41-onboard",
    "SKILL.md",
  );
  assert.ok(fs.existsSync(sk), `${sk} must exist`);
  const content = fs.readFileSync(sk, "utf8");
  assert.ok(
    content.includes("description:"),
    "skill must declare a description",
  );
});
