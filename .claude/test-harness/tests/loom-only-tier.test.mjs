#!/usr/bin/env node
/*
 * F104 — loom_only: tier tests (Tier 1, deterministic, no LLM/network).
 *
 * Asserts the two load-bearing F104 contracts:
 *
 *   (a) EMISSION SKIP — a path declared in `loom_only:` is NOT emitted to
 *       ANY target (codex/gemini via emit-cli-artifacts.mjs; cc via
 *       sync-tier-aware.mjs::classifyFile). The 8 migrated artifacts (7
 *       management agents + open-source-strategist) are the canonical
 *       loom-only set.
 *
 *   (b) MUTUAL-EXCLUSION VALIDATOR — validate-emit check 8 FAILS when a
 *       loom_only path is ALSO in a synced tier, and PASSES when the
 *       loom_only set is disjoint from every tier. A loom_only glob
 *       matching 0 on-disk files = WARN (non-blocking SKIP).
 *
 * Run: node .claude/test-harness/tests/loom-only-tier.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadLoomOnly,
  emitCodexAgentPrompts,
  emitGeminiAgents,
  emitCommands,
  emitSkills,
} from "../../bin/emit-cli-artifacts.mjs";
import { classifyFile } from "../../bin/sync-tier-aware.mjs";
import {
  checkLoomOnlyMutualExclusion,
  parseLoomOnly,
  parseTiers,
} from "../../bin/validate-emit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// The 8 artifacts F104 migrated into loom_only:.
const LOOM_ONLY_AGENTS = [
  "agents/management/coc-sync.md",
  "agents/management/sync-reviewer.md",
  "agents/management/repo-ops.md",
  "agents/management/settings-manager.md",
  "agents/management/posture-auditor.md",
  "agents/management/todo-manager.md",
  "agents/management/gh-manager.md",
  "agents/open-source-strategist.md",
];

// ---------- parser: loadLoomOnly returns the declared set ----------

test("loadLoomOnly parses all 8 migrated artifacts", () => {
  const lo = loadLoomOnly();
  for (const a of LOOM_ONLY_AGENTS) {
    assert.ok(lo.includes(a), `loom_only must declare ${a}`);
  }
});

// ---------- (a) EMISSION SKIP — codex + gemini, every agent ----------

test("loom_only agents are NOT emitted to codex or gemini for any target", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f104-emit-"));
  try {
    const loomOnly = loadLoomOnly();
    // tierFilter=null exercises the legacy emit-everything mode — the
    // STRONGEST test: with no tier filter, only loom_only can suppress these.
    emitCodexAgentPrompts({ outDir: tmp, exclusions: { codex: [], gemini: [] }, tierFilter: null, loomOnly, lang: null, verbose: false });
    emitGeminiAgents({ outDir: tmp, exclusions: { codex: [], gemini: [] }, tierFilter: null, loomOnly, lang: null, verbose: false });

    const codexPrompts = listIfExists(path.join(tmp, "codex", "prompts"));
    const geminiAgents = listIfExists(path.join(tmp, "gemini", "agents"));

    for (const stem of ["coc-sync", "sync-reviewer", "repo-ops", "settings-manager", "posture-auditor", "todo-manager", "gh-manager", "open-source-strategist", "specialist-coc-sync"]) {
      assert.ok(
        !codexPrompts.some((n) => n.includes(stem)),
        `codex must NOT emit a prompt containing "${stem}" (loom_only)`,
      );
      assert.ok(
        !geminiAgents.some((n) => n.includes(stem)),
        `gemini must NOT emit an agent containing "${stem}" (loom_only)`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a NON-loom-only agent IS still emitted (loom_only does not over-suppress)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f104-emit2-"));
  try {
    const loomOnly = loadLoomOnly();
    emitGeminiAgents({ outDir: tmp, exclusions: { codex: [], gemini: [] }, tierFilter: null, loomOnly, lang: null, verbose: false });
    const geminiAgents = listIfExists(path.join(tmp, "gemini", "agents"));
    // analyst is a normal synced specialist — MUST still emit.
    assert.ok(
      geminiAgents.some((n) => n.includes("analyst")),
      "a non-loom-only specialist (analyst) MUST still emit to gemini",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- (a) EMISSION SKIP — cc file-copy path ----------

test("loom_only agents classify as skip/loom_only on the cc copy path", () => {
  const loomOnly = parseLoomOnly(REPO_ROOT);
  assert.ok(loomOnly && loomOnly.length >= 8, "parseLoomOnly must read the stanza");
  // Inclusion globs that WOULD match (simulate a coc-tier that still listed
  // the management agents) — proving loom_only wins BEFORE tier inclusion.
  const inclusionGlobs = ["agents/**"];
  for (const a of LOOM_ONLY_AGENTS) {
    const rel = `.claude/${a}`;
    const d = classifyFile(rel, inclusionGlobs, [], [], loomOnly);
    assert.equal(d.action, "skip", `${a} must be skipped on the cc path`);
    assert.equal(d.reason, "loom_only", `${a} skip reason must be loom_only (positive), not no_tier_match`);
  }
});

test("a non-loom-only agent still copies on the cc path under a matching tier", () => {
  const loomOnly = parseLoomOnly(REPO_ROOT);
  const d = classifyFile(".claude/agents/analysis/analyst.md", ["agents/**"], [], [], loomOnly);
  assert.equal(d.action, "copy");
  assert.equal(d.reason, "tier_match");
});

// ---------- (b) MUTUAL-EXCLUSION VALIDATOR ----------

test("check 8 PASSES on the real (disjoint) manifest", () => {
  const r = checkLoomOnlyMutualExclusion(REPO_ROOT);
  const fails = r.results.filter((x) => x.status === "fail");
  assert.equal(fails.length, 0, `expected 0 fails, got: ${JSON.stringify(fails)}`);
  // Every migrated artifact present → PASS (in no synced tier, on disk).
  const passes = r.results.filter((x) => x.status === "pass").map((x) => x.artifact);
  for (const a of LOOM_ONLY_AGENTS) {
    assert.ok(passes.includes(a), `${a} must PASS check 8 (never-sync, no tier, on-disk)`);
  }
});

test("check 8 FAILS when a loom_only path is ALSO in a synced tier", () => {
  const tmp = makeSandboxManifest((manifest) =>
    // Add a path that IS in the coc tier (dataflow-specialist) to loom_only.
    manifest.replace(
      "loom_only:\n",
      "loom_only:\n  - agents/frameworks/dataflow-specialist.md\n",
    ),
  );
  try {
    const r = checkLoomOnlyMutualExclusion(tmp);
    const fail = r.results.find((x) => x.artifact === "agents/frameworks/dataflow-specialist.md");
    assert.ok(fail, "the colliding path must appear in results");
    assert.equal(fail.status, "fail", "collision MUST be a blocking FAIL");
    assert.match(fail.detail, /coc/, "the fail detail MUST name the colliding tier (coc)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("check 8 WARNs (non-blocking SKIP) when a loom_only glob matches 0 files", () => {
  const tmp = makeSandboxManifest((manifest) =>
    manifest.replace(
      "loom_only:\n",
      "loom_only:\n  - agents/does-not-exist-xyz.md\n",
    ),
  );
  try {
    const r = checkLoomOnlyMutualExclusion(tmp);
    const warn = r.results.find((x) => x.artifact === "agents/does-not-exist-xyz.md");
    assert.ok(warn, "the zero-match path must appear in results");
    assert.equal(warn.status, "skip", "zero-match MUST be a non-blocking SKIP, not a FAIL");
    assert.match(warn.detail, /WARN/, "the skip detail MUST carry a WARN: marker");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseTiers reads the coc tier (sanity for the collision test)", () => {
  const tiers = parseTiers(REPO_ROOT);
  assert.ok(tiers.coc && tiers.coc.length > 0, "coc tier must parse");
  assert.ok(
    tiers.coc.includes("agents/frameworks/dataflow-specialist.md"),
    "coc tier must still contain dataflow-specialist (the collision fixture path)",
  );
});

// ---------- helpers ----------

function listIfExists(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Build a sandbox repo root whose .claude/sync-manifest.yaml is the real
// manifest mutated by `mutate`, with the on-disk agent fixtures the check
// existence-tests against. Returns the sandbox root (caller rmSync's it).
function makeSandboxManifest(mutate) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f104-validate-"));
  const claudeDir = path.join(tmp, ".claude");
  fs.mkdirSync(path.join(claudeDir, "agents", "frameworks"), { recursive: true });
  // Mark it a repo root so findRepoRoot resolves here if cwd-based; the
  // check we call takes an explicit root so this is belt-and-suspenders.
  fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
  const real = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
  fs.writeFileSync(path.join(claudeDir, "sync-manifest.yaml"), mutate(real));
  // dataflow-specialist must exist on disk for the collision FAIL to fire
  // (the check still FAILs on collision before the existence WARN branch).
  fs.writeFileSync(path.join(claudeDir, "agents", "frameworks", "dataflow-specialist.md"), "# stub\n");
  return tmp;
}
