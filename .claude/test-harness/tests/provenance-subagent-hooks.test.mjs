#!/usr/bin/env node
/*
 * F128 / loom#445 — subagent-internal provenance capture check tests (Tier 1,
 * deterministic, no LLM/network). Covers the validate-emit
 * `provenance-subagent-hooks` check (check 11) + its parser
 * `parseSubagentInternalCapture` + the `frontmatterRegion` helper + a regression
 * guard that the new depth-axis sub-block does NOT pollute parseProvenanceParity.
 *
 * The inline cases below ARE the committed fixtures (one per scope-restriction
 * predicate) per cc-artifacts.md Rule 9 (inline-case definition satisfies the
 * runner contract). Structural per probe-driven-verification.md MUST-3 — no LLM.
 *
 * Predicate matrix (the scope restrictions check 11 relies on):
 *   PARSER:
 *     A1 parses cc/codex/gemini cells from a full block
 *     A2 returns null when provenance_parity absent
 *     A3 returns null when sub-block absent (parity present, no subagent axis)
 *     A4 a sibling 4-space key terminates the sub-block (no over-collection)
 *   ISOLATION (regression for the parseProvenanceParity pollution bug):
 *     B1 parseProvenanceParity.lanes excludes the subagent_internal_capture items
 *   FRONTMATTER:
 *     C1 region between the first two `---`; null when no frontmatter
 *   CHECK (against a tmp root):
 *     D1 cc=wired + every agent carries the hook            → pass, 0 blocking
 *     D2 cc=wired + one agent missing the hook              → fail (wired-but-absent)
 *     D3 block absent                                        → fail
 *     D4 cc cell missing (only codex/gemini declared)        → fail
 *     D5 codex=wired (fabricated capability)                 → fail
 *     D6 cc status not wired (e.g. deferred)                 → fail
 *     D7 gemini unknown status                               → fail
 *     D8 cc=wired but .claude/agents absent                  → skip (not blocking)
 *     D9 residual lanes declared + agents ok                 → codex/gemini pass rows
 *
 * Run: node --test .claude/test-harness/tests/provenance-subagent-hooks.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkProvenanceSubagentHooks,
  parseSubagentInternalCapture,
  parseProvenanceParity,
  frontmatterRegion,
  STATUS,
} from "../../bin/validate-emit.mjs";

// ---- helpers ---------------------------------------------------------------

const HOOK_LINE =
  "hooks:\n  PreToolUse:\n    - matcher: \"*\"\n      hooks:\n        - type: command\n          command: 'node \"$CLAUDE_PROJECT_DIR/.claude/hooks/provenance-capture-tool.js\"'\n          timeout: 5";

function agentWithHook(name) {
  return `---\nname: ${name}\ndescription: ${name} specialist\ntools: Read, Edit, Bash\nmodel: opus\n${HOOK_LINE}\n---\n\n# ${name}\n`;
}
function agentNoHook(name) {
  return `---\nname: ${name}\ndescription: ${name} specialist\ntools: Read, Edit, Bash\nmodel: opus\n---\n\n# ${name}\n`;
}

// Build a manifest with a provenance_parity block carrying the given
// subagent_internal_capture cell lines (already pipe-formatted, no leading `- `).
function manifest({ subCells, omitSubBlock = false, omitParity = false } = {}) {
  if (omitParity) return "parity_enforcement:\n  cross_cli_drift_audit:\n    enabled: true\ntiers:\n  cc: []\n";
  let block =
    "parity_enforcement:\n" +
    "  provenance_parity:\n" +
    "    enabled: true\n" +
    "    cc_capture:\n" +
    '      - "Action|provenance-capture-tool.js|PreToolUse"\n' +
    "    lanes:\n" +
    '      - "codex|Action|wired|provenance-capture-tool.js|PreToolUse shell"\n';
  if (!omitSubBlock) {
    block += "    subagent_internal_capture:\n";
    for (const c of subCells) block += `      - "${c}"\n`;
  }
  block += "tiers:\n  cc: []\n";
  return block;
}

const CC_WIRED = "cc|wired|provenance-capture-tool.js|injected into every agent";
const CODEX_RES = "codex|residual-absent|#445|no per-agent hook primitive";
const GEMINI_RES = "gemini|residual-unverified|#445|BeforeAgent unverified";

let _tmpCounter = 0;
function makeRoot({ manifestText, agents }) {
  // Deterministic per-call dir name (Date.now/Math.random unavailable in the
  // workflow runtime; pid + monotone counter is sufficiently unique here).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `f128-${process.pid}-${_tmpCounter++}-`));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "sync-manifest.yaml"), manifestText);
  if (agents) {
    const adir = path.join(dir, ".claude", "agents");
    fs.mkdirSync(adir, { recursive: true });
    for (const [name, content] of Object.entries(agents)) {
      fs.writeFileSync(path.join(adir, `${name}.md`), content);
    }
  }
  return dir;
}
const statuses = (res) => res.results.map((r) => r.status);
const blocking = (res) => res.results.filter((r) => r.status === STATUS.FAIL || r.status === STATUS.FIXTURE_NEEDED);

// ===========================================================================
// PARSER
// ===========================================================================

test("A1 parseSubagentInternalCapture parses cc/codex/gemini cells", () => {
  const block = parseSubagentInternalCapture(manifest({ subCells: [CC_WIRED, CODEX_RES, GEMINI_RES] }));
  assert.ok(block && block.present);
  assert.equal(block.cells.length, 3);
  const byLane = Object.fromEntries(block.cells.map((c) => [c.lane, c]));
  assert.equal(byLane.cc.status, "wired");
  assert.equal(byLane.cc.f4, "provenance-capture-tool.js");
  assert.equal(byLane.codex.status, "residual-absent");
  assert.equal(byLane.gemini.status, "residual-unverified");
});

test("A2 returns null when provenance_parity absent", () => {
  assert.equal(parseSubagentInternalCapture(manifest({ omitParity: true })), null);
  assert.equal(parseSubagentInternalCapture(null), null);
});

test("A3 returns null when sub-block absent (parity present, no subagent axis)", () => {
  assert.equal(parseSubagentInternalCapture(manifest({ omitSubBlock: true })), null);
});

test("A4 a sibling 4-space key terminates the sub-block (no over-collection)", () => {
  // cc cell, THEN a sibling 4-space key with its own list items that MUST NOT
  // be collected into our cells.
  const m =
    "parity_enforcement:\n" +
    "  provenance_parity:\n" +
    "    enabled: true\n" +
    "    subagent_internal_capture:\n" +
    `      - "${CC_WIRED}"\n` +
    "    other_axis:\n" +
    '      - "should|not|be|collected"\n' +
    "tiers:\n  cc: []\n";
  const block = parseSubagentInternalCapture(m);
  assert.equal(block.cells.length, 1);
  assert.equal(block.cells[0].lane, "cc");
});

// ===========================================================================
// ISOLATION — regression for the parseProvenanceParity pollution bug
// ===========================================================================

test("B1 parseProvenanceParity.lanes excludes subagent_internal_capture items", () => {
  const pp = parseProvenanceParity(manifest({ subCells: [CC_WIRED, CODEX_RES, GEMINI_RES] }));
  assert.ok(pp);
  // The manifest declares exactly ONE real lane (codex|Action|wired). The 3
  // subagent cells MUST NOT leak in.
  assert.equal(pp.lanes.length, 1, `lanes polluted: ${JSON.stringify(pp.lanes.map((l) => l.raw))}`);
  assert.equal(pp.lanes[0].lane, "codex");
  assert.equal(pp.lanes[0].kind, "Action");
});

// ===========================================================================
// FRONTMATTER helper
// ===========================================================================

test("C1 frontmatterRegion extracts the region; null when no frontmatter", () => {
  assert.equal(frontmatterRegion("no frontmatter here"), null);
  assert.equal(frontmatterRegion(null), null);
  const fm = frontmatterRegion(agentWithHook("foo"));
  assert.ok(fm.includes("provenance-capture-tool.js"));
  assert.ok(!fm.includes("# foo")); // body excluded
});

// ===========================================================================
// CHECK
// ===========================================================================

test("D1 cc=wired + every agent carries the hook → pass, 0 blocking", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: [CC_WIRED, CODEX_RES, GEMINI_RES] }),
    agents: { alpha: agentWithHook("alpha"), beta: agentWithHook("beta"), _README: "# meta, skipped\n" },
  });
  const res = checkProvenanceSubagentHooks(root);
  assert.equal(blocking(res).length, 0, JSON.stringify(res.results, null, 2));
  assert.ok(res.results.some((r) => r.status === STATUS.PASS && /2\/2 source agents/.test(r.detail)));
});

test("D2 cc=wired + one agent missing the hook → fail (wired-but-absent)", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: [CC_WIRED, CODEX_RES, GEMINI_RES] }),
    agents: { alpha: agentWithHook("alpha"), beta: agentNoHook("beta") },
  });
  const res = checkProvenanceSubagentHooks(root);
  const fails = blocking(res);
  assert.equal(fails.length, 1);
  assert.match(fails[0].artifact, /beta\.md$/);
  assert.match(fails[0].detail, /wired-but-absent/);
});

test("D3 block absent → fail", () => {
  const root = makeRoot({ manifestText: manifest({ omitSubBlock: true }), agents: { alpha: agentWithHook("alpha") } });
  const res = checkProvenanceSubagentHooks(root);
  assert.equal(blocking(res).length, 1);
  assert.match(res.results[0].detail, /depth axis is undeclared/);
});

test("D4 cc cell missing (only codex/gemini declared) → fail", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: [CODEX_RES, GEMINI_RES] }),
    agents: { alpha: agentWithHook("alpha") },
  });
  const res = checkProvenanceSubagentHooks(root);
  assert.ok(blocking(res).some((r) => /no `cc` cell/.test(r.detail)));
});

test("D5 codex=wired (fabricated capability) → fail", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: [CC_WIRED, "codex|wired|x|fabricated", GEMINI_RES] }),
    agents: { alpha: agentWithHook("alpha") },
  });
  const res = checkProvenanceSubagentHooks(root);
  assert.ok(blocking(res).some((r) => /wired claim would be fabricated/.test(r.detail)));
});

test("D6 cc status not wired (deferred) → fail", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: ["cc|deferred|#x|nope", CODEX_RES, GEMINI_RES] }),
    agents: { alpha: agentWithHook("alpha") },
  });
  const res = checkProvenanceSubagentHooks(root);
  assert.ok(blocking(res).some((r) => /only correct CC disposition is wired/.test(r.detail)));
});

test("D7 gemini unknown status → fail", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: [CC_WIRED, CODEX_RES, "gemini|maybe|#x|huh"] }),
    agents: { alpha: agentWithHook("alpha") },
  });
  const res = checkProvenanceSubagentHooks(root);
  assert.ok(blocking(res).some((r) => /unrecognized/.test(r.detail)));
});

test("D8 cc=wired but .claude/agents absent → skip (not blocking)", () => {
  const root = makeRoot({ manifestText: manifest({ subCells: [CC_WIRED, CODEX_RES, GEMINI_RES] }) /* no agents */ });
  const res = checkProvenanceSubagentHooks(root);
  assert.equal(blocking(res).length, 0);
  assert.ok(res.results.some((r) => r.status === STATUS.SKIP && /loom checkout only/.test(r.detail)));
});

test("D9 residual lanes declared + agents ok → codex/gemini pass rows", () => {
  const root = makeRoot({
    manifestText: manifest({ subCells: [CC_WIRED, CODEX_RES, GEMINI_RES] }),
    agents: { alpha: agentWithHook("alpha") },
  });
  const res = checkProvenanceSubagentHooks(root);
  assert.ok(res.results.some((r) => /\[codex\]/.test(r.artifact) && r.status === STATUS.PASS));
  assert.ok(res.results.some((r) => /\[gemini\]/.test(r.artifact) && r.status === STATUS.PASS));
});
