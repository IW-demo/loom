#!/usr/bin/env node
/*
 * F101-4 — provenance-event cross-CLI parity check tests (Tier 1, deterministic,
 * no LLM/network). loom#411 item 5.
 *
 * Covers the validate-emit `provenance-parity` check (check 9). The inline cases
 * below ARE the committed fixtures (one per scope-restriction predicate) per
 * cc-artifacts.md Rule 9 (storage layout is operator-choice; inline-case
 * definition satisfies the runner contract: assert expected vs actual + non-zero
 * exit on mismatch). Structural per probe-driven-verification.md MUST-3 — no LLM.
 *
 * Predicate matrix (the scope restrictions check 9 relies on):
 *   P1 clean current state (all deferred+tracked)        → all skip, 0 blocking
 *   P2 wired + hook present in emit target               → pass
 *   P3 wired + hook absent in emit target                → fail (declared-wired-but-absent)
 *   P4 deferred without #NNN tracking                    → fail
 *   P5 undeclared (lane,kind) where CC captures kind     → fail (SILENT DROP, #408)
 *   P6 cc_capture set drifts from hook-emitted kinds     → fail (byte-exact seam)
 *   P7 hook emits a kind outside EVENT_KINDS             → fail
 *   P8 orphan lane decl (unknown lane / uncaptured kind) → fail
 *   P9 block absent                                       → fail
 *   P10 enabled:false                                     → skip
 *   P11 cc_capture empty + enabled                        → fail
 *   P12 unknown status (not wired|deferred)               → fail
 *
 * Run: node --test .claude/test-harness/tests/provenance-parity.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkProvenanceParity,
  parseProvenanceParity,
  extractHookKinds,
  evaluateProvenanceParity,
  collectHookCommands,
  PROVENANCE_TARGET_LANES,
} from "../../bin/validate-emit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// ---- helpers ---------------------------------------------------------------

// The 4-kind capture surface that mirrors the live cc_capture declaration.
const CC_CAPTURE_4 = [
  { kind: "HumanInput", hook: "provenance-capture-prompt.js", event: "UserPromptSubmit", raw: "" },
  { kind: "Action", hook: "provenance-capture-tool.js", event: "PreToolUse", raw: "" },
  { kind: "Decision", hook: "provenance-capture-tool.js", event: "PreToolUse", raw: "" },
  { kind: "Delegation", hook: "provenance-capture-tool.js", event: "PreToolUse", raw: "" },
];

// An extraction object whose hook-emitted set == the 4 closed-taxonomy kinds.
function extraction4() {
  return {
    kinds: new Set(["HumanInput", "Action", "Decision", "Delegation"]),
    byHook: new Map([
      ["provenance-capture-prompt.js", new Set(["HumanInput"])],
      ["provenance-capture-tool.js", new Set(["Action", "Decision", "Delegation"])],
    ]),
    errors: [],
  };
}

// Build the 8 deferred lane cells (the clean current-state declaration).
function deferredLanes(overrides = {}) {
  const cells = [];
  for (const lane of PROVENANCE_TARGET_LANES) {
    for (const kind of ["HumanInput", "Action", "Decision", "Delegation"]) {
      const key = `${lane}|${kind}`;
      cells.push(
        overrides[key] || {
          lane,
          kind,
          status: "deferred",
          f4: "#411",
          f5: `${lane} ${kind} capture deferred`,
          raw: `${lane}|${kind}|deferred|#411|...`,
        },
      );
    }
  }
  return cells;
}

const allDeferredBlock = () => ({
  present: true,
  enabled: true,
  ccCapture: CC_CAPTURE_4.map((c) => ({ ...c })),
  lanes: deferredLanes(),
});

const neverPresent = () => false;
const alwaysPresent = () => true;

function tally(results) {
  const t = { pass: 0, fail: 0, skip: 0, "fixture-needed": 0 };
  for (const r of results) t[r.status] = (t[r.status] || 0) + 1;
  return t;
}
function fails(results) {
  return results.filter((r) => r.status === "fail");
}

// ===========================================================================
//  P1 — clean current state: all 8 cells deferred + tracked → all skip
// ===========================================================================
test("P1 clean deferred state → 8 skip, 0 fail", () => {
  const results = evaluateProvenanceParity({
    block: allDeferredBlock(),
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  const t = tally(results);
  assert.equal(t.fail, 0, `expected 0 fail, got ${JSON.stringify(fails(results))}`);
  assert.equal(t.skip, 8, "expected 8 deferred skips (4 kinds × 2 lanes)");
  assert.equal(t.pass, 0);
});

// ===========================================================================
//  P2 — wired + hook present → pass
// ===========================================================================
test("P2 wired + hook present in emit target → pass", () => {
  const block = allDeferredBlock();
  // Flip codex|Action to wired.
  block.lanes = block.lanes.map((c) =>
    c.lane === "codex" && c.kind === "Action"
      ? { ...c, status: "wired", f4: "provenance-capture-tool.js", f5: "PreToolUse" }
      : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: (lane, hook) => lane === "codex" && hook === "provenance-capture-tool.js",
    hookEmitsKind: (hook, kind) => hook === "provenance-capture-tool.js" && kind === "Action",
  });
  const cell = results.find((r) => r.artifact === "codex:Action");
  assert.equal(cell.status, "pass", JSON.stringify(cell));
  assert.equal(tally(results).fail, 0);
});

// P2c (security R2 MED): wired + hook registered BUT the hook does NOT emit the
// declared kind (e.g. a real-but-unrelated hook like validate-bash-command.js) →
// FAIL. Registration alone must not pass.
test("P2c wired + registered-but-non-capture hook → fail (does not emit kind)", () => {
  const block = allDeferredBlock();
  block.lanes = block.lanes.map((c) =>
    c.lane === "codex" && c.kind === "Action"
      ? { ...c, status: "wired", f4: "validate-bash-command.js", f5: "shell" }
      : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: alwaysPresent, // it IS registered
    hookEmitsKind: () => false, // but emits no provenance kind
  });
  const cell = results.find((r) => r.artifact === "codex:Action");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /does NOT emit provenance kind/);
});

// ===========================================================================
//  #440 — codex-mcp-guard mechanism (`<hook>@codex-mcp-guard`)
//  The mechanism qualifier is a TIGHTENING: provenance-capture-tool.js is ALSO
//  registered in .codex/hooks.json on the shell matcher, so a bare native
//  codex|Decision would false-pass via laneHookPresent — yet shell never writes
//  journal files, so Decision never fires there. The qualifier forces the guard
//  path to be verified instead.
// ===========================================================================
function wireCodexDecisionGuard(block, f4) {
  block.lanes = block.lanes.map((c) =>
    c.lane === "codex" && c.kind === "Decision"
      ? { ...c, status: "wired", f4, f5: "apply_patch → Decision" }
      : c,
  );
  return block;
}

test("G1 wired @codex-mcp-guard + guard captures + emits kind → pass", () => {
  const block = wireCodexDecisionGuard(
    allDeferredBlock(),
    "provenance-capture-tool.js@codex-mcp-guard",
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent, // native registration must NOT satisfy it
    hookEmitsKind: (hook, kind) =>
      hook === "provenance-capture-tool.js" && kind === "Decision",
    guardCapturesHook: (hook) => hook === "provenance-capture-tool.js",
  });
  const cell = results.find((r) => r.artifact === "codex:Decision");
  assert.equal(cell.status, "pass", JSON.stringify(cell));
  assert.match(cell.detail, /via codex-mcp-guard/);
});

test("G2 wired @codex-mcp-guard but guard does NOT capture → fail (no native fallback)", () => {
  const block = wireCodexDecisionGuard(
    allDeferredBlock(),
    "provenance-capture-tool.js@codex-mcp-guard",
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: alwaysPresent, // native says present — MUST be ignored
    hookEmitsKind: () => true,
    guardCapturesHook: () => false, // guard not wired
  });
  const cell = results.find((r) => r.artifact === "codex:Decision");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /codex-mcp-guard does NOT capture/);
});

test("G3 wired @codex-mcp-guard on a NON-codex lane → fail (mechanism is codex-only)", () => {
  const block = allDeferredBlock();
  block.lanes = block.lanes.map((c) =>
    c.lane === "gemini" && c.kind === "Decision"
      ? { ...c, status: "wired", f4: "provenance-capture-tool.js@codex-mcp-guard", f5: "x" }
      : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: alwaysPresent,
    hookEmitsKind: () => true,
    guardCapturesHook: () => true,
  });
  const cell = results.find((r) => r.artifact === "gemini:Decision");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /only valid for the codex lane/);
});

test("G4 wired with an UNKNOWN @mechanism → fail", () => {
  const block = wireCodexDecisionGuard(
    allDeferredBlock(),
    "provenance-capture-tool.js@some-future-thing",
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: alwaysPresent,
    hookEmitsKind: () => true,
    guardCapturesHook: () => true,
  });
  const cell = results.find((r) => r.artifact === "codex:Decision");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /unknown capture mechanism/);
});

test("G5 wired @codex-mcp-guard + guard captures but hook does NOT emit kind → fail", () => {
  const block = wireCodexDecisionGuard(
    allDeferredBlock(),
    "provenance-capture-tool.js@codex-mcp-guard",
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
    hookEmitsKind: () => false, // hookEmitsKind gate still applies
    guardCapturesHook: () => true,
  });
  const cell = results.find((r) => r.artifact === "codex:Decision");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /does NOT emit provenance kind/);
});

test("G6 default guardCapturesHook is fail-closed (no predicate injected → fail)", () => {
  const block = wireCodexDecisionGuard(
    allDeferredBlock(),
    "provenance-capture-tool.js@codex-mcp-guard",
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: alwaysPresent,
    hookEmitsKind: () => true,
    // guardCapturesHook intentionally omitted → defaults to () => false
  });
  const cell = results.find((r) => r.artifact === "codex:Decision");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /codex-mcp-guard does NOT capture/);
});

// Builds a self-contained repo root with a fake guard exporting `captureTools`
// (separate temp dir per call so the validator's createRequire cache — keyed by
// absolute path — never serves a stale guard between the pass + fail variants).
function mkGuardRepo(captureTools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provparity-guard-"));
  const mk = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  mk(".claude/hooks/cap.js", 'function c(){ return { kind: "Decision" }; }\nmodule.exports={c};');
  mk(
    ".claude/codex-mcp-guard/server.js",
    `module.exports = { CAPTURE_HOOKS: ["cap.js"], CAPTURE_TOOLS: ${JSON.stringify(captureTools)} };`,
  );
  mk(".codex/hooks.json", JSON.stringify({ hooks: {} })); // NOT registered natively
  mk(".gemini/settings.json", JSON.stringify({ hooks: {} }));
  mk(
    ".claude/sync-manifest.yaml",
    [
      "parity_enforcement:",
      "  provenance_parity:",
      "    enabled: true",
      "    cc_capture:",
      '      - "Decision|cap.js|PreToolUse"',
      "    lanes:",
      '      - "codex|Decision|wired|cap.js@codex-mcp-guard|apply_patch → Decision"',
      '      - "gemini|Decision|deferred|#411|gemini Decision deferred"',
      "tiers:",
      "  cc:",
      "    - x/**",
    ].join("\n"),
  );
  return dir;
}

test("G7 INTEGRATION wired-IO: real server.js CAPTURE exports drive guardCapturesHook", () => {
  // PASS variant — guard captures cap.js on apply_patch.
  const okDir = mkGuardRepo(["apply_patch"]);
  const codex = checkProvenanceParity(okDir).results.find(
    (r) => r.artifact === "codex:Decision",
  );
  assert.equal(codex.status, "pass", `guard-IO must pass: ${JSON.stringify(codex)}`);
  assert.match(codex.detail, /via codex-mcp-guard/);
  fs.rmSync(okDir, { recursive: true, force: true });

  // FAIL variant — guard exports no CAPTURE_TOOLS → wired must FAIL.
  const badDir = mkGuardRepo([]);
  const codex2 = checkProvenanceParity(badDir).results.find(
    (r) => r.artifact === "codex:Decision",
  );
  assert.equal(codex2.status, "fail", `guard-without-tools must fail: ${JSON.stringify(codex2)}`);
  assert.match(codex2.detail, /codex-mcp-guard does NOT capture/);
  fs.rmSync(badDir, { recursive: true, force: true });
});

// ===========================================================================
//  P3 — wired + hook ABSENT → fail (declared-wired-but-absent = a lie)
// ===========================================================================
test("P3 wired but hook absent in emit target → fail", () => {
  const block = allDeferredBlock();
  block.lanes = block.lanes.map((c) =>
    c.lane === "gemini" && c.kind === "Decision"
      ? { ...c, status: "wired", f4: "provenance-capture-tool.js", f5: "BeforeTool" }
      : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent, // emit target has no such hook
    hookEmitsKind: () => true, // never reached — presence-fail dominates
  });
  const cell = results.find((r) => r.artifact === "gemini:Decision");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /declared wired .* NOT registered/i);
});

// ===========================================================================
//  P4 — deferred without #NNN tracking → fail
// ===========================================================================
test("P4 deferred without #NNN tracking → fail", () => {
  const block = allDeferredBlock();
  block.lanes = block.lanes.map((c) =>
    c.lane === "codex" && c.kind === "HumanInput" ? { ...c, f4: "" } : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  const cell = results.find((r) => r.artifact === "codex:HumanInput");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /#NNN tracking/);
});

// ===========================================================================
//  P5 — undeclared (lane,kind) where CC captures the kind → SILENT DROP fail
// ===========================================================================
test("P5 captured kind with no lane declaration → SILENT DROP fail", () => {
  const block = allDeferredBlock();
  // Drop the gemini|Delegation cell entirely.
  block.lanes = block.lanes.filter((c) => !(c.lane === "gemini" && c.kind === "Delegation"));
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  const cell = results.find((r) => r.artifact === "gemini:Delegation");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /SILENT DROP/);
});

// ===========================================================================
//  P6 — cc_capture set drifts from hook-emitted kinds → byte-exact seam fail
// ===========================================================================
test("P6 cc_capture declares a kind the hooks do not emit → drift fail", () => {
  const block = allDeferredBlock();
  // Hooks only emit 3 kinds (Delegation removed from extraction), but cc_capture
  // still declares 4 → byte-exact drift.
  const ex = extraction4();
  ex.kinds = new Set(["HumanInput", "Action", "Decision"]);
  ex.byHook.set("provenance-capture-tool.js", new Set(["Action", "Decision"]));
  const results = evaluateProvenanceParity({
    block,
    extraction: ex,
    laneHookPresent: neverPresent,
  });
  const drift = results.find((r) => /byte-exact seam/.test(r.detail || ""));
  assert.ok(drift, "expected a byte-exact drift finding");
  assert.equal(drift.status, "fail");
});

// ===========================================================================
//  P7 — hook emits a kind outside EVENT_KINDS → fail
// ===========================================================================
test("P7 hook emits kind outside EVENT_KINDS → fail", () => {
  const block = allDeferredBlock();
  const ex = extraction4();
  ex.kinds.add("Telemetry"); // not in the closed taxonomy
  ex.byHook.get("provenance-capture-tool.js").add("Telemetry");
  const results = evaluateProvenanceParity({
    block,
    extraction: ex,
    laneHookPresent: neverPresent,
  });
  const bad = results.find((r) => r.artifact === "hook-kind:Telemetry");
  assert.ok(bad, "expected a hook-kind finding for Telemetry");
  assert.equal(bad.status, "fail");
  assert.match(bad.detail, /outside provenance-event\.js::EVENT_KINDS/);
});

// ===========================================================================
//  P8 — orphan lane declarations → fail
// ===========================================================================
test("P8a lane decl for a kind CC does not capture → fail", () => {
  const block = allDeferredBlock();
  block.lanes.push({
    lane: "codex",
    kind: "Telemetry",
    status: "deferred",
    f4: "#411",
    f5: "x",
    raw: "codex|Telemetry|deferred|#411|x",
  });
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  const orphan = results.find((r) => /CC does not capture/.test(r.detail || ""));
  assert.ok(orphan, "expected an uncaptured-kind orphan finding");
  assert.equal(orphan.status, "fail");
});

test("P8b lane decl for an unknown lane → fail", () => {
  const block = allDeferredBlock();
  block.lanes.push({
    lane: "windsurf",
    kind: "Action",
    status: "deferred",
    f4: "#411",
    f5: "x",
    raw: "windsurf|Action|deferred|#411|x",
  });
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  const orphan = results.find((r) => /not a target lane/.test(r.detail || ""));
  assert.ok(orphan, "expected an unknown-lane orphan finding");
  assert.equal(orphan.status, "fail");
});

// ===========================================================================
//  P9 — block absent → single fail
// ===========================================================================
test("P9 absent block → fail", () => {
  const results = evaluateProvenanceParity({
    block: null,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "fail");
  assert.match(results[0].detail, /block absent/);
});

// ===========================================================================
//  P10 — enabled:false → skip
// ===========================================================================
test("P10 enabled:false → skip (non-blocking)", () => {
  const block = allDeferredBlock();
  block.enabled = false;
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "skip");
});

// ===========================================================================
//  P11 — cc_capture empty + enabled → fail
// ===========================================================================
test("P11 enabled with empty cc_capture → fail", () => {
  const block = { present: true, enabled: true, ccCapture: [], lanes: [] };
  const results = evaluateProvenanceParity({
    block,
    extraction: { kinds: new Set(), byHook: new Map(), errors: [] },
    laneHookPresent: neverPresent,
  });
  assert.ok(fails(results).some((r) => /cc_capture is empty/.test(r.detail)));
});

// ===========================================================================
//  P12 — unknown status (not wired|deferred) → fail
// ===========================================================================
test("P12 unknown lane status → fail", () => {
  const block = allDeferredBlock();
  block.lanes = block.lanes.map((c) =>
    c.lane === "codex" && c.kind === "Action" ? { ...c, status: "maybe" } : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: neverPresent,
  });
  const cell = results.find((r) => r.artifact === "codex:Action");
  assert.equal(cell.status, "fail");
  assert.match(cell.detail, /unknown status "maybe"/);
});

// ===========================================================================
//  Parser tests — parseProvenanceParity
// ===========================================================================
test("parseProvenanceParity parses a well-formed block and terminates at the next key", () => {
  const yaml = [
    "parity_enforcement:",
    "  block_on_violation: true",
    "  provenance_parity:",
    "    enabled: true",
    "    cc_capture:",
    '      - "HumanInput|provenance-capture-prompt.js|UserPromptSubmit"',
    '      - "Action|provenance-capture-tool.js|PreToolUse"',
    "    lanes:",
    '      - "codex|HumanInput|deferred|#411|reason with | a pipe and (parens)"',
    '      - "gemini|Action|wired|provenance-capture-tool.js|BeforeTool"',
    "tiers:",
    "  cc:",
    "    - some/glob/**",
  ].join("\n");
  const b = parseProvenanceParity(yaml);
  assert.ok(b, "block should parse");
  assert.equal(b.enabled, true);
  assert.equal(b.ccCapture.length, 2);
  assert.deepEqual(b.ccCapture[0], {
    kind: "HumanInput",
    hook: "provenance-capture-prompt.js",
    event: "UserPromptSubmit",
    raw: "HumanInput|provenance-capture-prompt.js|UserPromptSubmit",
  });
  assert.equal(b.lanes.length, 2, "must NOT slurp the tiers: block");
  // reason field preserves embedded pipes (parts.slice(4).join("|")).
  assert.equal(b.lanes[0].f5, "reason with | a pipe and (parens)");
  assert.equal(b.lanes[1].status, "wired");
  assert.equal(b.lanes[1].f4, "provenance-capture-tool.js");
  assert.equal(b.lanes[1].f5, "BeforeTool");
});

test("parseProvenanceParity returns null when the block is absent", () => {
  assert.equal(parseProvenanceParity("parity_enforcement:\n  block_on_violation: true\n"), null);
  assert.equal(parseProvenanceParity(null), null);
});

// ===========================================================================
//  collectHookCommands
// ===========================================================================
test("collectHookCommands extracts command strings; [] on parse failure", () => {
  const doc = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "node ./.claude/hooks/validate-bash-command.js" }] }],
      UserPromptSubmit: [],
    },
  });
  const cmds = collectHookCommands(doc);
  assert.ok(cmds.some((c) => c.includes("validate-bash-command.js")));
  assert.deepEqual(collectHookCommands("{ not json"), []);
  assert.deepEqual(collectHookCommands(null), []);
});

// ===========================================================================
//  R1 redteam fixes — wired f4 hardening + extraction robustness + wired-IO e2e
// ===========================================================================

// HIGH-1: a wired cell whose f4 is a GENERIC token (not a bare hook filename)
// MUST FAIL the shape gate even when the (lying) oracle reports present — closes
// the unanchored-substring false-pass (security R1 HIGH).
for (const badF4 of [".js", "node", "hooks", ".claude", "validate"]) {
  test(`R1-HIGH wired f4="${badF4}" (generic token) → fail even with present oracle`, () => {
    const block = allDeferredBlock();
    block.lanes = block.lanes.map((c) =>
      c.lane === "codex" && c.kind === "Action"
        ? { ...c, status: "wired", f4: badF4, f5: "x" }
        : c,
    );
    const results = evaluateProvenanceParity({
      block,
      extraction: extraction4(),
      laneHookPresent: alwaysPresent, // lie: oracle says present
    });
    const cell = results.find((r) => r.artifact === "codex:Action");
    assert.equal(cell.status, "fail", JSON.stringify(cell));
    assert.match(cell.detail, /bare hook filename/);
  });
}

// LOW-2: a wired cell with an EMPTY f4 hook MUST FAIL (shape gate), even when the
// oracle reports present.
test("R1-LOW wired with empty f4 → fail (shape gate short-circuit)", () => {
  const block = allDeferredBlock();
  block.lanes = block.lanes.map((c) =>
    c.lane === "gemini" && c.kind === "HumanInput"
      ? { ...c, status: "wired", f4: "", f5: "x" }
      : c,
  );
  const results = evaluateProvenanceParity({
    block,
    extraction: extraction4(),
    laneHookPresent: alwaysPresent,
  });
  const cell = results.find((r) => r.artifact === "gemini:HumanInput");
  assert.equal(cell.status, "fail", JSON.stringify(cell));
  assert.match(cell.detail, /bare hook filename/);
});

// MED-1: extractHookKinds strips comments (a doc-comment kind must NOT pollute the
// extracted set — neither over-match nor drift-mask) AND accepts single-quote
// emission forms.
test("R1-MED extractHookKinds ignores comment-kinds, reads single-quote emissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provparity-"));
  const hooksDir = path.join(dir, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, "synthetic-capture.js"),
    [
      "// historical: kind: \"Telemetry\"  ← comment, MUST NOT be extracted",
      "/* block: kind: \"Bogus\" still a comment */",
      "function classify() {",
      "  if (x) return { kind: 'Decision', payload };  // single-quote emission",
      '  return { kind: "Action", payload };',
      "}",
    ].join("\n"),
  );
  const ex = extractHookKinds(dir, [
    { kind: "Action", hook: "synthetic-capture.js", event: "PreToolUse" },
  ]);
  assert.deepEqual(ex.errors, []);
  const got = [...ex.kinds].sort();
  assert.deepEqual(got, ["Action", "Decision"], `comment-kinds leaked or single-quote missed: ${JSON.stringify(got)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// LOW-3: end-to-end wired-IO path — a real .codex/hooks.json registering a hook +
// a manifest cell wired to it → checkProvenanceParity PASS (exercises the real
// collectHookCommands → segment-anchored laneHookPresent, not the injected oracle).
test("R1-LOW INTEGRATION wired-IO: real .codex hook + wired cell → pass; absent → fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provparity-e2e-"));
  const mk = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  // one capture hook emitting a single kind
  mk(".claude/hooks/cap.js", 'function c(){ return { kind: "Action" }; }');
  // .codex/hooks.json registering cap.js under shell
  mk(
    ".codex/hooks.json",
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "node ./.claude/hooks/cap.js" }] }] },
    }),
  );
  mk(".gemini/settings.json", JSON.stringify({ hooks: {} }));
  // manifest: cc_capture(Action→cap.js); codex|Action WIRED to cap.js; gemini|Action DEFERRED
  mk(
    ".claude/sync-manifest.yaml",
    [
      "parity_enforcement:",
      "  provenance_parity:",
      "    enabled: true",
      "    cc_capture:",
      '      - "Action|cap.js|PreToolUse"',
      "    lanes:",
      '      - "codex|Action|wired|cap.js|shell"',
      '      - "gemini|Action|deferred|#411|gemini Action deferred"',
      "tiers:",
      "  cc:",
      "    - x/**",
    ].join("\n"),
  );
  const out = checkProvenanceParity(dir);
  const codex = out.results.find((r) => r.artifact === "codex:Action");
  const gemini = out.results.find((r) => r.artifact === "gemini:Action");
  assert.equal(codex.status, "pass", `codex wired-IO must pass: ${JSON.stringify(codex)}`);
  assert.equal(gemini.status, "skip", `gemini deferred must skip: ${JSON.stringify(gemini)}`);

  // Now flip codex to a hook the emit target does NOT register → must FAIL.
  fs.writeFileSync(
    path.join(dir, ".claude", "sync-manifest.yaml"),
    fs.readFileSync(path.join(dir, ".claude", "sync-manifest.yaml"), "utf8").replace("wired|cap.js|shell", "wired|absent-hook.js|shell"),
  );
  // absent-hook.js must also exist as a cc_capture-declared file? No — it's a wired
  // target only; the presence oracle checks the emit target, which lacks it → FAIL.
  const out2 = checkProvenanceParity(dir);
  const codex2 = out2.results.find((r) => r.artifact === "codex:Action");
  assert.equal(codex2.status, "fail", `wired-but-absent must fail: ${JSON.stringify(codex2)}`);
  assert.match(codex2.detail, /NOT registered/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// R2-MED INTEGRATION: wired to a REGISTERED-but-non-capture hook (emits no kind)
// → FAIL at the real IO entry point (closes the security R2 MED end-to-end, not
// just via injected oracle).
test("R2-MED INTEGRATION wired-to-registered-non-capture hook → fail (does not emit)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provparity-med-"));
  const mk = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  mk(".claude/hooks/cap.js", 'function c(){ return { kind: "Action" }; }');
  // noise.js is a REAL registered hook that emits NO provenance kind.
  mk(".claude/hooks/noise.js", 'function n(){ return { ok: true }; }');
  mk(
    ".codex/hooks.json",
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "shell", hooks: [{ type: "command", command: "node ./.claude/hooks/cap.js" }] },
          { matcher: "shell", hooks: [{ type: "command", command: "node ./.claude/hooks/noise.js" }] },
        ],
      },
    }),
  );
  mk(".gemini/settings.json", JSON.stringify({ hooks: {} }));
  mk(
    ".claude/sync-manifest.yaml",
    [
      "parity_enforcement:",
      "  provenance_parity:",
      "    enabled: true",
      "    cc_capture:",
      '      - "Action|cap.js|PreToolUse"',
      "    lanes:",
      // wired to noise.js — registered, but emits no Action kind
      '      - "codex|Action|wired|noise.js|shell"',
      '      - "gemini|Action|deferred|#411|gemini Action deferred"',
      "tiers:",
      "  cc:",
      "    - x/**",
    ].join("\n"),
  );
  const out = checkProvenanceParity(dir);
  const codex = out.results.find((r) => r.artifact === "codex:Action");
  assert.equal(codex.status, "fail", `registered-but-non-capture must fail: ${JSON.stringify(codex)}`);
  assert.match(codex.detail, /does NOT emit provenance kind/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
//  Integration — the LIVE repo: hooks really emit the 4 kinds; check passes
// ===========================================================================
test("INTEGRATION extractHookKinds(live repo) == the 4 closed-taxonomy kinds", () => {
  const ex = extractHookKinds(REPO_ROOT, CC_CAPTURE_4);
  assert.deepEqual(ex.errors, [], "capture hooks must exist on disk");
  assert.deepEqual([...ex.kinds].sort(), ["Action", "Decision", "Delegation", "HumanInput"]);
});

test("INTEGRATION checkProvenanceParity(live repo) → 0 blocking; item 1 + #440 wired 4 cells", () => {
  const out = checkProvenanceParity(REPO_ROOT);
  assert.equal(out.id, "provenance-parity");
  const t = tally(out.results);
  assert.equal(t.fail, 0, `live repo must have 0 provenance-parity fails, got ${JSON.stringify(fails(out.results))}`);
  // F101 item 1 (PR #439): 3 cells wired (codex·Action via PreToolUse shell,
  // gemini·Action + gemini·Decision via BeforeTool). #440 (this shard): a 4th —
  // codex·Decision via the codex-mcp-guard apply_patch capture side-effect.
  // 4 cells stay deferred with honest reasons (journal/0216 + journal/0218).
  assert.equal(t.pass, 4, "4 cells wired (item 1 = 3, #440 = codex·Decision)");
  assert.equal(t.skip, 4, "4 cells remain deferred (honest, #411-tracked)");
  const wired = (lane, kind) =>
    out.results.find((r) => r.artifact === `${lane}:${kind}`);
  assert.equal(wired("codex", "Action").status, "pass");
  assert.equal(wired("gemini", "Action").status, "pass");
  assert.equal(wired("gemini", "Decision").status, "pass");
  // #440: codex·Decision wired via the @codex-mcp-guard mechanism.
  assert.equal(wired("codex", "Decision").status, "pass");
  assert.match(
    wired("codex", "Decision").detail,
    /via codex-mcp-guard/,
    "codex·Decision must pass via the guard mechanism, not the native shell registration",
  );
  // the 4 honest-deferred cells stay SKIP
  for (const [lane, kind] of [
    ["codex", "HumanInput"],
    ["codex", "Delegation"],
    ["gemini", "HumanInput"],
    ["gemini", "Delegation"],
  ]) {
    assert.equal(wired(lane, kind).status, "skip", `${lane}:${kind} deferred`);
  }
});
