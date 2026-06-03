#!/usr/bin/env node
/*
 * Tier-1 structural test for emitCodexAgentPrompts — the deterministic
 * Codex specialist-by-name shim landed 2026-05-15 to close the parity
 * gap surfaced by the Codex follow-up in a downstream consumer (Codex
 * runtime exposes only generic default/explorer/worker; loom emits
 * .codex/prompts/specialist-<name>.md so the file is reachable via
 * inline-cat injection through bin/coc — see codex-templates/bin/README.md
 * for the canonical Codex invocation path — F79).
 *
 * All assertions are STRUCTURAL per rules/probe-driven-verification.md
 * MUST-3 (file existence, count, JSON-schema-shape, frontmatter
 * presence). No regex-against-semantic-claims.
 *
 * Run: node .claude/test-harness/tests/codex-specialist-prompts.test.mjs
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

function emitToTmp(target = null) {
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-specialist-prompts-"),
  );
  const targetFlag = target ? ` --target ${target}` : "";
  execSync(`node "${EMITTER}" --cli codex${targetFlag} --out "${outDir}"`, {
    cwd: REPO,
    stdio: "pipe",
  });
  return path.join(outDir, "codex", "prompts");
}

function listSpecialistPrompts(promptsDir) {
  if (!fs.existsSync(promptsDir)) return [];
  return fs
    .readdirSync(promptsDir)
    .filter((f) => f.startsWith("specialist-") && f.endsWith(".md"));
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: content };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fm[kv[1]] = val;
  }
  return { frontmatter: fm, body: m[2] };
}

// ────────────────────────────────────────────────────────────────
// Test 1: Emission produces exactly the expected specialist prompt
// count per target (per cc-architect Round-1 F2: floor ≥20 silently
// allowed a 2-specialist regression while still passing).
//
// Tightened from "≥20" to per-target equality — drops below the
// expected count (regression) AND surplus above expected count
// (over-emit / exclusion miss) both surface loudly.
// ────────────────────────────────────────────────────────────────
test("emitCodexAgentPrompts emits 27 specialists with no target filter", () => {
  const promptsDir = emitToTmp();
  const prompts = listSpecialistPrompts(promptsDir);
  assert.equal(
    prompts.length,
    27,
    `Expected exactly 27 specialist prompts (no target filter), got ${prompts.length}: ${prompts.join(", ")}`,
  );
});

test("emitCodexAgentPrompts emits 22 specialists for --target py", () => {
  const promptsDir = emitToTmp("py");
  const prompts = listSpecialistPrompts(promptsDir);
  assert.equal(
    prompts.length,
    22,
    `Expected exactly 22 specialist prompts for --target py (tier-subscription filter), got ${prompts.length}: ${prompts.join(", ")}`,
  );
});

test("emitCodexAgentPrompts emits 22 specialists for --target rs", () => {
  const promptsDir = emitToTmp("rs");
  const prompts = listSpecialistPrompts(promptsDir);
  assert.equal(
    prompts.length,
    22,
    `Expected exactly 22 specialist prompts for --target rs (tier-subscription filter), got ${prompts.length}: ${prompts.join(", ")}`,
  );
});

// ────────────────────────────────────────────────────────────────
// Test 2: Every emitted prompt has valid frontmatter with `name:` +
// `description:` AND name MUST start with `specialist-`.
// ────────────────────────────────────────────────────────────────
test("every specialist prompt has frontmatter with name + description", () => {
  const promptsDir = emitToTmp();
  const prompts = listSpecialistPrompts(promptsDir);
  for (const file of prompts) {
    const content = fs.readFileSync(path.join(promptsDir, file), "utf8");
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter, `${file}: missing frontmatter`);
    assert.ok(
      frontmatter.name && frontmatter.name.startsWith("specialist-"),
      `${file}: name must start with 'specialist-', got ${JSON.stringify(frontmatter.name)}`,
    );
    assert.ok(
      frontmatter.description && frontmatter.description.length > 0,
      `${file}: missing description`,
    );
  }
});

// ────────────────────────────────────────────────────────────────
// Test 3: Sample specialist (dataflow) has the three-invocation-pattern
// preamble + the embedded operating specification header.
// Structural file-content presence check (per probe-driven-verification
// MUST-3 — structural is fine; semantic regex would not be).
// ────────────────────────────────────────────────────────────────
test("specialist-dataflow.md preamble has three invocation patterns + spec section", () => {
  const promptsDir = emitToTmp();
  const dfPath = path.join(promptsDir, "specialist-dataflow.md");
  assert.ok(fs.existsSync(dfPath), "specialist-dataflow.md must exist");
  const body = fs.readFileSync(dfPath, "utf8");
  // Three invocation-pattern anchors (literal headings; structural, not
  // semantic — these are file-content section markers the emitter writes).
  assert.ok(
    body.includes("## Invocation patterns"),
    "preamble must contain '## Invocation patterns' header",
  );
  assert.ok(
    body.includes("**(a) Inline persona"),
    "preamble must mark pattern (a)",
  );
  assert.ok(
    body.includes("**(b) Worker subagent delegation"),
    "preamble must mark pattern (b)",
  );
  assert.ok(
    body.includes("**(c) Headless `codex exec` fallback."),
    "preamble must mark pattern (c)",
  );
  assert.ok(
    body.includes("## Operating specification"),
    "body must include '## Operating specification' header",
  );
  // Per codex-architect Round-1 F3: section markers passing is not enough.
  // The wrapped operating spec MUST be non-trivial — a prompt with the
  // preamble + empty body would otherwise pass the marker checks.
  // Structural assertion (byte count post-spec-header), not semantic.
  const specIdx = body.indexOf("## Operating specification");
  const specBody = body.slice(specIdx + "## Operating specification".length);
  assert.ok(
    specBody.trim().length > 500,
    `Operating specification body MUST be non-trivial (>500 chars); got ${specBody.trim().length} chars`,
  );
});

// ────────────────────────────────────────────────────────────────
// Test 3b: Heading-hierarchy invariant — Operating Specification (H2)
// must NOT immediately contain an H1 (which breaks markdown TOC tooling
// + heading-anchor generation downstream). Per codex-architect Round-1
// F4 — the agent file's natural H1 banner is demoted to H3 by the
// emitter to fit under the wrapper's H2.
// ────────────────────────────────────────────────────────────────
test("emitted prompt body has no H1 nested inside Operating specification H2", () => {
  const promptsDir = emitToTmp();
  const dfPath = path.join(promptsDir, "specialist-dataflow.md");
  const body = fs.readFileSync(dfPath, "utf8");
  const specIdx = body.indexOf("## Operating specification");
  const specBody = body.slice(specIdx);
  // Strip fenced code blocks (```...```) before scanning — code-comment
  // lines like `# Development` are not markdown H1s.
  const stripped = specBody.replace(/```[\s\S]*?```/g, "");
  // Any H1 line (`# ` at line start) after the spec H2 is a hierarchy bug.
  const h1MatchInSpec = /\n# [^\n]/.test(stripped);
  assert.ok(
    !h1MatchInSpec,
    "Operating specification (H2) must not nest an H1 outside code blocks — emitter must demote agent file's H1 to H3",
  );
});

// ────────────────────────────────────────────────────────────────
// Test 4: Structural exclusions are honored — no specialist prompts
// for cc-architect, codex-architect, gemini-architect, cli-orchestrator,
// or any management/* agent.
// ────────────────────────────────────────────────────────────────
test("structural exclusions suppress architects + orchestrator + management", () => {
  const promptsDir = emitToTmp();
  const prompts = listSpecialistPrompts(promptsDir);
  const banned = [
    "specialist-cc-architect.md",
    "specialist-codex-architect.md",
    "specialist-gemini-architect.md",
    "specialist-cli-orchestrator.md",
    // Management agents (coc-sync, sync-reviewer, repo-ops, settings-manager,
    // todo-manager, gh-manager) MUST NOT emit. Sample three.
    "specialist-coc-sync.md",
    "specialist-sync-reviewer.md",
    "specialist-repo-ops.md",
  ];
  for (const file of banned) {
    assert.ok(
      !prompts.includes(file),
      `${file} MUST be excluded but was emitted`,
    );
  }
});

// ────────────────────────────────────────────────────────────────
// Test 5: Naming convention — trailing "-specialist" suffix is stripped.
// e.g., dataflow-specialist.md → specialist-dataflow.md (NOT
// specialist-dataflow-specialist.md).
// ────────────────────────────────────────────────────────────────
test("trailing -specialist suffix stripped from prompt name", () => {
  const promptsDir = emitToTmp();
  const prompts = listSpecialistPrompts(promptsDir);
  // Spot-check three known frameworks specialists.
  assert.ok(
    prompts.includes("specialist-dataflow.md"),
    "specialist-dataflow.md must exist",
  );
  assert.ok(
    prompts.includes("specialist-kaizen.md"),
    "specialist-kaizen.md must exist",
  );
  assert.ok(
    prompts.includes("specialist-nexus.md"),
    "specialist-nexus.md must exist",
  );
  // Confirm the redundant double-suffix form does NOT appear.
  assert.ok(
    !prompts.includes("specialist-dataflow-specialist.md"),
    "redundant double-suffix form must NOT be emitted",
  );
});

// ────────────────────────────────────────────────────────────────
// Test 6: Quality-gate specialists (reviewer, security-reviewer,
// gold-standards-validator) are present — these are the named specialists
// cited in acceptance criterion 2 of the 2026-05-15 Codex follow-up.
// ────────────────────────────────────────────────────────────────
test("quality-gate specialists are emitted", () => {
  const promptsDir = emitToTmp();
  const prompts = listSpecialistPrompts(promptsDir);
  for (const name of [
    "specialist-reviewer.md",
    "specialist-security-reviewer.md",
    "specialist-gold-standards-validator.md",
  ]) {
    assert.ok(
      prompts.includes(name),
      `${name} (cited in Codex follow-up acceptance criteria) must emit`,
    );
  }
});
