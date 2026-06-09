#!/usr/bin/env node
/*
 * Tier-2 regression test for the consumer-side efficacy gate (#408 AC#7 /
 * journal/0244 / validate-emit `consumer-efficacy` check). The completeness
 * check (mirror-exclusion) proves a source artifact is PRESENT in the fresh
 * emit; this gate proves the freshly-emitted artifacts actually PARSE-LOAD
 * under each target CLI's runtime SCHEMA contract — the gap that ships a
 * tomlLiteralEscape bug, an unterminated frontmatter, or a body-embedded '''
 * silently and breaks the consumer's Codex/Gemini loader on first use.
 *
 * loom has NO .github/workflows/ (journal/0234), so AC#7's "post-merge consumer
 * smoke-runner" runs as a /sync-time validate-emit check + this Tier-2 test, not
 * a CI job. The CLI runtimes are not installable here, so "parse-load under the
 * target runtime" is the per-CLI loader's SCHEMA contract (TOML for Gemini
 * commands, YAML frontmatter for Codex prompts + skills).
 *
 * Two layers (per rules/probe-driven-verification.md MUST-3 — structural):
 *   (1) Unit — validateGeminiCommandToml + extractRulesIndexCitations on
 *       synthetic strings (no fs).
 *   (2) Integration — checkConsumerEfficacy against the LIVE corpus (clean) AND
 *       against synthetic emit trees that inject each failure mode (malformed
 *       TOML / unterminated frontmatter / missing description / empty skill dir /
 *       dangling citation / lane-asymmetric index / empty index) so the check is
 *       proven NON-VACUOUS.
 *
 * Run: node .claude/test-harness/tests/consumer-efficacy-contract.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

const {
  checkConsumerEfficacy,
  validateGeminiCommandToml,
  extractRulesIndexCitations,
  STATUS,
} = await import(path.join(REPO, ".claude", "bin", "validate-emit.mjs"));

// ── helpers ──────────────────────────────────────────────────────
const fails = (results) => results.filter((r) => r.status === STATUS.FAIL);
const detailOf = (results, sub) =>
  fails(results).find((r) => r.artifact.includes(sub));

function w(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const GOOD_TOML = `name = "demo"
description = "A demo command."
prompt = '''
# /demo
Body line with backticks \`x\` and "quotes" — all literal.
'''
tools = ["read_file", "write_file"]
`;

const GOOD_PROMPT = `---
name: demo
description: "A demo prompt."
---

# /demo
Body.
`;

const SKILL = (name, desc) =>
  `---\n${name ? `name: ${name}\n` : ""}description: "${desc}"\n---\n\n# Body\n`;

const INDEX = (cites) =>
  `---
name: rules-reference
description: "On-demand index of path-scoped rules."
---

# Rules Reference

| Rule | Applies when | Read |
| ---- | ------------ | ---- |
${cites.map((c) => `| ${c} | _(domain)_ | \`.claude/rules/${c}\` |`).join("\n")}

${cites.length} path-scoped rules indexed.
`;

// Build a CLEAN synthetic emit tree + a root carrying the cited source rules.
// Returns { root, emitDir }. Mutate before calling the check to inject faults.
function makeClean() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac7-root-"));
  const emitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac7-emit-"));
  // Source rules the index cites must exist under root/.claude/rules/.
  w(root, ".claude/rules/known.md", "---\nscope: path-scoped\n---\n# Known\n");
  for (const cli of ["codex", "gemini"]) {
    w(emitDir, `${cli}/skills/leaf/SKILL.md`, SKILL("leaf", "A leaf skill."));
    // nested/multi-variant skill (no top-level SKILL.md — variants carry it)
    w(emitDir, `${cli}/skills/nested/python/SKILL.md`, SKILL(null, "Name-less but described."));
    w(emitDir, `${cli}/skills/rules-reference/SKILL.md`, INDEX(["known.md"]));
  }
  w(emitDir, "gemini/commands/demo.toml", GOOD_TOML);
  w(emitDir, "codex/prompts/demo.md", GOOD_PROMPT);
  return { root, emitDir };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ════════════════════════════════════════════════════════════════
// (1) UNIT — validateGeminiCommandToml
// ════════════════════════════════════════════════════════════════
test("validateGeminiCommandToml: clean TOML returns no errors", () => {
  assert.deepEqual(validateGeminiCommandToml(GOOD_TOML), []);
});

test("validateGeminiCommandToml: missing name flagged", () => {
  const errs = validateGeminiCommandToml(GOOD_TOML.replace(/^name = .*\n/m, ""));
  assert.ok(errs.some((e) => /name/.test(e)), errs.join("|"));
});

test("validateGeminiCommandToml: missing description flagged", () => {
  const errs = validateGeminiCommandToml(GOOD_TOML.replace(/^description = .*\n/m, ""));
  assert.ok(errs.some((e) => /description/.test(e)), errs.join("|"));
});

test("validateGeminiCommandToml: missing prompt block flagged", () => {
  const errs = validateGeminiCommandToml(`name = "x"\ndescription = "y"\n`);
  assert.ok(errs.some((e) => /prompt/.test(e)), errs.join("|"));
});

test("validateGeminiCommandToml: unterminated literal flagged", () => {
  const errs = validateGeminiCommandToml(
    `name = "x"\ndescription = "y"\nprompt = '''\nbody with no closer\n`,
  );
  assert.ok(errs.some((e) => /unterminated/.test(e)), errs.join("|"));
});

test("validateGeminiCommandToml: premature ''' close in body flagged (the escape-bug class)", () => {
  // A body containing an UNESCAPED ''' closes the literal early; the trailing
  // markdown then is not valid TOML — exactly what tomlLiteralEscape prevents.
  const bad = `name = "x"\ndescription = "y"\nprompt = '''\nhere is a triple quote ''' inside the body\nmore markdown prose\n'''\ntools = ["read_file"]\n`;
  const errs = validateGeminiCommandToml(bad);
  assert.ok(errs.some((e) => /early|premature|embedded/.test(e)), errs.join("|"));
});

test("validateGeminiCommandToml: interior ''' that coincidentally still parses → STILL flagged (silent truncation, R1 LOW-2)", () => {
  // Body ends with ''' then `tools = []` — the residue parses as valid TOML, but
  // the prompt body was silently TRUNCATED. The count-based check (>1 ''') flags
  // it where a post-close line-shape heuristic would have passed it.
  const truncating = `name = "x"\ndescription = "y"\nprompt = '''\nreal body ''' tools = []\n'''\ntools = ["read_file"]\n`;
  const errs = validateGeminiCommandToml(truncating);
  assert.ok(errs.some((e) => /early|embedded/.test(e)), errs.join("|"));
});

// ════════════════════════════════════════════════════════════════
// (2) UNIT — extractRulesIndexCitations
// ════════════════════════════════════════════════════════════════
test("extractRulesIndexCitations: extracts every cited rule file", () => {
  const cites = extractRulesIndexCitations(INDEX(["a.md", "b-c.md", "d.md"]));
  assert.deepEqual(cites, ["a.md", "b-c.md", "d.md"]);
});

test("extractRulesIndexCitations: no citations → empty", () => {
  assert.deepEqual(extractRulesIndexCitations("# no rules here\n"), []);
});

// ════════════════════════════════════════════════════════════════
// (3) INTEGRATION — checkConsumerEfficacy against synthetic emit trees
// ════════════════════════════════════════════════════════════════
test("clean synthetic emit → zero FAIL (incl. nested skill not false-flagged)", () => {
  const { root, emitDir } = makeClean();
  try {
    const res = checkConsumerEfficacy(root, { emitDir });
    assert.equal(fails(res.results).length, 0, JSON.stringify(fails(res.results), null, 2));
    // nested skill's variant SKILL.md is present as a PASS, proving the recursive scan.
    assert.ok(
      res.results.some((r) => r.artifact.endsWith("nested/python/SKILL.md") && r.status === STATUS.PASS),
    );
  } finally {
    cleanup(root, emitDir);
  }
});

test("malformed Gemini TOML (premature ''' close) → FAIL", () => {
  const { root, emitDir } = makeClean();
  try {
    w(emitDir, "gemini/commands/demo.toml",
      `name = "x"\ndescription = "y"\nprompt = '''\nbody ''' early close\nprose\n'''\ntools = []\n`);
    const res = checkConsumerEfficacy(root, { emitDir });
    assert.ok(detailOf(res.results, "gemini/commands/demo.toml"), "expected a TOML parse-load FAIL");
  } finally {
    cleanup(root, emitDir);
  }
});

test("unterminated Codex prompt frontmatter → FAIL", () => {
  const { root, emitDir } = makeClean();
  try {
    w(emitDir, "codex/prompts/demo.md", `---\nname: demo\ndescription: "x"\n\n# no closing fence\n`);
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "codex/prompts/demo.md");
    assert.ok(f && /unterminated/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

test("skill SKILL.md missing description → FAIL (name alone is insufficient)", () => {
  const { root, emitDir } = makeClean();
  try {
    w(emitDir, "gemini/skills/leaf/SKILL.md", `---\nname: leaf\n---\n\n# Body\n`);
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "gemini/skills/leaf/SKILL.md");
    assert.ok(f && /description/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

test("skill SKILL.md with bare empty `description:` → FAIL (R1 MED-1: empty value parses truthy)", () => {
  const { root, emitDir } = makeClean();
  try {
    // bare `description:` (no value) → parseFrontmatter maps it to [] (truthy);
    // the nonEmpty guard must still flag it.
    w(emitDir, "gemini/skills/leaf/SKILL.md", `---\nname: leaf\ndescription:\n---\n\n# Body\n`);
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "gemini/skills/leaf/SKILL.md");
    assert.ok(f && /description/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

test("rules-reference: a paths-COLUMN glob embedding .claude/rules/... is NOT a citation (R1 MED-2 anchor)", () => {
  const { root, emitDir } = makeClean();
  try {
    // Row whose Applies-when (middle) cell embeds a glob mentioning a
    // NON-EXISTENT rule path; the Read cell cites the real one. Only the Read
    // cell is a citation, so this must NOT false-FAIL as dangling.
    const idx = `---
name: rules-reference
description: "idx"
---

| Rule | Applies when | Read |
| ---- | ------------ | ---- |
| Known | \`**/.claude/rules/ghost-glob.md\` | \`.claude/rules/known.md\` |
`;
    for (const cli of ["codex", "gemini"]) w(emitDir, `${cli}/skills/rules-reference/SKILL.md`, idx);
    const res = checkConsumerEfficacy(root, { emitDir });
    assert.equal(fails(res.results).length, 0, JSON.stringify(fails(res.results), null, 2));
  } finally {
    cleanup(root, emitDir);
  }
});

test("skill dir with no SKILL.md anywhere → FAIL", () => {
  const { root, emitDir } = makeClean();
  try {
    w(emitDir, "gemini/skills/empty/notes.md", "# not a skill manifest\n");
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "gemini/skills/empty");
    assert.ok(f && /no SKILL\.md/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

test("rules-reference index citing a non-existent source rule → FAIL (dangling)", () => {
  const { root, emitDir } = makeClean();
  try {
    w(emitDir, "gemini/skills/rules-reference/SKILL.md", INDEX(["known.md", "ghost.md"]));
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "gemini/rules-reference");
    assert.ok(f && /non-existent|ghost\.md/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

test("rules-reference index emitted on one lane only → FAIL (lane-asymmetric)", () => {
  const { root, emitDir } = makeClean();
  try {
    fs.rmSync(path.join(emitDir, "gemini/skills/rules-reference"), { recursive: true, force: true });
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "rules-reference");
    assert.ok(f && /asymmetric/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

test("rules-reference index with zero citations → FAIL (empty channel)", () => {
  const { root, emitDir } = makeClean();
  try {
    for (const cli of ["codex", "gemini"])
      w(emitDir, `${cli}/skills/rules-reference/SKILL.md`, INDEX([]));
    const res = checkConsumerEfficacy(root, { emitDir });
    const f = detailOf(res.results, "rules-reference");
    assert.ok(f && /zero rules|empty/.test(f.detail), JSON.stringify(f));
  } finally {
    cleanup(root, emitDir);
  }
});

// ════════════════════════════════════════════════════════════════
// (4) INTEGRATION — LIVE corpus is parse-load-clean (non-vacuous PASS)
// ════════════════════════════════════════════════════════════════
test("LIVE loom emit → consumer-efficacy clean (0 FAIL) + non-vacuous PASS rows", () => {
  const res = checkConsumerEfficacy(REPO); // no emitDir → real emit-cli-artifacts run
  assert.equal(fails(res.results).length, 0, JSON.stringify(fails(res.results), null, 2));
  // Prove the check actually inspected real artifacts (not all SKIP).
  assert.ok(res.results.filter((r) => r.status === STATUS.PASS).length > 50);
});
