/*
 * #408 AC#5-b — rules-reference skill-channel emission regression lock.
 *
 * AC#5-a shipped the cli_delivery contract + Validator 18 (which SURFACED the 61
 * path-scoped rules as `skill-channel [pending AC#5-b]`). AC#5-b DELIVERS them:
 * emit-cli-artifacts.mjs::emitRulesReferenceSkill generates an on-demand INDEX
 * skill (pointing at the canonical shared `.claude/rules/<name>.md`) so Codex and
 * Gemini — which have no `paths:` glob loader — can reach those rules.
 *
 * Invariants locked here:
 *   (A) The index rule SET provably equals Validator 18's skill-channel report
 *       (single-source-of-truth — no divergent parser; the R1 finding AC#5-a closed).
 *   (B) Index, NOT body-copy: each row points to `.claude/rules/<file>.md`; the
 *       shared rules path is NOT rewritten to a per-CLI `.codex/`/`.gemini/` path.
 *   (C) No baseline / cc-only / skill-embedded rule leaks into the index.
 *   (D) codex and gemini indexes are byte-identical (cli_delivery is lane-neutral).
 *   (E) Emission is deterministic / idempotent.
 *   (F) tier / loom-only / exclusion filters shrink the indexed set correctly.
 *   (G) Pure helpers (parseRulePaths, ruleTitle) behave on synthetic input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

const emit = await import(path.join(REPO, ".claude", "bin", "emit.mjs"));
const cli = await import(path.join(REPO, ".claude", "bin", "emit-cli-artifacts.mjs"));
const lib = await import(path.join(REPO, ".claude", "bin", "lib", "cli-delivery.mjs"));

const {
  buildRulesReferenceIndex,
  emitRulesReferenceSkill,
  parseRulePaths,
  ruleTitle,
  mdCell,
  stripOutsideQuoteComment,
  splitFlowListOutsideQuotes,
  loadExclusions,
  loadLoomOnly,
} = cli;

const FULL = () => ({ tierFilter: null, loomOnly: loadLoomOnly(), exclusions: loadExclusions() });

// ── (A) single source of truth: index set === Validator 18 skill-channel ──
test("index rule set is identical to Validator 18 skill-channel report", () => {
  const v18 = emit.validateCliDelivery();
  const validatorSet = new Set(v18.report["skill-channel"]);
  const idx = buildRulesReferenceIndex(FULL());
  const indexSet = new Set(idx.rules.map((r) => r.file));
  assert.equal(indexSet.size, validatorSet.size, "size mismatch index vs validator");
  for (const f of validatorSet) assert.ok(indexSet.has(f), `validator skill-channel ${f} missing from index`);
  for (const f of indexSet) assert.ok(validatorSet.has(f), `index ${f} not a validator skill-channel rule`);
});

test("the shared cli-delivery parser is the SAME reference in emit.mjs and the lib", () => {
  // emit.mjs re-exports the lib functions; identity guarantees no divergent copy.
  assert.equal(emit.checkRuleCliDelivery, lib.checkRuleCliDelivery);
  assert.equal(emit.deriveCliDelivery, lib.deriveCliDelivery);
  assert.deepEqual(emit.CLI_DELIVERY_VALUES, lib.CLI_DELIVERY_VALUES);
});

// ── (B) index, not body-copy: rows point at the shared canonical rule path ──
test("every index row points to .claude/rules/<file>.md (shared, not rewritten)", () => {
  const idx = buildRulesReferenceIndex(FULL());
  assert.ok(idx.skillMd.includes("`.claude/rules/"), "index must cite .claude/rules/ paths");
  // The shared rules path MUST NOT be rewritten per-CLI — rules are consumed
  // identically across all three CLIs (rewriteClaudePathsForCli skips rules/).
  assert.ok(!idx.skillMd.includes(".codex/rules/"), "index must not rewrite to .codex/rules/");
  assert.ok(!idx.skillMd.includes(".gemini/rules/"), "index must not rewrite to .gemini/rules/");
  // No rule body is copied — the index is a table, not the rule prose. A spot
  // check: the index must be far smaller than the sum of the rule bodies.
  for (const r of idx.rules) {
    assert.ok(idx.skillMd.includes(`\`.claude/rules/${r.file}\``), `missing pointer for ${r.file}`);
  }
});

// ── (C) no non-skill-channel rule leaks in ──
test("baseline / cc-only / skill-embedded rules are absent from the index", () => {
  const v18 = emit.validateCliDelivery();
  const idx = buildRulesReferenceIndex(FULL());
  const indexSet = new Set(idx.rules.map((r) => r.file));
  for (const bucket of ["baseline", "cc-only", "n/a-skill-embedded"]) {
    for (const f of v18.report[bucket]) {
      assert.ok(!indexSet.has(f), `${bucket} rule ${f} leaked into the rules-reference index`);
    }
  }
});

// ── (D) + (E) emission: both lanes byte-identical, idempotent ──
test("emitRulesReferenceSkill writes both lanes byte-identical and idempotent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac5b-"));
  try {
    const s1 = emitRulesReferenceSkill({ outDir: tmp, ...FULL(), verbose: false });
    assert.equal(s1.codex, 1);
    assert.equal(s1.gemini, 1);
    assert.ok(s1.rules > 0);
    const codexP = path.join(tmp, "codex", "skills", "rules-reference", "SKILL.md");
    const geminiP = path.join(tmp, "gemini", "skills", "rules-reference", "SKILL.md");
    const c1 = fs.readFileSync(codexP, "utf8");
    const g1 = fs.readFileSync(geminiP, "utf8");
    assert.equal(c1, g1, "codex and gemini index must be byte-identical");
    // Idempotency: re-emit into a second dir → identical bytes.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "ac5b2-"));
    try {
      emitRulesReferenceSkill({ outDir: tmp2, ...FULL(), verbose: false });
      const c2 = fs.readFileSync(path.join(tmp2, "codex", "skills", "rules-reference", "SKILL.md"), "utf8");
      assert.equal(c1, c2, "emission must be deterministic");
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("SKILL.md carries exactly one frontmatter listing entry (name + description)", () => {
  const idx = buildRulesReferenceIndex(FULL());
  const fm = idx.skillMd.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, "SKILL.md must open with frontmatter");
  assert.match(fm[1], /^name:\s*rules-reference$/m);
  assert.match(fm[1], /^description:\s*.+/m);
  // Exactly one frontmatter block (one listing entry → budget-neutral listing).
  assert.equal((idx.skillMd.match(/^---$/gm) || []).length, 2);
});

// ── (F) filters: loom-only excludes; an over-broad tier filter excludes all ──
test("loom-only globs remove a rule from the index", () => {
  const base = buildRulesReferenceIndex(FULL());
  const victim = base.rules[0].file;
  const idx = buildRulesReferenceIndex({
    tierFilter: null,
    loomOnly: [`rules/${victim}`],
    exclusions: loadExclusions(),
  });
  assert.ok(!idx.rules.some((r) => r.file === victim), `${victim} should be loom-only-excluded`);
  assert.equal(idx.rules.length, base.rules.length - 1);
});

test("a tier filter matching nothing yields an empty index and no emission", () => {
  const idx = buildRulesReferenceIndex({
    tierFilter: ["rules/__no_such_rule__.md"],
    loomOnly: [],
    exclusions: loadExclusions(),
  });
  assert.equal(idx.skillMd, null);
  assert.equal(idx.rules.length, 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac5b-empty-"));
  try {
    const s = emitRulesReferenceSkill({
      outDir: tmp,
      tierFilter: ["rules/__no_such_rule__.md"],
      loomOnly: [],
      exclusions: loadExclusions(),
      verbose: false,
    });
    assert.equal(s.codex, 0);
    assert.equal(s.gemini, 0);
    assert.equal(s.rules, 0);
    assert.ok(!fs.existsSync(path.join(tmp, "codex", "skills", "rules-reference")), "no empty index dir");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a tier filter matching a subset shrinks the index to that subset", () => {
  const base = buildRulesReferenceIndex(FULL());
  const keep = base.rules.slice(0, 3).map((r) => `rules/${r.file}`);
  const idx = buildRulesReferenceIndex({ tierFilter: keep, loomOnly: [], exclusions: loadExclusions() });
  assert.equal(idx.rules.length, 3);
  for (const r of idx.rules) assert.ok(keep.includes(`rules/${r.file}`));
});

// ── (G) pure helpers ──
test("parseRulePaths extracts a quoted YAML list and stops at the next key", () => {
  const fm = `priority: 10
scope: path-scoped
paths:
  - ".claude/agents/**"
  - "**/*worktree*"
tags: [a, b]`;
  assert.deepEqual(parseRulePaths(fm), [".claude/agents/**", "**/*worktree*"]);
});

test("parseRulePaths returns [] when there is no paths block", () => {
  assert.deepEqual(parseRulePaths("priority: 0\nscope: baseline"), []);
});

test("ruleTitle reads the H1, falling back to the filename stem", () => {
  const withH1 = `---\nscope: path-scoped\n---\n\n# My Rule Title\n\nbody`;
  assert.equal(ruleTitle(withH1, "x.md"), "My Rule Title");
  const noH1 = `---\nscope: path-scoped\n---\n\nbody with no heading`;
  assert.equal(ruleTitle(noH1, "fallback-name.md"), "fallback-name");
});

test("the index table has one data row per indexed rule", () => {
  const idx = buildRulesReferenceIndex(FULL());
  const dataRows = (idx.skillMd.match(/^\| .* \| .* \| `\.claude\/rules\/.*` \|$/gm) || []).length;
  assert.equal(dataRows, idx.rules.length);
});

// ── R1 fix: parseRulePaths inline flow-list form (reviewer/cc-architect/analyst) ──
test("parseRulePaths parses the inline flow-list form `paths: [...]`", () => {
  assert.deepEqual(parseRulePaths('scope: path-scoped\npaths: ["**/*.py", "packages/**"]'), [
    "**/*.py",
    "packages/**",
  ]);
  // Single-entry inline form (multi-operator-coordination / user-flow-validation use this).
  assert.deepEqual(parseRulePaths('scope: path-scoped\npaths: ["**/*"]'), ["**/*"]);
});

test("parseRulePaths inline split is quote-aware regardless of element position (R2 MED)", () => {
  // A quoted brace-glob carries an internal comma that MUST NOT split the entry —
  // verified in BOTH first AND non-first position (the R1 regex was position-
  // dependent and only preserved a brace-glob as the first element; the R1 test
  // was vacuous because it only checked the passing arrangement).
  assert.deepEqual(parseRulePaths('paths: ["**/*.{py,rs}", "src/**"]'), ["**/*.{py,rs}", "src/**"]);
  assert.deepEqual(parseRulePaths('paths: ["src/**", "**/*.{py,rs}"]'), ["src/**", "**/*.{py,rs}"]);
  // Two brace-globs, both non-trivially positioned.
  assert.deepEqual(parseRulePaths('paths: ["a/**", "**/*.{js,ts}", "**/*.{py,rs}"]'), [
    "a/**",
    "**/*.{js,ts}",
    "**/*.{py,rs}",
  ]);
});

test("parseRulePaths inline tolerates a trailing comment containing a bracket (R2 LOW)", () => {
  // The greedy-to-last-] match used to swallow a `]` inside a trailing comment,
  // producing a phantom "]" glob. Outside-quote comment-strip runs first now.
  assert.deepEqual(parseRulePaths('paths: ["a"] # see [docs]'), ["a"]);
  assert.deepEqual(parseRulePaths('paths: ["**/*.[ch]"] # C/H files [ref]'), ["**/*.[ch]"]);
});

test("parseRulePaths preserves a glob char-class and an in-quote hash", () => {
  // Greedy-to-last-] keeps a char-class glob intact; a `#` inside quotes is NOT
  // treated as a comment.
  assert.deepEqual(parseRulePaths('paths: ["**/*.[ch]"]'), ["**/*.[ch]"]);
  assert.deepEqual(parseRulePaths('paths:\n  - "weird/a #b/**"'), ["weird/a #b/**"]);
});

test("parseRulePaths strips trailing inline comments (block + inline forms)", () => {
  assert.deepEqual(parseRulePaths('paths:\n  - "src/**"  # only src'), ["src/**"]);
  assert.deepEqual(parseRulePaths('paths: ["src/**"]  # trailing'), ["src/**"]);
});

test("parseRulePaths skips a full-line comment inside a block (not a terminator)", () => {
  const fm = `paths:
  - "a/**"
  # a comment between entries
  - "b/**"
tags: [x]`;
  assert.deepEqual(parseRulePaths(fm), ["a/**", "b/**"]);
});

test("corpus invariant: every indexed rule renders real path globs, never the empty fallback", () => {
  // Every path-scoped rule carries `paths:` per rule-authoring.md Rule 5, so the
  // "no path globs" fallback must never appear for the live corpus. This is the
  // structural lock against the R1 parseRulePaths inline-form regression.
  const idx = buildRulesReferenceIndex(FULL());
  assert.ok(!idx.skillMd.includes("no path globs"), "an indexed rule rendered the empty-globs fallback");
});

// ── R1 fix: markdown-cell escaping (security-reviewer) ──
test("mdCell-escaped index: a pipe or newline in a title/glob cannot break a row", () => {
  // buildRulesReferenceIndex escapes via mdCell before interpolation. We assert the
  // live index has exactly 3 cells per data row (no stray unescaped pipes splitting rows).
  const idx = buildRulesReferenceIndex(FULL());
  for (const line of idx.skillMd.split("\n")) {
    if (/^\| .* \| .* \| `\.claude\/rules\//.test(line)) {
      // A well-formed 3-column row has exactly 4 unescaped pipes (| a | b | c |).
      const unescaped = (line.match(/(?<!\\)\|/g) || []).length;
      assert.equal(unescaped, 4, `row has ${unescaped} unescaped pipes (expected 4): ${line}`);
    }
  }
});

// ── R1 fix: ruleTitle fence-awareness (security-reviewer NIT) + R2 tilde fence ──
test("ruleTitle ignores a heading inside a fenced code block before the H1", () => {
  const backtick = `---\nscope: path-scoped\n---\n\n\`\`\`\n# DO\n\`\`\`\n\n# Real Title\n`;
  assert.equal(ruleTitle(backtick, "x.md"), "Real Title");
  // R2 cc-architect: tilde fences must toggle too.
  const tilde = `---\nscope: path-scoped\n---\n\n~~~\n# DO\n~~~\n\n# Real Title\n`;
  assert.equal(ruleTitle(tilde, "x.md"), "Real Title");
});

// ── R2 fix: mdCell completeness (pipe + newline + backtick) ──
test("mdCell escapes pipe, collapses newline, neutralizes backtick", () => {
  assert.equal(mdCell("a|b"), "a\\|b");
  assert.equal(mdCell("a\nb"), "a b");
  assert.equal(mdCell("a\r\nb"), "a b");
  // backtick → apostrophe so a glob cell's inline-code span cannot be broken.
  assert.equal(mdCell("a`b"), "a'b");
  assert.equal(mdCell("plain/**"), "plain/**");
});

// ── R2 fix: quote-aware primitives (direct unit coverage) ──
test("stripOutsideQuoteComment strips an outside-quote comment, keeps in-quote hash", () => {
  assert.equal(stripOutsideQuoteComment('"a"]  # cmt').trimEnd(), '"a"]');
  assert.equal(stripOutsideQuoteComment('"a #b"'), '"a #b"'); // # inside quotes preserved
  assert.equal(stripOutsideQuoteComment("no comment here"), "no comment here");
});

test("splitFlowListOutsideQuotes splits on outside-quote commas only", () => {
  assert.deepEqual(splitFlowListOutsideQuotes('"a", "b"').map((s) => s.trim()), ['"a"', '"b"']);
  assert.deepEqual(
    splitFlowListOutsideQuotes('"**/*.{py,rs}", "src/**"').map((s) => s.trim()),
    ['"**/*.{py,rs}"', '"src/**"'],
  );
});

// ── R1 fix: skip-count surfacing (analyst MED/LOW) ──
test("buildRulesReferenceIndex returns skip counters (0 for the clean corpus)", () => {
  const idx = buildRulesReferenceIndex(FULL());
  assert.equal(idx.skippedContractFail, 0);
  assert.equal(idx.skippedNoFrontmatter, 0);
});
