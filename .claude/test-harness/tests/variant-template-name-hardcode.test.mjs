#!/usr/bin/env node
/*
 * Structural test — variant-overlay template-name hardcode budget.
 *
 * Walks `.claude/variants/<lang>/**` and counts occurrences of USE-template
 * repo names (kailash-coc-claude-{py,rs,rb}, kailash-coc-{py,rs}, coc-{claude-,}base).
 * Each file has a committed allowance; the test fails if any file's count
 * exceeds its allowance OR if a file not in the allowance map contains any
 * occurrence.
 *
 * Why this exists: loom #140 (2026-05-11) — `variants/rs/commands/sync.md`
 * shipped 6 hardcoded `kailash-coc-claude-rs` references in prose that ALSO
 * shipped to `kailash-coc-rs` (multi-CLI), confusing post-migration consumers
 * about which template is upstream. The fix removed the prose hardcodes; this
 * test pins the post-fix state so the same drift class cannot re-emerge
 * silently in a future variant edit.
 *
 * Legitimate references (preserved in the allowance map):
 *   - Auto-detection heuristic tables that map dependency signals to
 *     template names. These ARE template-name-specific by design.
 *   - Comparative documentation explicitly naming legacy vs multi-CLI.
 *
 * Run: node .claude/test-harness/tests/variant-template-name-hardcode.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, "..", "..", "..");
const VARIANTS_DIR = path.join(REPO, ".claude", "variants");

// Template repo names this test guards. Anchored as whole tokens so
// "kailash-coc-rs" does not match "kailash-coc-rs-something-else".
const TEMPLATE_NAMES = [
  "kailash-coc-claude-py",
  "kailash-coc-claude-rs",
  "kailash-coc-claude-rb",
  "kailash-coc-py",
  "kailash-coc-rs",
  "coc-claude-base",
  "coc-base",
];

// Per-file occurrence allowance. Keys are paths relative to
// `.claude/variants/`. Each value is the maximum total cross-template-name
// count that file may contain. Files NOT in this map MUST contain zero
// template-name occurrences.
//
// Adding a new entry — or raising an existing budget — REQUIRES a journal
// entry explaining why the hardcode is structurally necessary (e.g., it's
// part of an auto-detection heuristic, not consumer-facing prose).
const ALLOWANCES = {
  // rs consumer-facing /sync command — auto-detection heuristic table
  // (multi-CLI vs legacy CC-only) maps dependency signals to template
  // names; example clone command names both rs templates explicitly.
  // Detection is structural; consumer-facing prose was genericized per
  // loom #140 (2026-05-11).
  "rs/commands/sync.md": 8,

  // (rb/commands/sync.md entry removed: the rb variant tree was collapsed into
  // the rs all-bindings template in commit e751529 / #423; the file no longer
  // exists, so its ALLOWANCES entry was stale. #445 cycle.)

  // prism rs branch-protection registry — structural data table listing
  // terrene-foundation/<repo> entries with their protection rules. Repo
  // identifiers in a registry are the registry's purpose, not consumer-
  // facing prose drift.
  "prism/rules/git.md": 3,

  // (rb/rules/observability.md + rb/rules/schema-migration.md entries removed:
  // same rb→rs fleet collapse as above — commit e751529 / #423 deleted the rb
  // variant rules tree. Entries were stale. #445 cycle.)

  // Cross-SDK procedure pointers — EATP D6 semantic-parity references
  // pointing at the Python sibling SDK's equivalent procedure. The
  // template name IS the cross-SDK pointer's target; genericizing would
  // erase the pointer's meaning.
  "rs/skills/10-deployment-git/release-runbook.md": 1,
  "rs/skills/10-deployment-git/rust-version-bump.md": 2,

  // Issue reference — `terrene-foundation/<repo>#NN` is a stable,
  // grep-able cross-reference. Not consumer-facing template-selection
  // prose.
  "rs/skills/18-security-patterns/rls-security-definer-preauth-carveout.md": 1,

  // Issue-provenance citation — this rule's ORIGINATING incident is
  // `terrene-foundation/kailash-coc-claude-rs#52` (Bedrock-first ADR with
  // no SDK support); it appears twice (intro framing + Origin footer).
  // The citation IS the rule's reason-for-existence; genericizing it would
  // erase the audit trail. Same class as the issue-reference entry above.
  // Rationale receipt: journal/0180 (2026-05-31). Pre-existing on main
  // (introduced face318, 2.31.0 release); surfaced by the F92 full-suite
  // sweep, fixed separately from #401 per atomicity.
  "rs/rules/llm-deployment-coverage.md": 2,
};

function* walkFiles(root, rel = "") {
  const full = rel ? path.join(root, rel) : root;
  if (!fs.existsSync(full)) return;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const entryRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(root, entryRel);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield { absPath: path.join(full, entry.name), relPath: entryRel };
    }
  }
}

function countTemplateNames(content) {
  let total = 0;
  for (const name of TEMPLATE_NAMES) {
    // Whole-token match: not preceded or followed by a name-character.
    // Prevents `kailash-coc-rs` from matching inside `kailash-coc-rs-foo`.
    const pattern = new RegExp(
      `(^|[^a-zA-Z0-9_-])${name.replace(/-/g, "\\-")}(?![a-zA-Z0-9_-])`,
      "g",
    );
    const matches = content.match(pattern);
    if (matches) total += matches.length;
  }
  return total;
}

test("variants/ overlays stay within per-file template-name allowances", () => {
  const violations = [];
  for (const { relPath, absPath } of walkFiles(VARIANTS_DIR)) {
    const content = fs.readFileSync(absPath, "utf8");
    const count = countTemplateNames(content);
    if (count === 0) continue;
    const allowed = ALLOWANCES[relPath] ?? 0;
    if (count > allowed) {
      violations.push({
        path: relPath,
        actual: count,
        allowed,
        delta: count - allowed,
      });
    }
  }
  assert.deepEqual(
    violations,
    [],
    `template-name hardcode budget exceeded:\n${violations
      .map(
        (v) =>
          `  variants/${v.path}: ${v.actual} occurrences (budget ${v.allowed}, +${v.delta}). ` +
          `Either remove the hardcoded references or raise the ALLOWANCES entry with a journal-entry rationale.`,
      )
      .join("\n")}`,
  );
});

test("ALLOWANCES map references existing files only", () => {
  const stale = [];
  for (const relPath of Object.keys(ALLOWANCES)) {
    const absPath = path.join(VARIANTS_DIR, relPath);
    if (!fs.existsSync(absPath)) {
      stale.push(relPath);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `ALLOWANCES map has stale entries (file no longer exists):\n${stale
      .map((p) => `  variants/${p}`)
      .join("\n")}`,
  );
});
