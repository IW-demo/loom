#!/usr/bin/env node
/*
 * Tier-2 regression test for the skills-lane tool-name translation
 * (#408 AC#4). Before this landed, emitSkillTreeWithOverlays byte-copied
 * CC tool-name frontmatter (`tools:\n  - Read\n  - Glob\n  - Grep`) verbatim
 * into BOTH the Codex and Gemini skill emissions — the cross-CLI-parity gap
 * #408 AC#4 names. The AGENTS lane already translates (emitGeminiAgents →
 * translateCcToolsToGemini) or strips (emitCodexAgentPrompts drops tools:);
 * this test pins the skills lane to the SAME per-CLI contract:
 *   - gemini: translate CC tokens → native names (read_file/glob/grep_search),
 *     preserving the multi-line list form, WITHOUT injecting list_directory.
 *   - codex:  strip the tools: block entirely.
 * The skill BODY (incl. DO-NOT example blocks that legitimately carry CC-isms
 * to teach what NOT to write, per #408 C3b) MUST be untouched.
 *
 * Two layers:
 *   (1) Unit — direct calls into the exported translateSkillFrontmatterTools.
 *   (2) Integration — black-box emit to a tmp dir + structural assertions on
 *       the emitted SKILL.md frontmatter (per rules/probe-driven-verification.md
 *       MUST-3: structural, not regex-against-semantic-claims).
 *
 * Run: node .claude/test-harness/tests/skill-frontmatter-tool-translation.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const EMITTER = path.join(REPO, ".claude", "bin", "emit-cli-artifacts.mjs");

const { translateSkillFrontmatterTools } = await import(
  path.join(REPO, ".claude", "bin", "emit-cli-artifacts.mjs")
);

// ── helpers ──────────────────────────────────────────────────────
function emitToTmp(cli) {
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `skill-tool-xlate-${cli}-`),
  );
  execSync(`node "${EMITTER}" --cli ${cli} --out "${outDir}"`, {
    cwd: REPO,
    stdio: "pipe",
  });
  return path.join(outDir, cli, "skills");
}

// Extract ONLY the leading frontmatter block (between the first two --- lines).
function frontmatterOf(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : "";
}

const CC_TOOL_LINE = /^\s*-\s*(Read|Glob|Grep|Edit|Write|Bash)\s*$/m;

// ── (1) Unit tests ───────────────────────────────────────────────
test("gemini: multi-line list translates to native names, list form preserved", () => {
  const src = `---\nname: x\ndescription: "d"\ntools:\n  - Read\n  - Glob\n  - Grep\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "gemini");
  assert.match(out, /tools:\n  - read_file\n  - glob\n  - grep_search\n---/);
  assert.doesNotMatch(frontmatterOf(out), CC_TOOL_LINE);
});

test("gemini: does NOT inject list_directory (skill tools: declares only what body invokes)", () => {
  const src = `---\nname: x\ntools:\n  - Read\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "gemini");
  assert.doesNotMatch(out, /list_directory/);
});

test("codex: tools: block stripped entirely", () => {
  const src = `---\nname: x\ndescription: "d"\ntools:\n  - Read\n  - Glob\n  - Grep\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "codex");
  assert.doesNotMatch(frontmatterOf(out), /^tools:/m);
  assert.doesNotMatch(frontmatterOf(out), CC_TOOL_LINE);
  // name + description survive
  assert.match(out, /name: x/);
  assert.match(out, /description: "d"/);
});

test("gemini: inline comma list form also translates", () => {
  const src = `---\nname: x\ntools: Read, Grep\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "gemini");
  assert.match(out, /tools:\n  - read_file\n  - grep_search\n---/);
});

test("gemini: legacy allowed-tools: key normalizes to tools: + translates", () => {
  const src = `---\nname: x\nallowed-tools:\n  - Read\n  - Bash\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "gemini");
  assert.match(out, /tools:\n  - read_file\n  - run_shell_command\n---/);
  assert.doesNotMatch(out, /allowed-tools:/);
});

test("codex: legacy allowed-tools: block stripped too", () => {
  const src = `---\nname: x\nallowed-tools:\n  - Read\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "codex");
  assert.doesNotMatch(out, /allowed-tools:/);
  assert.doesNotMatch(out, /^tools:/m);
});

test("gemini: CC-only tokens (Task) with no native equivalent drop the block", () => {
  const src = `---\nname: x\ntools:\n  - Task\n---\n\n# Body\n`;
  const out = translateSkillFrontmatterTools(src, "gemini");
  assert.doesNotMatch(frontmatterOf(out), /^tools:/m);
});

test("no frontmatter → unchanged", () => {
  const src = `# Just a body\n\nNo frontmatter here.\n`;
  assert.equal(translateSkillFrontmatterTools(src, "gemini"), src);
  assert.equal(translateSkillFrontmatterTools(src, "codex"), src);
});

test("frontmatter without tools: → unchanged", () => {
  const src = `---\nname: x\ndescription: "d"\n---\n\n# Body\n`;
  assert.equal(translateSkillFrontmatterTools(src, "gemini"), src);
  assert.equal(translateSkillFrontmatterTools(src, "codex"), src);
});

test("body is never touched — DO-NOT example blocks with CC-isms survive verbatim", () => {
  const body = `# Skill\n\n# DO NOT\ntools:\n  - Read\n  - Write\n\nAvoid \`Agent(subagent_type="x")\` in prose.\n`;
  const src = `---\nname: x\ntools:\n  - Read\n---\n\n${body}`;
  const outG = translateSkillFrontmatterTools(src, "gemini");
  const outC = translateSkillFrontmatterTools(src, "codex");
  // the BODY portion (after the closing ---) is byte-identical on both lanes
  assert.ok(outG.endsWith(body), "gemini body preserved");
  assert.ok(outC.endsWith(body), "codex body preserved");
  assert.match(outG, /Agent\(subagent_type="x"\)/);
  assert.match(outC, /Agent\(subagent_type="x"\)/);
});

test("non-codex/gemini cli → identity (cc passthrough)", () => {
  const src = `---\nname: x\ntools:\n  - Read\n---\n\n# Body\n`;
  assert.equal(translateSkillFrontmatterTools(src, "cc"), src);
  assert.equal(translateSkillFrontmatterTools(src, null), src);
});

// ── (1b) Edge-case fixtures (each pins a redteam-surfaced defect) ─
test("EDGE trailing comment on key line → list items still consumed, no orphan/leak", () => {
  // pure comment on the key line
  const a = `---\nname: x\ntools:  # the tools list\n  - Read\n  - Grep\n---\n\n# Body\n`;
  const ga = translateSkillFrontmatterTools(a, "gemini");
  assert.match(ga, /tools:\n  - read_file\n  - grep_search\n---/);
  assert.doesNotMatch(frontmatterOf(ga), CC_TOOL_LINE); // no orphaned `  - Read`
  const ca = translateSkillFrontmatterTools(a, "codex");
  assert.doesNotMatch(frontmatterOf(ca), /^\s*-\s/m); // no dangling list item
  assert.doesNotMatch(frontmatterOf(ca), CC_TOOL_LINE);
  // inline value + trailing comment
  const b = `---\nname: x\ntools: Read, Grep  # note\n---\n\n# Body\n`;
  assert.match(translateSkillFrontmatterTools(b, "gemini"), /tools:\n  - read_file\n  - grep_search\n---/);
});

test("EDGE CRLF frontmatter → translation fires, CRLF preserved", () => {
  const src = `---\r\nname: x\r\ntools:\r\n  - Read\r\n  - Grep\r\n---\r\n\r\n# Body\r\n`;
  const g = translateSkillFrontmatterTools(src, "gemini");
  assert.doesNotMatch(frontmatterOf(g), CC_TOOL_LINE); // CC tokens gone (not a silent no-op)
  assert.match(g, /- read_file/);
  assert.ok(g.includes("\r\n"), "CRLF EOL preserved on reconstruction");
  const c = translateSkillFrontmatterTools(src, "codex");
  assert.doesNotMatch(c, /^tools:/m);
});

test("EDGE idempotent — second gemini pass is a no-op (does NOT drop the block)", () => {
  const src = `---\nname: x\ntools:\n  - Read\n  - Grep\n---\n\n# Body\n`;
  const once = translateSkillFrontmatterTools(src, "gemini");
  const twice = translateSkillFrontmatterTools(once, "gemini");
  assert.equal(twice, once, "re-running over already-native tokens must be a no-op");
  assert.match(twice, /tools:\n  - read_file\n  - grep_search\n---/);
});

test("EDGE body containing a --- horizontal rule is not mistaken for frontmatter close", () => {
  const src = `---\nname: x\ntools:\n  - Read\n  - Glob\n  - Grep\n---\n\n# Body\n\n---\n\nsection two\n`;
  const g = translateSkillFrontmatterTools(src, "gemini");
  assert.ok(g.endsWith("# Body\n\n---\n\nsection two\n"), "body horizontal rule preserved");
  assert.match(g, /tools:\n  - read_file\n  - glob\n  - grep_search\n---/);
});

// ── (2) Integration tests (black-box emit) ───────────────────────

// Recursively collect every SKILL.md under an emitted skills dir — nested
// skills (e.g. 40-stack-onboarding/<lang>/SKILL.md) live one level deeper
// than <skill>/SKILL.md and MUST be covered by the leak sweep.
function allSkillMds(skillsDir) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "SKILL.md") found.push(p);
    }
  };
  if (fs.existsSync(skillsDir)) walk(skillsDir);
  return found;
}
test("integration: NO CC tool name survives in ANY emitted skill FRONTMATTER incl. nested (both lanes)", () => {
  for (const cli of ["codex", "gemini"]) {
    const skillsDir = emitToTmp(cli);
    assert.ok(fs.existsSync(skillsDir), `${cli} skills dir emitted`);
    const skillMds = allSkillMds(skillsDir); // RECURSIVE — covers nested <skill>/<lang>/SKILL.md
    assert.ok(skillMds.length > 0, `${cli}: found SKILL.md files to sweep`);
    const leaks = skillMds.filter((p) =>
      CC_TOOL_LINE.test(frontmatterOf(fs.readFileSync(p, "utf8"))),
    );
    assert.deepEqual(
      leaks.map((p) => path.relative(skillsDir, p)),
      [],
      `${cli}: CC tool names leaked in frontmatter`,
    );
  }
});

test("integration: nested 40-stack-onboarding/<lang> (allowed-tools: + Bash) translated/stripped", () => {
  // gemini: allowed-tools: → tools: with native names incl. run_shell_command (Bash)
  const gDir = emitToTmp("gemini");
  const gNested = allSkillMds(gDir).filter((p) => p.includes("40-stack-onboarding"));
  assert.ok(gNested.length >= 1, "nested stack-onboarding skills emitted on gemini");
  for (const p of gNested) {
    const fm = frontmatterOf(fs.readFileSync(p, "utf8"));
    assert.doesNotMatch(fm, CC_TOOL_LINE, `${p}: no CC token`);
    assert.doesNotMatch(fm, /allowed-tools:/, `${p}: legacy key normalized away`);
    assert.match(fm, /- run_shell_command/, `${p}: Bash → run_shell_command`);
  }
  // codex: tools:/allowed-tools: stripped on nested too
  const cDir = emitToTmp("codex");
  const cNested = allSkillMds(cDir).filter((p) => p.includes("40-stack-onboarding"));
  assert.ok(cNested.length >= 1, "nested stack-onboarding skills emitted on codex");
  for (const p of cNested) {
    const fm = frontmatterOf(fs.readFileSync(p, "utf8"));
    assert.doesNotMatch(fm, /^(tools|allowed-tools):/m, `${p}: tool block stripped`);
  }
});

test("integration: gemini eatp-reference frontmatter translated to native names", () => {
  const skillsDir = emitToTmp("gemini");
  const fm = frontmatterOf(
    fs.readFileSync(path.join(skillsDir, "26-eatp-reference", "SKILL.md"), "utf8"),
  );
  assert.match(fm, /tools:/);
  assert.match(fm, /- read_file/);
  assert.match(fm, /- grep_search/);
  assert.match(fm, /- glob/);
});

test("integration: codex eatp-reference frontmatter has tools: stripped", () => {
  const skillsDir = emitToTmp("codex");
  const fm = frontmatterOf(
    fs.readFileSync(path.join(skillsDir, "26-eatp-reference", "SKILL.md"), "utf8"),
  );
  assert.doesNotMatch(fm, /^tools:/m);
  assert.match(fm, /name: eatp-reference/);
});

test("integration: skill BODY pedagogical CC-ism examples preserved (skill-authoring)", () => {
  const skillsDir = emitToTmp("gemini");
  const content = fs.readFileSync(
    path.join(skillsDir, "skill-authoring", "SKILL.md"),
    "utf8",
  );
  // the body teaches "list only what you invoke" using literal CC tool
  // examples in DO/DO-NOT blocks — those MUST survive (C3b), even though the
  // FRONTMATTER tools: above them is translated.
  const m = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  const body = m ? m[1] : "";
  assert.ok(CC_TOOL_LINE.test(body), "pedagogical CC tool example list preserved in body");
});

test("integration: skill count unchanged on both lanes (no skill dropped by the transform)", () => {
  for (const cli of ["codex", "gemini"]) {
    const skillsDir = emitToTmp(cli);
    const n = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).length;
    assert.ok(n >= 30, `${cli}: expected >=30 emitted skills, got ${n}`);
  }
});
