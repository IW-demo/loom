#!/usr/bin/env node
/*
 * Tier-2 regression for the codex-mcp-guard policies.json freshness guard
 * (DF-AC6-2 / journal/0246 / validate-emit `codex-policies-fresh` check).
 *
 * `policies.json` is what server.js loads at runtime to decide which CC hooks
 * gate each Codex tool. The README claims it is "regenerated on every /sync",
 * but nothing enforced that — so it froze at its original commit while
 * settings.json gained Bash registrations (operator-gate / signing-mutation-
 * guard / genesis-anchor-guard), silently dropping those gates from Codex. This
 * guard asserts the committed artifact deep-equals a FRESH extraction so the
 * drift can never ship silently again.
 *
 * Two layers (per rules/probe-driven-verification.md MUST-3 — structural):
 *   (1) Unit — canonicalPolicies order-insensitivity (pure).
 *   (2) Integration — checkCodexPoliciesFresh against the LIVE repo (PASS,
 *       regression-lock that the regen stays committed) AND against a temp root
 *       whose committed policies.json is corrupted (FAIL, proven non-vacuous).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

const { checkCodexPoliciesFresh, canonicalPolicies, STATUS } = await import(
  path.join(REPO, ".claude", "bin", "validate-emit.mjs")
);

const fails = (r) => r.results.filter((x) => x.status === STATUS.FAIL);

// ── (1) UNIT — canonicalPolicies ─────────────────────────────────
test("canonicalPolicies: order-insensitive on tools, entries, matcher arrays", () => {
  const a = {
    shell: [
      { source_file: "b.js", cc_matchers: ["Bash"], invocation: "subprocess" },
      { source_file: "a.js", cc_matchers: ["Edit", "Write"], invocation: "subprocess" },
    ],
    apply_patch: [{ source_file: "c.js", cc_matchers: ["Edit"], invocation: "subprocess" }],
  };
  const b = {
    apply_patch: [{ source_file: "c.js", cc_matchers: ["Edit"], invocation: "subprocess" }],
    shell: [
      { source_file: "a.js", cc_matchers: ["Write", "Edit"], invocation: "subprocess" },
      { source_file: "b.js", cc_matchers: ["Bash"], invocation: "subprocess" },
    ],
  };
  assert.equal(canonicalPolicies(a), canonicalPolicies(b));
});

test("canonicalPolicies: detects a dropped entry", () => {
  const full = { shell: [{ source_file: "a.js", cc_matchers: ["Bash"], invocation: "subprocess" }, { source_file: "b.js", cc_matchers: ["Bash"], invocation: "subprocess" }] };
  const partial = { shell: [{ source_file: "a.js", cc_matchers: ["Bash"], invocation: "subprocess" }] };
  assert.notEqual(canonicalPolicies(full), canonicalPolicies(partial));
});

// ── (2) INTEGRATION ──────────────────────────────────────────────
test("LIVE repo: committed policies.json matches fresh extraction (PASS)", () => {
  const r = checkCodexPoliciesFresh(REPO);
  assert.equal(fails(r).length, 0, JSON.stringify(r.results, null, 2));
  assert.ok(r.results.some((x) => x.status === STATUS.PASS), JSON.stringify(r.results));
});

test("stale committed policies.json → FAIL with the regen command (non-vacuous)", () => {
  // Build a minimal temp root: the canonical extractor + the live hooks/settings
  // + a deliberately-corrupted committed policies.json. realpathSync resolves the
  // macOS /var→/private/var tmpdir symlink so the copied extractor's
  // `import.meta.url === file://${process.argv[1]}` entrypoint guard matches
  // (otherwise main() silently no-ops on the symlinked path).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-fresh-")));
  try {
    const cg = path.join(root, ".claude", "codex-mcp-guard");
    fs.mkdirSync(cg, { recursive: true });
    fs.cpSync(
      path.join(REPO, ".claude", "codex-mcp-guard", "extract-policies.mjs"),
      path.join(cg, "extract-policies.mjs"),
    );
    fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(root, ".claude", "hooks"), { recursive: true });
    fs.cpSync(
      path.join(REPO, ".claude", "settings.json"),
      path.join(root, ".claude", "settings.json"),
    );
    // Corrupt: drop every entry so the committed file is stale vs the real extraction.
    fs.writeFileSync(path.join(cg, "policies.json"), JSON.stringify({ version: 1, source_dir: ".claude/hooks", policies: { shell: [], unified_exec: [], apply_patch: [] } }, null, 2) + "\n");
    const r = checkCodexPoliciesFresh(root);
    const f = fails(r)[0];
    assert.ok(f, "expected a STALE FAIL");
    assert.match(f.detail, /STALE/);
    assert.match(f.detail, /extract-policies\.mjs.*--write-policies/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale committed policies.json behind a SYMLINKED path prefix → still FAILs (R1 MED-1 realpath fix)", () => {
  // The check realpathSyncs the extractor so a symlinked checkout prefix (the
  // /var→/private/var class) does NOT silently no-op the extractor's entrypoint
  // guard → SKIP-masks-stale. Build the temp root behind an explicit symlink and
  // assert the gate still FAILs on a stale file rather than SKIPping.
  const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-")));
  const linkBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-")));
  const root = path.join(linkBase, "via-symlink");
  try {
    const cg = path.join(realRoot, ".claude", "codex-mcp-guard");
    fs.mkdirSync(cg, { recursive: true });
    fs.cpSync(path.join(REPO, ".claude", "codex-mcp-guard", "extract-policies.mjs"), path.join(cg, "extract-policies.mjs"));
    fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(realRoot, ".claude", "hooks"), { recursive: true });
    fs.cpSync(path.join(REPO, ".claude", "settings.json"), path.join(realRoot, ".claude", "settings.json"));
    fs.writeFileSync(path.join(cg, "policies.json"), JSON.stringify({ version: 1, source_dir: ".claude/hooks", policies: { shell: [], unified_exec: [], apply_patch: [] } }, null, 2) + "\n");
    fs.symlinkSync(realRoot, root); // `root` reaches the tree through a symlink
    const r = checkCodexPoliciesFresh(root);
    const f = fails(r)[0];
    assert.ok(f, `expected STALE FAIL through symlinked path, got: ${JSON.stringify(r.results)}`);
    assert.match(f.detail, /STALE/);
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true });
    fs.rmSync(linkBase, { recursive: true, force: true });
  }
});

test("CC-only consumer (no codex-mcp-guard) → SKIP, not FAIL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-only-"));
  try {
    fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
    const r = checkCodexPoliciesFresh(root);
    assert.equal(fails(r).length, 0);
    assert.ok(r.results.every((x) => x.status === STATUS.SKIP), JSON.stringify(r.results));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
