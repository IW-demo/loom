/**
 * Tier-2 integration tests for F14 M7 Shard E team-memory promotion flow.
 *
 * Validates: a /codify-style promotion (acquire lease → draft team-memory
 * file → release) lands a structurally-valid file under .claude/team-memory/.
 *
 * Tier 2 discipline (rules/testing.md): NO mocking; real fs + real git +
 * real lease helper.
 *
 * Run via:
 *   node --test tests/integration/multi-operator/m7-shard-e-team-memory.test.js
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

const { acquireCodifyLease, releaseCodifyLease } = require(CODIFY_LEASE);

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m7-shard-e-tm-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", ".proposals"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "team-memory"), { recursive: true });
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

// Minimal frontmatter parser (the integration test does not depend on a
// YAML library — the team-memory frontmatter is constrained enough that a
// regex-based parse is sufficient for shape assertions).
function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: content };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: m[2] };
}

test("team-memory promotion: acquire lease → write fact → release → file is on disk with valid frontmatter shape", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));

  // Step 1: acquire the codify lease covering the team-memory file.
  const factPath = ".claude/team-memory/example-fact.md";
  const a = acquireCodifyLease({
    scopeFiles: [factPath],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true, `acquire failed: ${JSON.stringify(a)}`);
  assert.ok(a.scope.includes(factPath));

  // Step 2: write the fact file as a /codify session would.
  const absFact = path.join(repo, factPath);
  const draft = [
    "---",
    "topic: example-fact",
    "promoted_by:",
    "  display_id: alice",
    "  verified_id: pending",
    "signed: false",
    "proposal_ref: tests/m7-shard-e-team-memory",
    "promoted_at: 2026-05-22",
    "superseded_by: null",
    "body_anchor: pending",
    "---",
    "",
    "# Example fact",
    "",
    "Body content goes here.",
    "",
    "## Origin",
    "",
    "Tier-2 test fixture.",
  ].join("\n");
  fs.writeFileSync(absFact, draft);

  // Step 3: file MUST exist + parse + have signed-attribution fields.
  const onDisk = fs.readFileSync(absFact, "utf8");
  const parsed = parseFrontmatter(onDisk);
  assert.ok(parsed.frontmatter, "frontmatter must parse");
  assert.equal(parsed.frontmatter.topic, "example-fact");
  // promoted_by is a nested key; the minimal parser doesn't recurse, but
  // the body must contain the literal field for coc-append.js to read.
  assert.ok(onDisk.includes("display_id: alice"));
  assert.equal(parsed.frontmatter.signed, "false");
  assert.equal(parsed.frontmatter.superseded_by, "null");

  // Step 4: release the lease so the next codify can run.
  // Per Sec-MED-3: release derives leasePath from repoDir internally.
  const rel = releaseCodifyLease({
    repoDir: repo,
    displayId: "alice",
  });
  assert.equal(rel.ok, true);
});

test("team-memory directory README is the governance surface, NOT a fact file", (t) => {
  // Ship-side assertion: the README that landed with this shard exists, is
  // non-empty, and documents the split-rule shape. This guards against a
  // future commit that accidentally renames or deletes the README.
  const readme = path.join(REPO_ROOT, ".claude", "team-memory", "README.md");
  assert.ok(fs.existsSync(readme), `${readme} must exist`);
  const content = fs.readFileSync(readme, "utf8");
  assert.ok(content.length > 200);
  assert.ok(
    content.includes("split rule"),
    "README must document the split-rule (one file per fact) layout",
  );
  assert.ok(
    content.includes("Promotion"),
    "README must document the promotion flow",
  );
});

test("two concurrent team-memory promotions on the same fact are serialized by the codify lease", (t) => {
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));

  const a = acquireCodifyLease({
    scopeFiles: [".claude/team-memory/shared-fact.md"],
    displayId: "alice",
    repoDir: repo,
  });
  assert.equal(a.ok, true);

  // Bob attempts the same promotion. MUST be rejected.
  const b = acquireCodifyLease({
    scopeFiles: [".claude/team-memory/shared-fact.md"],
    displayId: "bob",
    repoDir: repo,
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "conflict");
  assert.equal(b.conflicting.display_id, "alice");
});

test("superseded_by field on a fact does NOT block a new fact for the same topic from being staged", (t) => {
  // This is the amend protocol from .claude/team-memory/README.md: amending
  // a fact means writing a NEW file (e.g. <slug>-v2.md) and marking the prior
  // one superseded. Both files coexist; the codify lease serializes the
  // amendment under a single operator.
  const repo = makeTempRepo();
  t.after(() => cleanup(repo));

  // Initial fact
  const f1 = path.join(repo, ".claude", "team-memory", "topic.md");
  const f2 = path.join(repo, ".claude", "team-memory", "topic-v2.md");
  fs.writeFileSync(
    f1,
    "---\ntopic: topic\nsigned: true\nsuperseded_by: topic-v2.md\n---\nold body\n",
  );
  fs.writeFileSync(
    f2,
    "---\ntopic: topic\nsigned: true\nsuperseded_by: null\n---\nnew body\n",
  );

  // Both files present.
  assert.ok(fs.existsSync(f1));
  assert.ok(fs.existsSync(f2));

  // The next promotion (a third revision) on the same topic acquires the
  // lease the same way.
  const a = acquireCodifyLease({
    scopeFiles: [".claude/team-memory/topic-v3.md"],
    displayId: "carol",
    repoDir: repo,
  });
  assert.equal(a.ok, true);
});
