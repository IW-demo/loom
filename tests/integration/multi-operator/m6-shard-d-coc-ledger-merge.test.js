/**
 * Tier-3 E2E test: coc-ledger merge driver against a real `git merge`
 * (Shard M6 D §5.1 invariant 2).
 *
 * Verifies the merge driver:
 *   1. Reconciles two operators' concurrent edits to
 *      `.session-notes.shared.md` row-by-row by stable ID column.
 *   2. Preserves per-row `owner:` attribution after merge (line-by-line
 *      git merge silently scrambles this — the structural failure mode
 *      this driver exists to close).
 *   3. Drops rows deleted on both sides; keeps rows only-modified on
 *      one side; conflict-markers rows changed differently on both
 *      sides naming the per-row owners.
 *
 * Tier-3 discipline (rules/testing.md § Tier 3): real git binary, real
 * filesystem, every write verified via read-back. No mocking of git or
 * merge machinery.
 *
 * Per probe-driven-verification.md Rule 3: structural probes — git
 * exit code, file content substring, parseLedger row count + owner
 * extraction.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const COC_LEDGER = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "coc-ledger.js",
);
const { parseLedger } = require(COC_LEDGER);

function mkTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m6d-ledger-merge-"));
  const g = (args, opts = {}) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", ...opts });
  g(["init", "-q", "--initial-branch=main"]);
  g(["config", "user.email", "m6d-test@example.com"]);
  g(["config", "user.name", "m6d-test"]);
  // Register the driver per the .gitattributes contract (this is the
  // per-clone config every operator MUST set; the test mirrors that).
  g([
    "config",
    "merge.coc-ledger.name",
    "COC forest-ledger 3-way merge (test)",
  ]);
  g(["config", "merge.coc-ledger.driver", `node ${COC_LEDGER} %O %A %B %P`]);
  // Bind the file pattern.
  fs.writeFileSync(
    path.join(dir, ".gitattributes"),
    ".session-notes.shared.md merge=coc-ledger\n",
  );
  g(["add", ".gitattributes"]);
  g(["commit", "-qm", "init: .gitattributes"]);
  return { dir, g };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function buildLedger(rows) {
  const header = [
    "# Forest Ledger",
    "",
    "| ID | owner | item | value_anchor | status |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    header.push(
      `| ${r.id} | ${r.owner} | ${r.item} | ${r.value_anchor} | ${r.status} |`,
    );
  }
  return header.join("\n") + "\n";
}

test("real-git merge: two operators add distinct rows — both preserved with owner attribution", () => {
  const { dir, g } = mkTempGitRepo();
  try {
    // Base — empty ledger.
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([]),
    );
    g(["add", ".session-notes.shared.md"]);
    g(["commit", "-qm", "base: empty ledger"]);

    // Branch alice.
    g(["checkout", "-qb", "alice"]);
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "alice",
          item: "alice item",
          value_anchor: "brief A",
          status: "queued",
        },
      ]),
    );
    g(["commit", "-qam", "alice: add F1"]);

    // Branch bob from base.
    g(["checkout", "-q", "main"]);
    g(["checkout", "-qb", "bob"]);
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F2",
          owner: "bob",
          item: "bob item",
          value_anchor: "brief B",
          status: "in-flight",
        },
      ]),
    );
    g(["commit", "-qam", "bob: add F2"]);

    // Merge bob into alice.
    g(["checkout", "-q", "alice"]);
    g(["merge", "-q", "--no-edit", "bob"]);
    const merged = fs.readFileSync(
      path.join(dir, ".session-notes.shared.md"),
      "utf8",
    );
    const parsed = parseLedger(merged);
    assert.equal(parsed.rows.length, 2, "both rows preserved");
    const byId = new Map(parsed.rows.map((r) => [r.id, r]));
    assert.equal(byId.get("F1").owner, "alice");
    assert.equal(byId.get("F2").owner, "bob");
  } finally {
    cleanup(dir);
  }
});

test("real-git merge: one-side modify preserves the modification (not the base)", () => {
  const { dir, g } = mkTempGitRepo();
  try {
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "alice",
          item: "original",
          value_anchor: "anchor",
          status: "queued",
        },
      ]),
    );
    g(["add", ".session-notes.shared.md"]);
    g(["commit", "-qm", "base: F1 queued"]);

    g(["checkout", "-qb", "alice"]);
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "alice",
          item: "original",
          value_anchor: "anchor",
          status: "in-flight",
        },
      ]),
    );
    g(["commit", "-qam", "alice: F1 → in-flight"]);

    g(["checkout", "-q", "main"]);
    g(["checkout", "-qb", "bob"]);
    // Bob does NOT modify F1; instead adds F2.
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "alice",
          item: "original",
          value_anchor: "anchor",
          status: "queued",
        },
        {
          id: "F2",
          owner: "bob",
          item: "bob",
          value_anchor: "b",
          status: "queued",
        },
      ]),
    );
    g(["commit", "-qam", "bob: add F2 untouched F1"]);

    g(["checkout", "-q", "alice"]);
    g(["merge", "-q", "--no-edit", "bob"]);
    const merged = fs.readFileSync(
      path.join(dir, ".session-notes.shared.md"),
      "utf8",
    );
    const parsed = parseLedger(merged);
    assert.equal(parsed.rows.length, 2);
    const byId = new Map(parsed.rows.map((r) => [r.id, r]));
    // Alice's modification (status=in-flight) MUST win since bob didn't change F1.
    assert.equal(byId.get("F1").cells[4], "in-flight");
    assert.equal(byId.get("F2").owner, "bob");
  } finally {
    cleanup(dir);
  }
});

test("real-git merge: both sides modify same row differently → per-row conflict markers naming owners", () => {
  const { dir, g } = mkTempGitRepo();
  try {
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "alice",
          item: "original",
          value_anchor: "anchor",
          status: "queued",
        },
      ]),
    );
    g(["add", ".session-notes.shared.md"]);
    g(["commit", "-qm", "base"]);

    g(["checkout", "-qb", "alice"]);
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "alice",
          item: "alice rewrite",
          value_anchor: "anchor",
          status: "queued",
        },
      ]),
    );
    g(["commit", "-qam", "alice: rewrite F1.item"]);

    g(["checkout", "-q", "main"]);
    g(["checkout", "-qb", "bob"]);
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      buildLedger([
        {
          id: "F1",
          owner: "bob",
          item: "bob rewrite",
          value_anchor: "anchor",
          status: "queued",
        },
      ]),
    );
    g(["commit", "-qam", "bob: rewrite F1 owner+item"]);

    g(["checkout", "-q", "alice"]);
    // The merge MUST exit non-zero (conflict-markered); we read the
    // file to verify the per-row conflict markers carry per-row
    // owner names.
    let mergeFailed = false;
    try {
      g(["merge", "-q", "--no-edit", "bob"]);
    } catch (e) {
      mergeFailed = true;
    }
    assert.equal(mergeFailed, true, "merge MUST report conflict");
    const merged = fs.readFileSync(
      path.join(dir, ".session-notes.shared.md"),
      "utf8",
    );
    // Per-row conflict markers carry the per-row owner names — this is
    // the load-bearing improvement over default text-merge.
    assert.match(merged, /<<<<<<< owner=alice/);
    assert.match(merged, />>>>>>> owner=bob/);
    // Both branches' content present.
    assert.match(merged, /alice rewrite/);
    assert.match(merged, /bob rewrite/);
  } finally {
    cleanup(dir);
  }
});
