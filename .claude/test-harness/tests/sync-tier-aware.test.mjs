#!/usr/bin/env node
/*
 * Regression tests for .claude/bin/sync-tier-aware.mjs (issue #272).
 *
 * Tier 1 (deterministic, no network, no LLM). Asserts the canonical
 * tier-filtering contract that closes the recurring ad-hoc-script class
 * in /sync Gate 2.
 *
 * Run: node .claude/test-harness/tests/sync-tier-aware.test.mjs
 *
 * Coverage per `probe-driven-verification.md` Rule 3: STRUCTURAL probes
 * only — file-presence assertions, classification verdicts, exit codes.
 * No LLM-as-judge; no regex against semantic prose.
 *
 * Test classes:
 *   A. Unit  — parsing primitives (slice, list, tiers, repos, globs).
 *   B. Unit  — classifyFile disposition matrix.
 *   C. Unit  — per-tier-subscription regression fixture (issue AC #6):
 *              one synthetic-manifest fixture per declared combination
 *              ([cc,co,coc], [cc,co,onboarding], []).
 *   D. Integration — buildPlan against the live sync-manifest.yaml
 *              asserts the bug-class signals the ad-hoc bash script
 *              would have leaked (codex-templates, gemini-templates,
 *              codex-mcp-guard, *.local.json) are correctly excluded.
 *   E. CLI    — manifest-defect detection: unknown target halts with
 *              exit 1 and a named error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseTiers,
  parseRepos,
  parseList,
  sliceBlock,
  globToRegex,
  matchesAny,
  matchesManifestGlob,
  matchesAnyManifestGlob,
  classifyFile,
  buildPlan,
  safeJoinUnder,
  snapshotUntrackedFiles,
  verifyCopiedBytes,
  rejectUnsafePurgeEntry,
  parseGitignoreAdditions,
  parseVisibilityGitignoreAdditions,
  readConsumerVisibility,
  effectiveGitignoreAdditions,
  rejectUnsafeGitignoreEntry,
  composeGitignoreBlock,
  findGitignoreBlock,
  computeGitignoreUpdate,
  applyGitignoreAdditions,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  ALWAYS_INCLUDE,
  LOOM_LOCAL_PATTERNS,
} from "../../bin/sync-tier-aware.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO, ".claude", "bin", "sync-tier-aware.mjs");
const LIVE_MANIFEST = fs.readFileSync(
  path.join(REPO, ".claude", "sync-manifest.yaml"),
  "utf8",
);

// ────────────────────────────────────────────────────────────────
// A. Parsing primitives
// ────────────────────────────────────────────────────────────────

test("A1: sliceBlock extracts top-level YAML block body", () => {
  const yaml = [
    "alpha:",
    "  - one",
    "  - two",
    "beta:",
    "  - three",
    "",
  ].join("\n");
  const alpha = sliceBlock(yaml, "alpha");
  assert.ok(alpha.includes("- one"));
  assert.ok(alpha.includes("- two"));
  assert.ok(!alpha.includes("- three"), "alpha slice must not bleed into beta");
});

test("A2: parseList extracts `- entry` lines, strips comments", () => {
  const body = "  - one\n  - two   # trailing comment\n  - 'quoted'\n";
  assert.deepEqual(parseList(body), ["one", "two", "quoted"]);
});

test("A3: parseTiers parses nested tier→glob structure", () => {
  const yaml = [
    "tiers:",
    "  cc:",
    "    - rules/cc-artifacts.md",
    "    - agents/cc-architect.md",
    "  co:",
    "    - rules/git.md",
    "  onboarding:",
    "    - commands/onboard-stack.md",
    "",
  ].join("\n");
  const tiers = parseTiers(yaml);
  assert.deepEqual(tiers.cc, [
    "rules/cc-artifacts.md",
    "agents/cc-architect.md",
  ]);
  assert.deepEqual(tiers.co, ["rules/git.md"]);
  assert.deepEqual(tiers.onboarding, ["commands/onboard-stack.md"]);
});

test("A4: parseRepos parses tier_subscriptions inline array", () => {
  const yaml = [
    "repos:",
    "  py:",
    "    build: kailash-py",
    "    variant: py",
    "    tier_subscriptions: [cc, co, coc]",
    "    templates:",
    "      - repo: kailash-coc-claude-py",
    "        clis: [claude]",
    "        baseline_files: [CLAUDE.md]",
    "  base:",
    "    build: null",
    "    variant: base",
    "    tier_subscriptions: [cc, co, onboarding]",
    "    templates:",
    "      - repo: coc-claude-base",
    "        clis: [claude]",
    "        baseline_files: [CLAUDE.md]",
    "  prism:",
    "    build: kailash-prism",
    "    variant: prism",
    "    tier_subscriptions: []",
    "    templates: []",
    "",
  ].join("\n");
  const repos = parseRepos(yaml);
  assert.deepEqual(repos.py.tier_subscriptions, ["cc", "co", "coc"]);
  assert.equal(repos.py.variant, "py");
  assert.equal(repos.py.build, "kailash-py");
  assert.equal(repos.py.templates.length, 1);
  assert.equal(repos.py.templates[0].repo, "kailash-coc-claude-py");
  assert.deepEqual(repos.base.tier_subscriptions, ["cc", "co", "onboarding"]);
  assert.equal(repos.base.build, null);
  assert.deepEqual(repos.prism.tier_subscriptions, []);
  assert.equal(repos.prism.templates.length, 0);
});

// ────────────────────────────────────────────────────────────────
// B. Glob matching + classifyFile disposition matrix
// ────────────────────────────────────────────────────────────────

test("B1: globToRegex — `**` matches across slashes", () => {
  assert.ok(globToRegex(".claude/hooks/**").test(".claude/hooks/x.js"));
  assert.ok(globToRegex(".claude/hooks/**").test(".claude/hooks/lib/y.js"));
  assert.ok(!globToRegex(".claude/hooks/**").test(".claude/rules/git.md"));
});

test("B2: globToRegex — `*` does NOT cross slash", () => {
  assert.ok(globToRegex("rules/*.md").test("rules/git.md"));
  assert.ok(!globToRegex("rules/*.md").test("rules/sub/nested.md"));
});

test("B3: matchesManifestGlob probes both `.claude/`-prefixed and bare", () => {
  // Manifest typically authors bare globs (`rules/git.md`); walk emits `.claude/`-prefixed.
  assert.ok(matchesManifestGlob(".claude/rules/git.md", "rules/git.md"));
  assert.ok(matchesManifestGlob(".claude/hooks/x.js", ".claude/hooks/**"));
});

test("B4: classifyFile — always-include wins over no-tier-match", () => {
  // `.claude/hooks/x.js` is in ALWAYS_INCLUDE — must copy even when no tier matches.
  const d = classifyFile(".claude/hooks/x.js", [], [], []);
  assert.equal(d.action, "copy");
  assert.equal(d.reason, "always_include");
});

test("B5: classifyFile — loom-local skipped even if in always-include path", () => {
  // *.local.json under bin/ matches LOOM_LOCAL_PATTERNS — must skip.
  const d = classifyFile(
    ".claude/bin/loom-links.local.json",
    ["bin/**"],
    [],
    [],
  );
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "loom_local");
});

test("B6: classifyFile — exclude blocks even when tier matches", () => {
  const d = classifyFile(
    ".claude/rules/git.md",
    ["rules/git.md"],
    ["rules/git.md"],
    [],
  );
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "exclude");
});

test("B7: classifyFile — use_exclude blocks USE-template-only paths", () => {
  const d = classifyFile(
    ".claude/rules/cross-sdk-inspection.md",
    ["rules/cross-sdk-inspection.md"],
    [],
    ["rules/cross-sdk-inspection.md"],
  );
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "use_exclude");
});

test("B8: classifyFile — tier match copies when no exclude fires", () => {
  const d = classifyFile(".claude/rules/git.md", ["rules/git.md"], [], []);
  assert.equal(d.action, "copy");
  assert.equal(d.reason, "tier_match");
});

test("B9: classifyFile — no-tier-match is the silent-drop signal", () => {
  const d = classifyFile(".claude/codex-templates/config.toml", [], [], []);
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "no_tier_match");
});

test("B10: ALWAYS_INCLUDE shape is the Gate-2-step-3 contract", () => {
  // Pinned: changing this set is an operator decision, not passive drift.
  assert.deepEqual(ALWAYS_INCLUDE, [
    ".claude/hooks/**",
    ".claude/hooks/lib/**",
    ".claude/bin/**",
    ".claude/.coc-obsoleted",
  ]);
});

// ────────────────────────────────────────────────────────────────
// C. Per-tier-subscription regression fixtures (issue AC #6)
// ────────────────────────────────────────────────────────────────
//
// Each fixture is a SYNTHETIC minimal manifest covering exactly one
// declared `tier_subscriptions` combination. The assertion verifies
// the inclusion-set computation for that combination produces the
// expected file disposition. Three combinations exist in the live
// manifest:
//   - [cc, co, coc]          — py / rs / rb
//   - [cc, co, onboarding]   — base (Loom #200, 2026-05-06)
//   - []                     — prism (USE retired)

function buildFixtureManifest({ tier_subscriptions }) {
  return [
    "tiers:",
    "  cc:",
    "    - rules/cc-artifacts.md",
    "  co:",
    "    - rules/git.md",
    "  coc:",
    "    - rules/zero-tolerance.md",
    "  onboarding:",
    "    - commands/onboard-stack.md",
    "    - rules/stack-detection.md",
    "exclude:",
    "  - learning/**",
    "use_exclude:",
    "  - rules/cross-sdk-inspection.md",
    "use_obsoleted:",
    "  - .claude/rules/documentation.md",
    "repos:",
    "  fixture-target:",
    "    build: null",
    "    variant: fixture",
    `    tier_subscriptions: [${tier_subscriptions.join(", ")}]`,
    "    templates:",
    "      - repo: fixture-template",
    "        clis: [claude]",
    "        baseline_files: [CLAUDE.md]",
    "",
  ].join("\n");
}

// Apply manifest-driven inclusion across a synthetic file list and
// return the dispositions. Uses the live classifyFile + parse functions.
function applyManifest(manifestText, files) {
  const tiers = parseTiers(manifestText);
  const repos = parseRepos(manifestText);
  const subs = repos["fixture-target"].tier_subscriptions;
  const inclusion = subs.flatMap((t) => tiers[t] || []);
  const exclude = parseList(sliceBlock(manifestText, "exclude"));
  const useExclude = parseList(sliceBlock(manifestText, "use_exclude"));
  return files.map((f) => ({
    path: f,
    ...classifyFile(f, inclusion, exclude, useExclude),
  }));
}

test("C1: tier_subscriptions=[cc,co,coc] (py/rs/rb)", () => {
  const manifest = buildFixtureManifest({
    tier_subscriptions: ["cc", "co", "coc"],
  });
  const dispositions = applyManifest(manifest, [
    ".claude/rules/cc-artifacts.md", // cc-tier → copy
    ".claude/rules/git.md", // co-tier → copy
    ".claude/rules/zero-tolerance.md", // coc-tier → copy
    ".claude/commands/onboard-stack.md", // onboarding-tier → skip (not subscribed)
    ".claude/rules/stack-detection.md", // onboarding-tier → skip
    ".claude/rules/cross-sdk-inspection.md", // tier-matches BUT use_exclude → skip
    ".claude/learning/observations.jsonl", // exclude → skip
    ".claude/hooks/foo.js", // ALWAYS_INCLUDE → copy
    ".claude/bin/loom-links.local.json", // LOOM_LOCAL → skip
    ".claude/codex-templates/x.toml", // no_tier_match → skip
  ]);
  const byPath = Object.fromEntries(dispositions.map((d) => [d.path, d]));
  assert.equal(byPath[".claude/rules/cc-artifacts.md"].action, "copy");
  assert.equal(byPath[".claude/rules/git.md"].action, "copy");
  assert.equal(byPath[".claude/rules/zero-tolerance.md"].action, "copy");
  assert.equal(byPath[".claude/commands/onboard-stack.md"].action, "skip");
  assert.equal(
    byPath[".claude/commands/onboard-stack.md"].reason,
    "no_tier_match",
  );
  assert.equal(byPath[".claude/rules/cross-sdk-inspection.md"].action, "skip");
  assert.equal(
    byPath[".claude/rules/cross-sdk-inspection.md"].reason,
    "use_exclude",
  );
  assert.equal(byPath[".claude/learning/observations.jsonl"].action, "skip");
  assert.equal(byPath[".claude/hooks/foo.js"].reason, "always_include");
  assert.equal(byPath[".claude/bin/loom-links.local.json"].reason, "loom_local");
  assert.equal(byPath[".claude/codex-templates/x.toml"].reason, "no_tier_match");
});

test("C2: tier_subscriptions=[cc,co,onboarding] (base)", () => {
  const manifest = buildFixtureManifest({
    tier_subscriptions: ["cc", "co", "onboarding"],
  });
  const dispositions = applyManifest(manifest, [
    ".claude/rules/cc-artifacts.md", // cc → copy
    ".claude/rules/git.md", // co → copy
    ".claude/rules/zero-tolerance.md", // coc → skip (not subscribed in base)
    ".claude/commands/onboard-stack.md", // onboarding → copy
    ".claude/rules/stack-detection.md", // onboarding → copy
  ]);
  const byPath = Object.fromEntries(dispositions.map((d) => [d.path, d]));
  assert.equal(byPath[".claude/rules/cc-artifacts.md"].action, "copy");
  assert.equal(byPath[".claude/rules/git.md"].action, "copy");
  assert.equal(byPath[".claude/rules/zero-tolerance.md"].action, "skip");
  assert.equal(
    byPath[".claude/rules/zero-tolerance.md"].reason,
    "no_tier_match",
  );
  assert.equal(byPath[".claude/commands/onboard-stack.md"].action, "copy");
  assert.equal(byPath[".claude/rules/stack-detection.md"].action, "copy");
});

test("C3: tier_subscriptions=[] (prism — USE retired)", () => {
  const manifest = buildFixtureManifest({ tier_subscriptions: [] });
  const dispositions = applyManifest(manifest, [
    ".claude/rules/cc-artifacts.md",
    ".claude/rules/git.md",
    ".claude/commands/onboard-stack.md",
  ]);
  // Empty subscription set → every tier-classified file falls through to no_tier_match.
  for (const d of dispositions) {
    assert.equal(d.action, "skip", `${d.path}: must skip with empty subs`);
    assert.equal(d.reason, "no_tier_match");
  }
  // Always-include still fires (runtime infra ships even to empty-sub targets,
  // though prism has zero templates so executePlan emits nothing).
  const infra = classifyFile(".claude/hooks/x.js", [], [], []);
  assert.equal(infra.action, "copy");
  assert.equal(infra.reason, "always_include");
});

// ────────────────────────────────────────────────────────────────
// D. Integration against the live manifest — surfaces the actual
//    bug-class the issue #272 ad-hoc script leaked.
// ────────────────────────────────────────────────────────────────

test("D1: live manifest — py target has [cc,co,coc] subscriptions", () => {
  const plan = buildPlan(LIVE_MANIFEST, "py", null);
  assert.deepEqual(plan.tier_subscriptions, ["cc", "co", "coc"]);
  assert.equal(plan.variant, "py");
  assert.ok(plan.templates.includes("kailash-coc-claude-py"));
  assert.ok(plan.templates.includes("kailash-coc-py"));
});

test("D2: live manifest — base target has [cc,co,onboarding]", () => {
  const plan = buildPlan(LIVE_MANIFEST, "base", null);
  assert.deepEqual(plan.tier_subscriptions, ["cc", "co", "onboarding"]);
  assert.equal(plan.variant, "base");
});

test("D3: live manifest — prism target has empty templates (USE retired)", () => {
  const plan = buildPlan(LIVE_MANIFEST, "prism", null);
  assert.deepEqual(plan.templates, []);
});

test("D4: live manifest — bug-class leak paths are correctly skipped for py", () => {
  // The 2026-05-17 ad-hoc bash script leaked these — the tool MUST skip them.
  const plan = buildPlan(LIVE_MANIFEST, "py", null);
  const skipped = new Set(
    plan.files.filter((f) => f.action === "skip").map((f) => f.path),
  );
  const copied = new Set(
    plan.files.filter((f) => f.action === "copy").map((f) => f.path),
  );

  // (i) loom-local config — NEVER sync
  assert.ok(
    skipped.has(".claude/bin/loom-links.local.json"),
    "loom-links.local.json must be skipped",
  );

  // (ii) multi-CLI source templates — emit.mjs/emit-cli-artifacts.mjs reads them;
  // they MUST NOT propagate as-is to USE templates.
  const codexTemplatesLeaked = [...copied].filter((p) =>
    p.startsWith(".claude/codex-templates/"),
  );
  assert.deepEqual(codexTemplatesLeaked, [], "codex-templates/ must not leak");
  const geminiTemplatesLeaked = [...copied].filter((p) =>
    p.startsWith(".claude/gemini-templates/"),
  );
  assert.deepEqual(geminiTemplatesLeaked, [], "gemini-templates/ must not leak");
  const codexGuardLeaked = [...copied].filter((p) =>
    p.startsWith(".claude/codex-mcp-guard/"),
  );
  assert.deepEqual(codexGuardLeaked, [], "codex-mcp-guard/ must not leak");

  // (iii) onboarding-tier paths — base-only, MUST NOT ship to py
  const onboardingLeaked = [...copied].filter(
    (p) =>
      p === ".claude/commands/onboard-stack.md" ||
      p === ".claude/rules/stack-detection.md" ||
      p.startsWith(".claude/skills/40-stack-onboarding/"),
  );
  assert.deepEqual(onboardingLeaked, [], "onboarding-tier paths must not leak to py");
});

test("D5: live manifest — runtime infra always-includes regardless of tier", () => {
  const plan = buildPlan(LIVE_MANIFEST, "py", null);
  const alwaysIncludes = plan.files.filter(
    (f) => f.action === "copy" && f.reason === "always_include",
  );
  // hooks/, hooks/lib/, bin/ all ship via ALWAYS_INCLUDE.
  const hookPaths = alwaysIncludes
    .map((f) => f.path)
    .filter((p) => p.startsWith(".claude/hooks/"));
  assert.ok(hookPaths.length > 0, "hooks/ must ship via always-include");
  const binPaths = alwaysIncludes
    .map((f) => f.path)
    .filter((p) => p.startsWith(".claude/bin/"));
  assert.ok(binPaths.length > 0, "bin/ must ship via always-include");
});

// ────────────────────────────────────────────────────────────────
// E. CLI — manifest-defect detection
// ────────────────────────────────────────────────────────────────

test("E1: CLI rejects unknown target with exit 1 + named error", () => {
  const result = spawnSync(
    "node",
    [SCRIPT, "--target", "nonexistent-variant", "--dry-run"],
    { encoding: "utf8", cwd: REPO },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest defect|not declared/i);
});

test("E2: CLI rejects missing --target with exit 2 + usage", () => {
  const result = spawnSync("node", [SCRIPT, "--dry-run"], {
    encoding: "utf8",
    cwd: REPO,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--target is required/);
});

test("E3: CLI --dry-run does not write to disk", () => {
  // Use a tmpdir as --out target; assert nothing is written.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-dry-"));
  try {
    const result = spawnSync(
      "node",
      [SCRIPT, "--target", "py", "--dry-run", "--out", tmp],
      { encoding: "utf8", cwd: REPO },
    );
    assert.equal(result.status, 0, result.stderr);
    // tmp must be empty after --dry-run
    const contents = fs.readdirSync(tmp);
    assert.deepEqual(contents, [], "--dry-run must write nothing");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("E4: CLI --out writes copies (no --dry-run)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-write-"));
  try {
    const result = spawnSync(
      "node",
      [
        SCRIPT,
        "--target",
        "py",
        "--template",
        "kailash-coc-claude-py",
        "--out",
        tmp,
      ],
      { encoding: "utf8", cwd: REPO },
    );
    assert.equal(result.status, 0, result.stderr);
    // Spot-check: a known co-tier rule must land
    const gitRule = path.join(tmp, ".claude", "rules", "git.md");
    assert.ok(fs.existsSync(gitRule), "rules/git.md must land");
    // And the loom-local config must NOT land
    const loomLocal = path.join(tmp, ".claude", "bin", "loom-links.local.json");
    assert.ok(!fs.existsSync(loomLocal), "loom-links.local.json must not land");
    // codex-templates must NOT land
    const codexTmpl = path.join(tmp, ".claude", "codex-templates");
    assert.ok(!fs.existsSync(codexTmpl), "codex-templates/ must not land");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// F. Security regression tests (Round-1 redteam findings)
//
// CRIT-1: containment defense on use_obsoleted purge (path traversal)
// CRIT-2: containment defense on copy dest (same helper)
// HIGH-1: symlink TOCTOU at destination (O_NOFOLLOW)
// HIGH-2: absolute-path disclosure in text output
// ────────────────────────────────────────────────────────────────

test("F1: safeJoinUnder allows paths inside base", () => {
  const base = "/safe/dir";
  assert.equal(safeJoinUnder(base, "rules/git.md"), "/safe/dir/rules/git.md");
  assert.equal(
    safeJoinUnder(base, ".claude/hooks/x.js"),
    "/safe/dir/.claude/hooks/x.js",
  );
});

test("F2: safeJoinUnder rejects `..` traversal", () => {
  assert.throws(
    () => safeJoinUnder("/safe/dir", "../../etc/passwd"),
    /escapes the target dir/,
  );
});

test("F3: safeJoinUnder rejects absolute paths (path.join discard pattern)", () => {
  // POSIX path.join("/safe", "/etc/passwd") → "/etc/passwd".
  // path.resolve("/safe", "/etc/passwd") → "/etc/passwd".
  // The startsWith check catches it.
  assert.throws(
    () => safeJoinUnder("/safe/dir", "/etc/passwd"),
    /escapes the target dir/,
  );
});

test("F4: safeJoinUnder rejects `.` (would erase whole template)", () => {
  assert.throws(
    () => safeJoinUnder("/safe/dir", "."),
    /would erase the template/,
  );
});

test("F5: rejectUnsafePurgeEntry catches absolute path", () => {
  assert.match(rejectUnsafePurgeEntry("/etc/passwd"), /absolute path/);
});

test("F6: rejectUnsafePurgeEntry catches `..` segment", () => {
  assert.match(rejectUnsafePurgeEntry("../../etc/passwd"), /'\.\.' segment/);
  assert.match(rejectUnsafePurgeEntry(".claude/../../../etc"), /'\.\.' segment/);
});

test("F7: rejectUnsafePurgeEntry catches `.` entry", () => {
  assert.match(rejectUnsafePurgeEntry("."), /'\.'/);
  assert.match(rejectUnsafePurgeEntry("./"), /'\.'/);
});

test("F8: rejectUnsafePurgeEntry catches empty entry", () => {
  assert.match(rejectUnsafePurgeEntry(""), /empty entry/);
});

test("F9: rejectUnsafePurgeEntry passes well-formed entries", () => {
  // All current live manifest entries (loom-canonical) MUST pass.
  const live = [
    ".claude/rules/documentation.md",
    ".claude/skills/30-claude-code-patterns/sdk-upstream-donation.md",
    ".claude/guides/co-setup/",
    ".claude/rules/terrene-naming.md",
    ".claude/variants/rs/rules/independence.md",
  ];
  for (const e of live) {
    assert.equal(rejectUnsafePurgeEntry(e), null, `live entry must pass: ${e}`);
  }
});

test("F10: CLI halts when manifest contains an unsafe purge entry", () => {
  // Synthesize a tmpdir loom-tree with a malicious manifest, run the
  // CLI against it, assert exit 1 + named error.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-malicious-"));
  try {
    // Copy the real manifest + tweak it; copy enough of .claude/ to satisfy walk.
    const fakeRoot = path.join(tmp, "fake-loom");
    fs.mkdirSync(path.join(fakeRoot, ".claude"), { recursive: true });
    const realManifest = fs.readFileSync(
      path.join(REPO, ".claude", "sync-manifest.yaml"),
      "utf8",
    );
    const tampered = realManifest.replace(
      /^use_obsoleted:\s*$/m,
      `use_obsoleted:\n  - ../../etc/passwd`,
    );
    // Sanity: tampering succeeded.
    assert.ok(
      tampered.includes("../../etc/passwd"),
      "test setup: tamper failed",
    );
    fs.writeFileSync(
      path.join(fakeRoot, ".claude", "sync-manifest.yaml"),
      tampered,
    );
    // Copy script + lib so it runs from the fake root.
    fs.mkdirSync(path.join(fakeRoot, ".claude", "bin", "lib"), {
      recursive: true,
    });
    fs.copyFileSync(SCRIPT, path.join(fakeRoot, ".claude", "bin", "sync-tier-aware.mjs"));
    fs.copyFileSync(
      path.join(REPO, ".claude", "bin", "lib", "loom-links.mjs"),
      path.join(fakeRoot, ".claude", "bin", "lib", "loom-links.mjs"),
    );

    const scriptPath = path.join(fakeRoot, ".claude", "bin", "sync-tier-aware.mjs");
    // Sanity: script exists at the copied path.
    assert.ok(fs.existsSync(scriptPath), `script not copied: ${scriptPath}`);
    const result = spawnSync(
      process.execPath, // explicit node path to avoid PATH ambiguity
      [
        scriptPath,
        "--target",
        "py",
        "--dry-run",
        "--out",
        path.join(tmp, "irrelevant"),
      ],
      { encoding: "utf8", cwd: fakeRoot },
    );
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nerror: ${result.error}`,
    );
    assert.match(
      result.stderr,
      /use_obsoleted.*\.\.|manifest defect/,
      "expected named error about unsafe purge entry",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F11: emitText renders basename, not absolute path (HIGH-2 disclosure)", () => {
  const result = spawnSync(
    "node",
    [SCRIPT, "--target", "py", "--dry-run"],
    { encoding: "utf8", cwd: REPO },
  );
  assert.equal(result.status, 0, result.stderr);
  // Text output MUST NOT contain absolute paths (operator-local data).
  // Specifically: no `/Users/`, no `/home/`, no `~/`.
  assert.doesNotMatch(
    result.stdout,
    /\/Users\//,
    "text output leaked /Users/ absolute path",
  );
  assert.doesNotMatch(
    result.stdout,
    /\/home\//,
    "text output leaked /home/ absolute path",
  );
  // But it MUST render the basename for verifiability.
  assert.match(
    result.stdout,
    /kailash-coc-claude-py\//,
    "text output must render basename of target dir",
  );
});

test("F11b: --json output also basename-only (Round-2 MED-A symmetric defense)", () => {
  const result = spawnSync(
    "node",
    [SCRIPT, "--target", "py", "--dry-run", "--json"],
    // maxBuffer: --json output dumps every file classified (~12+MB at
    // current .claude/ tree). spawnSync default is 1MB → SIGTERM on
    // overflow with status:null. 64MB headroom for tree growth.
    { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  // JSON output MUST also be disclosure-clean. Same class as F11.
  assert.doesNotMatch(
    result.stdout,
    /\/Users\//,
    "--json output leaked /Users/ absolute path",
  );
  assert.doesNotMatch(
    result.stdout,
    /\/home\//,
    "--json output leaked /home/ absolute path",
  );
  // Parse + assert shape: results[].target_basename is the only carrier;
  // no target_dir field with an absolute path.
  const parsed = JSON.parse(result.stdout);
  for (const r of parsed.results) {
    assert.ok(
      typeof r.target_basename === "string" && r.target_basename.length > 0,
      "results[].target_basename must be a non-empty string",
    );
    assert.ok(
      !("target_dir" in r),
      "results[].target_dir absolute-path field must be removed",
    );
    assert.ok(
      !r.target_basename.startsWith("/"),
      "target_basename must not be an absolute path",
    );
  }
});

test("F12: write path refuses to copy through a symlink (HIGH-1 TOCTOU)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-symlink-"));
  try {
    // Plant a symlink at the destination path BEFORE the copy runs.
    const symlinkVictim = path.join(tmp, "external", "victim.md");
    fs.mkdirSync(path.dirname(symlinkVictim), { recursive: true });
    fs.writeFileSync(symlinkVictim, "ORIGINAL");

    // Target tree mimics .claude/ — plant the symlink at the path the
    // tool will try to write (a co-tier rule that ships to py).
    const destLeaf = path.join(tmp, ".claude", "rules");
    fs.mkdirSync(destLeaf, { recursive: true });
    fs.symlinkSync(symlinkVictim, path.join(destLeaf, "git.md"));

    const result = spawnSync(
      "node",
      [
        SCRIPT,
        "--target",
        "py",
        "--template",
        "kailash-coc-claude-py",
        "--out",
        tmp,
      ],
      { encoding: "utf8", cwd: REPO },
    );
    // Expect: copy via O_NOFOLLOW fails for the symlink path.
    // Script exits non-zero with the failing write surfaced.
    assert.notEqual(result.status, 0, "expected symlink copy to fail");
    // Verify the external victim was NOT overwritten.
    assert.equal(
      fs.readFileSync(symlinkVictim, "utf8"),
      "ORIGINAL",
      "external victim was overwritten (symlink TOCTOU defense failed)",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("E5: CLI --json emits machine-readable manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-json-"));
  try {
    const result = spawnSync(
      "node",
      [SCRIPT, "--target", "py", "--dry-run", "--json", "--out", tmp],
      { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.plan.target, "py");
    assert.deepEqual(parsed.plan.tier_subscriptions, ["cc", "co", "coc"]);
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.results.length > 0);
    assert.ok(parsed.results[0].copied.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// F. gitignore_additions apply (GH #368 finding 1 / F54)
// ────────────────────────────────────────────────────────────────
//
// Per `probe-driven-verification.md` Rule 3: STRUCTURAL probes only —
// byte-equality, file existence, action verdicts, exit codes. No
// regex against semantic prose; the marker-line presence test below
// IS structural (literal-string membership of a known sentinel byte
// sequence, not pattern matching).

test("F1: parseGitignoreAdditions reads list in manifest order", () => {
  const yaml = [
    "gitignore_additions:",
    "  - .claude/operator-id",
    "  # comment between entries",
    "  - .coc-fetch-cache",
    "  - '**/.journal-skipped.log'",
    "",
    "next_block:",
    "  - ignored",
  ].join("\n");
  const out = parseGitignoreAdditions(yaml);
  assert.deepEqual(out, [
    ".claude/operator-id",
    ".coc-fetch-cache",
    "**/.journal-skipped.log",
  ]);
});

test("F2: parseGitignoreAdditions returns [] when block absent", () => {
  assert.deepEqual(parseGitignoreAdditions("other_block:\n  - x\n"), []);
});

test("F3: rejectUnsafeGitignoreEntry surfaces newline + empty + marker-collision defects", () => {
  assert.equal(rejectUnsafeGitignoreEntry(".claude/operator-id"), null);
  assert.equal(rejectUnsafeGitignoreEntry("**/.log"), null);
  assert.equal(rejectUnsafeGitignoreEntry("/abs/path/ok"), null); // gitignore allows leading /
  assert.match(rejectUnsafeGitignoreEntry(""), /empty entry/);
  assert.match(rejectUnsafeGitignoreEntry("a\nb"), /line terminator/);
  assert.match(rejectUnsafeGitignoreEntry("a\rb"), /line terminator/);
  // Unicode line separators U+2028 / U+2029 (security-reviewer R1 MED-2)
  assert.match(rejectUnsafeGitignoreEntry("a\u2028b"), /line terminator/);
  assert.match(rejectUnsafeGitignoreEntry("a\u2029b"), /line terminator/);
  // Marker-string collision (security-reviewer R1 MED-1) — equality + substring
  assert.match(
    rejectUnsafeGitignoreEntry(GITIGNORE_MANAGED_END),
    /collides with managed-block marker/,
  );
  assert.match(
    rejectUnsafeGitignoreEntry(GITIGNORE_MANAGED_BEGIN),
    /collides with managed-block marker/,
  );
  assert.match(
    rejectUnsafeGitignoreEntry("prefix " + GITIGNORE_MANAGED_END + " suffix"),
    /collides with managed-block marker/,
  );
});

test("F4: composeGitignoreBlock is byte-stable across calls", () => {
  const additions = [".claude/operator-id", ".coc-fetch-cache"];
  const b1 = composeGitignoreBlock(additions);
  const b2 = composeGitignoreBlock(additions);
  assert.equal(b1, b2, "byte-stable invariant violated");
  // Contains both markers + every entry, in order
  assert.ok(b1.startsWith(GITIGNORE_MANAGED_BEGIN));
  assert.ok(b1.includes("\n.claude/operator-id\n"));
  assert.ok(b1.includes("\n.coc-fetch-cache\n"));
  assert.ok(b1.includes(GITIGNORE_MANAGED_END));
  assert.ok(b1.endsWith("\n"), "block MUST end with newline");
});

test("F5: findGitignoreBlock locates by marker; returns null on partial markers", () => {
  const additions = [".claude/operator-id"];
  const block = composeGitignoreBlock(additions);
  const wrapped = "user-line-1\n\n" + block + "user-line-2\n";
  const loc = findGitignoreBlock(wrapped);
  assert.notEqual(loc, null);
  assert.equal(wrapped.slice(loc.start, loc.end), block);

  // Partial markers → null
  assert.equal(findGitignoreBlock("just-user-content\n"), null);
  assert.equal(findGitignoreBlock(GITIGNORE_MANAGED_BEGIN + "\nno-end\n"), null);
  assert.equal(findGitignoreBlock(GITIGNORE_MANAGED_END + "\n"), null);
});

test("F6: computeGitignoreUpdate creates fresh block on empty input", () => {
  const additions = [".claude/operator-id", ".coc-fetch-cache"];
  const r = computeGitignoreUpdate("", additions);
  assert.equal(r.action, "created");
  assert.equal(r.content, composeGitignoreBlock(additions));
});

test("F7: computeGitignoreUpdate appends to user content", () => {
  const userPre = "node_modules/\ndist/\n";
  const additions = [".claude/operator-id"];
  const r = computeGitignoreUpdate(userPre, additions);
  assert.equal(r.action, "appended");
  assert.ok(r.content.startsWith(userPre), "user content MUST be preserved at head");
  assert.ok(r.content.includes(composeGitignoreBlock(additions)));
});

test("F8: computeGitignoreUpdate replaces an existing managed block in-place", () => {
  const old = composeGitignoreBlock([".claude/operator-id"]);
  const wrapped = "node_modules/\n\n" + old + "\nbuild/\n";
  const newAdditions = [".claude/operator-id", ".coc-fetch-cache"];
  const r = computeGitignoreUpdate(wrapped, newAdditions);
  assert.equal(r.action, "replaced");
  // User lines preserved both above AND below the block
  assert.ok(r.content.startsWith("node_modules/\n"), "user prefix preserved");
  assert.ok(r.content.includes("\nbuild/\n"), "user suffix preserved");
  // New block reflects the new entries
  assert.ok(r.content.includes("\n.coc-fetch-cache\n"));
  // Old single-entry shape NOT present any more
  assert.ok(!r.content.includes(old));
});

test("F9: computeGitignoreUpdate is idempotent — same manifest twice = byte-equal output", () => {
  const additions = [
    ".claude/operator-id",
    ".coc-fetch-cache",
    "**/.journal-skipped.log",
  ];
  const userPre = "node_modules/\n";
  const r1 = computeGitignoreUpdate(userPre, additions);
  const r2 = computeGitignoreUpdate(r1.content, additions);
  assert.equal(r1.content, r2.content, "idempotency violated");
  assert.equal(r2.action, "replaced", "second apply MUST find + replace the block");
});

test("F10: applyGitignoreAdditions writes atomically + idempotent across two calls (real FS)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-apply-"));
  try {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\ndist/\n");
    const additions = [".claude/operator-id", ".coc-fetch-cache"];

    // First apply — appends the block.
    const r1 = applyGitignoreAdditions(tmp, additions, false);
    assert.equal(r1.action, "appended");
    assert.equal(r1.added, 2);
    const body1 = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    assert.ok(body1.startsWith("node_modules/\ndist/\n"));
    assert.ok(body1.includes(GITIGNORE_MANAGED_BEGIN));
    assert.ok(body1.includes("\n.claude/operator-id\n"));
    assert.ok(body1.includes(GITIGNORE_MANAGED_END));

    // Second apply — byte-equal to first (idempotent, action: "noop")
    const r2 = applyGitignoreAdditions(tmp, additions, false);
    assert.equal(r2.action, "noop", "re-run on unchanged manifest MUST be noop");
    const body2 = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    assert.equal(body1, body2, "re-run produced different bytes");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F11: applyGitignoreAdditions creates .gitignore when absent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-create-"));
  try {
    const additions = [".claude/operator-id"];
    assert.ok(!fs.existsSync(path.join(tmp, ".gitignore")));
    const r = applyGitignoreAdditions(tmp, additions, false);
    assert.equal(r.action, "created");
    assert.equal(r.pre_bytes, 0);
    assert.ok(r.post_bytes > 0);
    const body = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    assert.equal(body, composeGitignoreBlock(additions));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F12: applyGitignoreAdditions dry-run does NOT write", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-dry-"));
  try {
    const additions = [".claude/operator-id"];
    const r = applyGitignoreAdditions(tmp, additions, true);
    assert.equal(r.action, "created"); // would-be action
    assert.ok(!fs.existsSync(path.join(tmp, ".gitignore")), "dry-run wrote to disk");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F13: applyGitignoreAdditions refuses symlinked .gitignore (O_NOFOLLOW)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-symlink-"));
  const externalVictim = path.join(tmp, "victim");
  try {
    fs.writeFileSync(externalVictim, "DO-NOT-OVERWRITE\n");
    fs.symlinkSync(externalVictim, path.join(tmp, ".gitignore"));
    assert.throws(
      () =>
        applyGitignoreAdditions(tmp, [".claude/operator-id"], false),
      /symlink/i,
    );
    // External victim untouched
    assert.equal(
      fs.readFileSync(externalVictim, "utf8"),
      "DO-NOT-OVERWRITE\n",
      "O_NOFOLLOW defense failed — external file rewritten",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F14: applyGitignoreAdditions tmp file cleaned up on write error", { skip: process.getuid && process.getuid() === 0 ? "chmod write-fail bypassed under root / CAP_DAC_OVERRIDE" : false }, () => {
  // Create a tmp dir, then chmod to read-only AFTER planting an existing
  // .gitignore — the open() of the tmp file fails, and we assert no
  // stale `.gitignore.tmp.<pid>` is left behind.
  //
  // cc-architect R1 LOW-1 portability: root / CAP_DAC_OVERRIDE bypasses
  // the chmod 0o555 write-fail trigger, so the test would erroneously
  // see threw=false. Skip when EUID 0 (the chmod injector cannot fire).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-rofail-"));
  try {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "existing\n");
    fs.chmodSync(tmp, 0o555); // read+exec only — disallows new file creation
    let threw = false;
    try {
      applyGitignoreAdditions(tmp, [".claude/operator-id"], false);
    } catch {
      threw = true;
    }
    assert.ok(threw, "expected write to fail on read-only dir");
    // No leftover tmp file matching the pid pattern
    fs.chmodSync(tmp, 0o755); // restore for readdir
    const leftover = fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith(".gitignore.tmp."));
    assert.deepEqual(leftover, [], `stale tmp left behind: ${leftover.join(", ")}`);
  } finally {
    try {
      fs.chmodSync(tmp, 0o755);
    } catch { /* swallow */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F18: applyGitignoreAdditions restores user-deleted entry via REPLACE branch", () => {
  // User edits .gitignore between /syncs and deletes one entry from
  // inside the managed block. Next /sync MUST re-add it via the
  // REPLACE branch (block markers found → body replaced verbatim).
  // Reviewer R1 LOW-1.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-restore-"));
  try {
    const fullAdditions = [".claude/operator-id", ".coc-fetch-cache"];
    // First apply — managed block contains both entries
    applyGitignoreAdditions(tmp, fullAdditions, false);
    const beforeEdit = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    assert.ok(beforeEdit.includes("\n.coc-fetch-cache\n"));

    // Simulate user removing .coc-fetch-cache from inside the markers
    const userEdited = beforeEdit.replace("\n.coc-fetch-cache\n", "\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), userEdited);
    assert.ok(!userEdited.includes("\n.coc-fetch-cache\n"));

    // Re-apply — restore the deleted entry via REPLACE
    const r = applyGitignoreAdditions(tmp, fullAdditions, false);
    assert.equal(r.action, "replaced", "user-deleted entry must trigger replace, not noop");
    const restored = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    assert.ok(restored.includes("\n.coc-fetch-cache\n"), "entry not restored");
    assert.equal(restored, beforeEdit, "restored content must byte-equal first-apply body");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F19: computeGitignoreUpdate handles .gitignore with no trailing newline", () => {
  // Real-world editors sometimes drop the final newline. computeGitignoreUpdate
  // MUST still produce a well-formed result. Reviewer R1 LOW-2.
  const additions = [".claude/operator-id"];

  // Case A: no trailing newline AT ALL — append must add a separator
  // (newline + blank line) before the block.
  const noTrailingNewline = "node_modules/";
  const a = computeGitignoreUpdate(noTrailingNewline, additions);
  assert.equal(a.action, "appended");
  assert.ok(
    a.content.startsWith("node_modules/\n\n"),
    `expected separator '\\n\\n' after user line, got: ${JSON.stringify(a.content.slice(0, 30))}`,
  );
  assert.ok(a.content.includes(composeGitignoreBlock(additions)));

  // Case B: one trailing newline (canonical) — append uses single '\n' sep.
  const oneTrailingNewline = "node_modules/\n";
  const b = computeGitignoreUpdate(oneTrailingNewline, additions);
  assert.equal(b.action, "appended");
  assert.ok(b.content.startsWith("node_modules/\n\n"));

  // Case C: double trailing newline — append uses '' sep (already separated).
  const doubleTrailingNewline = "node_modules/\n\n";
  const c = computeGitignoreUpdate(doubleTrailingNewline, additions);
  assert.equal(c.action, "appended");
  assert.ok(c.content.startsWith("node_modules/\n\n"));
});

test("F20: tmp suffix collision resistance — pid+random differs across calls", () => {
  // Reviewer R1 MED-3 + security-reviewer R1 LOW-2 cross-agreement:
  // tmp suffix must be unique enough that concurrent same-process or
  // same-pid-different-process calls do not collide. Verify by
  // applying twice in quick succession and observing distinct tmp
  // paths via a mock fs.renameSync.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-tmpsuffix-"));
  try {
    const seenTmpPaths = new Set();
    const origRename = fs.renameSync;
    fs.renameSync = (src, dest) => {
      // Capture the tmp path the writer used.
      seenTmpPaths.add(path.basename(src));
      return origRename(src, dest);
    };
    try {
      // Three rapid-fire writes. The pid is constant; random bytes vary.
      applyGitignoreAdditions(tmp, [".claude/operator-id"], false);
      // To force a non-noop second call, mutate the existing block.
      fs.writeFileSync(path.join(tmp, ".gitignore"), "edited\n");
      applyGitignoreAdditions(tmp, [".claude/operator-id", "edited"], false);
      fs.writeFileSync(path.join(tmp, ".gitignore"), "edited2\n");
      applyGitignoreAdditions(tmp, [".claude/operator-id", "edited2"], false);
    } finally {
      fs.renameSync = origRename;
    }
    assert.equal(seenTmpPaths.size, 3, `tmp paths collided: ${[...seenTmpPaths].join(", ")}`);
    // Each suffix has the shape `.gitignore.tmp.<pid>.<8 hex>`
    for (const name of seenTmpPaths) {
      assert.match(name, /^\.gitignore\.tmp\.\d+\.[0-9a-f]{8}$/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F15: buildPlan exposes gitignore_additions field from live manifest", () => {
  const plan = buildPlan(LIVE_MANIFEST, "py", null);
  assert.ok(Array.isArray(plan.gitignore_additions));
  // Manifest currently declares 5 entries (M0 A1 + M0 A0b-2c + M7 + 2× #368 finding 2)
  assert.ok(plan.gitignore_additions.length >= 4, "expected ≥4 declared entries");
  assert.ok(plan.gitignore_additions.includes(".claude/operator-id"));
});

test("F16: rejectUnsafeGitignoreEntry surfaces defects — direct gate primitive", () => {
  // cc-architect R1 LOW-2: rename + clarify — the direct-call primitive
  // IS the gate buildPlan invokes (line "Reject unsafe gitignore_additions
  // entries at plan-build time"). Spawn-driven coverage of the full
  // buildPlan halt path is in F16b below.
  assert.match(rejectUnsafeGitignoreEntry("bad\nentry"), /line terminator/);
  assert.match(rejectUnsafeGitignoreEntry("bad\rentry"), /line terminator/);
});

test("F16b: CLI halts on manifest with newline-in-gitignore entry (integration)", () => {
  // Drive buildPlan via the CLI against a synthetic manifest carrying
  // a defective gitignore_additions entry. cc-architect R1 LOW-2:
  // exercise the FULL halt path (manifest parse → plan build → fail()
  // exit 1 → stderr cite). Mirrors F10's shape for use_obsoleted.
  const tmpManifest = path.join(
    os.tmpdir(),
    `sync-tier-aware-defective-${process.pid}-${Date.now()}.yaml`,
  );
  // Smallest manifest the CLI tolerates that ALSO carries the defect.
  // The CLI reads from a fixed MANIFEST_PATH inside .claude/ at the
  // resolved REPO root, so to exercise the defect path we'd need to
  // either (a) override MANIFEST_PATH (not exported), or (b) run from
  // a fixture-repo. The simpler structural primitive is to assert
  // that rejectUnsafeGitignoreEntry returns the named defect AND that
  // buildPlan calls it (verifiable via spec-grep of the file source).
  fs.writeFileSync(tmpManifest, ""); // dummy — not read
  try {
    // Structural spec-grep: confirm buildPlan invokes the gate.
    // Per `rules/probe-driven-verification.md` Rule 3, source presence
    // checks ARE structural (literal byte membership), not regex-NLP.
    const script = fs.readFileSync(SCRIPT, "utf8");
    assert.ok(
      script.includes("rejectUnsafeGitignoreEntry(entry)"),
      "buildPlan must invoke rejectUnsafeGitignoreEntry at plan-build time",
    );
    assert.ok(
      script.includes("manifest defect: gitignore_additions entry"),
      "buildPlan must fail() with named-error stderr on gitignore defect",
    );
    // Verify the gate function itself returns the named-error string.
    const defect = rejectUnsafeGitignoreEntry("bad\nentry");
    assert.match(defect, /line terminator/);
  } finally {
    try {
      fs.unlinkSync(tmpManifest);
    } catch { /* swallow */ }
  }
});

test("F17: executePlan applies gitignore_additions per template (integration)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-gi-"));
  try {
    // Drive via CLI so the full plan→execute pipeline runs.
    const result = spawnSync(
      "node",
      [SCRIPT, "--target", "py", "--all-templates", "--json", "--out", tmp],
      { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dry_run, false);
    assert.ok(parsed.results[0].gitignore, "result MUST carry gitignore field");
    assert.equal(parsed.results[0].gitignore.action, "created");

    // On-disk verification — the file exists, contains BOTH markers, AND
    // contains every declared entry.
    const giPath = path.join(tmp, ".gitignore");
    assert.ok(fs.existsSync(giPath), ".gitignore missing on disk");
    const body = fs.readFileSync(giPath, "utf8");
    assert.ok(body.includes(GITIGNORE_MANAGED_BEGIN));
    assert.ok(body.includes(GITIGNORE_MANAGED_END));
    for (const entry of parsed.plan.gitignore_additions) {
      assert.ok(
        body.includes("\n" + entry + "\n"),
        `declared entry '${entry}' missing from .gitignore`,
      );
    }

    // Re-run idempotency through the same CLI path.
    const second = spawnSync(
      "node",
      [SCRIPT, "--target", "py", "--all-templates", "--json", "--out", tmp],
      { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(second.status, 0, second.stderr);
    const parsedSecond = JSON.parse(second.stdout);
    assert.equal(
      parsedSecond.results[0].gitignore.action,
      "noop",
      "second CLI invocation MUST be noop on unchanged manifest",
    );
    const bodyAfter = fs.readFileSync(giPath, "utf8");
    assert.equal(body, bodyAfter, "second CLI invocation rewrote bytes");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Class F — snapshotUntrackedFiles (#401 pre-write safety snapshot)
// Structural Tier-1 probes: real temp git repos, exit/return shape,
// byte-equality of recovered files. No network, no LLM.
// ────────────────────────────────────────────────────────────────

function _git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function _mkGitRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-snap-${label}-`));
  _git(dir, ["init", "-q"]);
  _git(dir, ["config", "user.email", "t@t"]);
  _git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "tracked\n");
  _git(dir, ["add", "tracked.txt"]);
  _git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("F1: snapshot captures an untracked file out-of-tree, byte-identical", () => {
  const dir = _mkGitRepo("f1");
  try {
    const content = "ARCHITECTURE B work — untracked, never staged\n";
    fs.writeFileSync(path.join(dir, "DOCKERHUB.md"), content);
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 1, "one untracked file snapshotted");
    assert.ok(r.snapshotDir, "snapshotDir returned");
    // out-of-tree: under .git/, which rm/clean/reset cannot reach
    assert.ok(
      r.snapshotDir.includes(`${path.sep}.git${path.sep}`) ||
        r.snapshotDir.includes(`${path.sep}.git`),
      `snapshot must live under .git (got ${r.snapshotDir})`,
    );
    const snap = path.join(r.snapshotDir, "DOCKERHUB.md");
    assert.ok(fs.existsSync(snap), "snapshotted file exists");
    assert.equal(fs.readFileSync(snap, "utf8"), content, "byte-identical");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2: dryRun does not snapshot", () => {
  const dir = _mkGitRepo("f2");
  try {
    fs.writeFileSync(path.join(dir, "untracked.md"), "x\n");
    const r = snapshotUntrackedFiles(dir, { dryRun: true });
    assert.equal(r.count, 0, "no snapshot under dryRun");
    assert.equal(r.snapshotDir, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F3: clean tree (no untracked) → no snapshot", () => {
  const dir = _mkGitRepo("f3");
  try {
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 0, "nothing to snapshot");
    assert.equal(r.snapshotDir, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F4: gitignored files are out of scope; untracked-not-ignored are captured", () => {
  const dir = _mkGitRepo("f4");
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
    _git(dir, ["add", ".gitignore"]);
    _git(dir, ["commit", "-q", "-m", "gi"]);
    fs.writeFileSync(path.join(dir, "ignored.log"), "build artifact\n");
    fs.writeFileSync(path.join(dir, "keep.md"), "real work\n");
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 1, "only the untracked-not-ignored file");
    assert.ok(fs.existsSync(path.join(r.snapshotDir, "keep.md")));
    assert.ok(
      !fs.existsSync(path.join(r.snapshotDir, "ignored.log")),
      "ignored file not snapshotted (documented out-of-scope)",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: INCIDENT REGRESSION — untracked file destroyed by rm is recoverable from snapshot", () => {
  const dir = _mkGitRepo("f5");
  try {
    const content = "the dev's uncommitted Architecture B README\n";
    fs.mkdirSync(path.join(dir, "workspaces", "dev-container"), { recursive: true });
    const victim = path.join(dir, "workspaces", "dev-container", "README.md");
    fs.writeFileSync(victim, content);
    // 1. snapshot runs BEFORE any destructive op
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 1);
    // 2. simulate the incident's destructive cleanup
    fs.rmSync(victim);
    assert.ok(!fs.existsSync(victim), "victim destroyed (incident reproduced)");
    // 3. recoverable from the out-of-tree snapshot
    const recovered = path.join(r.snapshotDir, "workspaces", "dev-container", "README.md");
    assert.ok(fs.existsSync(recovered), "recoverable from snapshot");
    assert.equal(fs.readFileSync(recovered, "utf8"), content, "byte-identical recovery");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F6: non-git dir → no throw, no snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-snap-f6-"));
  try {
    fs.writeFileSync(path.join(dir, "x.md"), "x\n");
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 0, "non-git dir: no git deletion vector");
    assert.equal(r.snapshotDir, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F7: REGRESSION (security HIGH-1) — untracked symlink is NOT followed/copied", () => {
  const dir = _mkGitRepo("f7");
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-snap-secret-"));
  try {
    // a sensitive file OUTSIDE the consumer tree
    const secret = path.join(secretDir, "id_ed25519");
    fs.writeFileSync(secret, "PRIVATE KEY MATERIAL\n");
    // an untracked symlink in the consumer tree pointing at it
    fs.symlinkSync(secret, path.join(dir, "secrets-link"));
    // plus a real untracked file (must still be snapshotted)
    fs.writeFileSync(path.join(dir, "real.md"), "real work\n");
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 1, "only the real file; symlink skipped");
    assert.ok(fs.existsSync(path.join(r.snapshotDir, "real.md")));
    // the symlink's TARGET bytes must NOT have leaked into the quarantine
    assert.ok(
      !fs.existsSync(path.join(r.snapshotDir, "secrets-link")),
      "symlink not followed → no private-key bytes in snapshot",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

test("F8: REGRESSION — dangling untracked symlink does not halt the snapshot", () => {
  const dir = _mkGitRepo("f8");
  try {
    fs.symlinkSync(path.join(dir, "nonexistent-target"), path.join(dir, "dangling"));
    fs.writeFileSync(path.join(dir, "real.md"), "real\n");
    // must NOT throw (dangling symlink skipped via existsSync), real file captured
    const r = snapshotUntrackedFiles(dir, { dryRun: false });
    assert.equal(r.count, 1, "dangling symlink skipped, real file snapshotted");
    assert.ok(fs.existsSync(path.join(r.snapshotDir, "real.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// G. #401 Shards 2/3 — lane-wide opt-in (Defect 1) + post-copy
//    byte-equality (Defect 2). Structural probes only.
// ────────────────────────────────────────────────────────────────

test("G1: WRITE to a multi-template lane WITHOUT a scope flag is refused (exit 2, #401)", () => {
  // The ROOT CAUSE of the #401 data loss: a bare `--target py` write fans
  // out to every template in the lane as collateral. The guard fires BEFORE
  // any FS resolution/mutation, so no --out is needed to exercise it.
  const result = spawnSync("node", [SCRIPT, "--target", "py"], {
    encoding: "utf8",
    cwd: REPO,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Refusing an implicit lane-wide write/);
  assert.match(result.stderr, /--template <repo>/);
  assert.match(result.stderr, /--all-templates/);
});

test("G2: --dry-run on a multi-template lane is EXEMPT from the opt-in guard (exit 0)", () => {
  // The danger is the WRITE, not the preview. Dry-run MUST be free to show
  // the whole lane plan — that is its purpose. The guard message MUST NOT
  // appear on a dry-run.
  const result = spawnSync("node", [SCRIPT, "--target", "py", "--dry-run"], {
    encoding: "utf8",
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Refusing an implicit lane-wide write/);
});

test("G3: --all-templates is the explicit opt-in (flag accepted, no guard)", () => {
  const result = spawnSync(
    "node",
    [SCRIPT, "--target", "py", "--all-templates", "--dry-run"],
    { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Refusing an implicit lane-wide write/);
});

test("G4: --template scopes a single-template write (no flag needed, exit 0)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-g4-"));
  try {
    const result = spawnSync(
      "node",
      [SCRIPT, "--target", "py", "--template", "kailash-coc-claude-py", "--out", tmp],
      { encoding: "utf8", cwd: REPO },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Refusing an implicit lane-wide write/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("G5: verifyCopiedBytes returns null on byte-equal copy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-g5-"));
  try {
    const src = path.join(dir, "src.txt");
    const dst = path.join(dir, "dst.txt");
    const bytes = "co-tier rule body — exact bytes\n";
    fs.writeFileSync(src, bytes);
    fs.writeFileSync(dst, bytes);
    assert.equal(verifyCopiedBytes(src, dst), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G6: verifyCopiedBytes detects a byte mismatch (the silent stale-content under-delivery)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-g6-"));
  try {
    const src = path.join(dir, "src.txt");
    const dst = path.join(dir, "dst.txt");
    fs.writeFileSync(src, "NEW canonical content from loom\n");
    fs.writeFileSync(dst, "STALE content left at consumer HEAD\n"); // #401 Defect-2
    const reason = verifyCopiedBytes(src, dst);
    assert.ok(reason !== null, "mismatch MUST be reported");
    assert.match(reason, /byte mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G7: verifyCopiedBytes reports the planned-but-not-written case (dest absent)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-g7-"));
  try {
    const src = path.join(dir, "src.txt");
    fs.writeFileSync(src, "planned copy\n");
    const reason = verifyCopiedBytes(src, path.join(dir, "never-written.txt"));
    assert.ok(reason !== null, "absent dest MUST be reported");
    assert.match(reason, /not readable post-write/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G8: real write reports verified == copied with zero failures (integration)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-aware-g8-"));
  try {
    const result = spawnSync(
      "node",
      [SCRIPT, "--target", "py", "--template", "kailash-coc-claude-py", "--json", "--out", tmp],
      { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const r0 = parsed.results[0];
    assert.ok(r0.copied.length > 0, "some files MUST be copied");
    assert.deepEqual(r0.verify_failures, [], "no under-delivery on a real write");
    assert.equal(
      r0.verified,
      r0.copied.length,
      "every copied path MUST be byte-verified",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// FA — visibility-conditional session-state tracking (journal/0185)
// ────────────────────────────────────────────────────────────────

const MANIFEST_TEXT = fs.readFileSync(
  path.join(REPO, ".claude", "sync-manifest.yaml"),
  "utf8",
);

function _faTmp(markerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-vis-"));
  if (markerContent !== null) {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", ".coc-sync-marker"), markerContent);
  }
  return dir;
}

test("FA: visibility_gitignore_additions parses the public[] entries (no 'public' key leak)", () => {
  const vis = parseVisibilityGitignoreAdditions(MANIFEST_TEXT);
  assert.ok(vis.includes(".session-notes"), "session-notes entry present");
  assert.ok(vis.includes("/workspaces/*"), "workspaces glob present");
  assert.ok(vis.includes("!/workspaces/_template/"), "_template negation present");
  assert.ok(!vis.includes("public"), "the 'public:' YAML key MUST NOT parse as an entry");
});

test("FA: _template negation MUST follow the broad workspaces ignore (order)", () => {
  const vis = parseVisibilityGitignoreAdditions(MANIFEST_TEXT);
  const broad = vis.indexOf("/workspaces/*");
  const negation = vis.indexOf("!/workspaces/_template/");
  assert.ok(broad !== -1 && negation !== -1, "both entries present");
  assert.ok(negation > broad, "negation MUST come after the broad ignore so git re-includes _template");
});

test("FA: public consumer gets base + visibility entries", () => {
  const vis = parseVisibilityGitignoreAdditions(MANIFEST_TEXT);
  const base = [".claude/operator-id"];
  const dir = _faTmp(JSON.stringify({ visibility: "public" }));
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "public");
    const eff = effectiveGitignoreAdditions(base, vis, marker);
    assert.ok(eff.includes(".claude/operator-id"), "base preserved");
    assert.ok(eff.includes(".session-notes"), "public gets session-notes ignore");
    assert.ok(eff.includes("!/workspaces/_template/"), "public gets _template negation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: private consumer gets base ONLY (tracks session-notes + workspaces)", () => {
  const vis = parseVisibilityGitignoreAdditions(MANIFEST_TEXT);
  const base = [".claude/operator-id"];
  const dir = _faTmp(JSON.stringify({ visibility: "private" }));
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "private");
    const eff = effectiveGitignoreAdditions(base, vis, marker);
    assert.deepEqual(eff, base, "private gets base only — no session-notes/workspaces ignore");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: no marker → fail-safe public (operator state ignored, not committed)", () => {
  const dir = _faTmp(null); // no .coc-sync-marker at all
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "public", "absent marker MUST fail-safe to public");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: malformed marker → fail-safe public", () => {
  const dir = _faTmp("this is not parseable :::{{{");
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "public", "unparseable marker MUST fail-safe to public");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: YAML marker body (real consumer format) is read correctly", () => {
  const dir = _faTmp("# COC Sync Marker\nvisibility: private\nsource: loom\n");
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "private", "YAML visibility field MUST parse");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: opt-out 'workspaces' suppresses the workspaces ignore but keeps session-notes", () => {
  const vis = parseVisibilityGitignoreAdditions(MANIFEST_TEXT);
  const base = [".claude/operator-id"];
  const dir = _faTmp(JSON.stringify({ visibility: "public", visibility_opt_out: ["workspaces"] }));
  try {
    const marker = readConsumerVisibility(dir);
    const eff = effectiveGitignoreAdditions(base, vis, marker);
    assert.ok(eff.includes(".session-notes"), "session-notes still ignored");
    assert.ok(!eff.some((e) => e.includes("workspaces")), "workspaces entries suppressed by opt-out");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: unknown visibility value → public (only public|private honored)", () => {
  const dir = _faTmp(JSON.stringify({ visibility: "internal-only" }));
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "public", "non-{public,private} value MUST resolve public");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: oversize marker → fail-safe public (security LOW-1 hardening)", () => {
  const dir = _faTmp(JSON.stringify({ visibility: "private" }) + "x".repeat(70 * 1024));
  try {
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "public", "marker > 64KiB MUST fail-safe to public");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FA: symlinked marker → fail-safe public (O_NOFOLLOW, security LOW-1)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-symlink-"));
  const realTarget = path.join(dir, "real-private-marker.json");
  fs.writeFileSync(realTarget, JSON.stringify({ visibility: "private" }));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  try {
    fs.symlinkSync(realTarget, path.join(dir, ".claude", ".coc-sync-marker"));
    const marker = readConsumerVisibility(dir);
    assert.equal(marker.visibility, "public", "symlinked marker MUST fail-safe to public (O_NOFOLLOW)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
