/**
 * Tier-2 integration tests for shard C2 (workspaces/multi-operator-coc,
 * design v11 §4.3 § R6-C-02) — posture-gate.js v2 deny-list integration.
 *
 * Tests at: tests/integration/multi-operator/posture-gate-v2.test.js
 *
 * Per the shard contract (workspaces/multi-operator-coc/todos/active/
 * 00-todos.md § C2):
 *
 *   (3) posture-gate.js deny-list (R6-C-02): posture.json writes blocked
 *       at the file-system layer via settings.json::permissions.deny;
 *       the hook itself does NOT enforce — settings.json does — but the
 *       hook MUST surface a clear halt-and-report payload if a tool
 *       tries to Write/Edit posture.json AND the deny rule somehow
 *       doesn't fire (defense-in-depth).
 *
 * Run: node --test tests/integration/multi-operator/posture-gate-v2.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "posture-gate.js");
const SETTINGS_PATH = path.join(REPO_ROOT, ".claude", "settings.json");

function runHook(payload) {
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
  });
  let stdoutJson = null;
  try {
    stdoutJson = JSON.parse(result.stdout.trim().split("\n").pop());
  } catch {
    stdoutJson = null;
  }
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: stdoutJson,
  };
}

// ---- R6-C-02: settings.json deny-list -------------------------------------

test("posture_json_writes_denied_by_settings_json", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  assert.ok(settings.permissions, "settings.json::permissions missing");
  assert.ok(Array.isArray(settings.permissions.deny), "permissions.deny is not an array");
  const denySet = new Set(settings.permissions.deny);
  // R6-C-02: posture.json + violations.jsonl + .initialized — already covered
  // by the trust-posture rule's existing entries. Add cross-check that the
  // patterns Write+Edit BOTH appear for posture.json.
  const required = [
    "Write(.claude/learning/posture.json)",
    "Edit(.claude/learning/posture.json)",
    "Write(.claude/learning/violations.jsonl)",
    "Edit(.claude/learning/violations.jsonl)",
  ];
  for (const pattern of required) {
    assert.ok(
      denySet.has(pattern),
      `settings.json::permissions.deny missing required pattern: ${pattern}`,
    );
  }
});

// ---- defense-in-depth halt path -------------------------------------------

test("posture_gate_halts_on_write_to_posture_json_defense_in_depth", () => {
  // If a tool somehow reaches PreToolUse with Write target = posture.json
  // (e.g. settings.json malformed), posture-gate MUST surface a clear halt.
  // Per instruct-and-wait: halt-and-report exits 0 + continue=true but
  // surfaces the structured handoff on validation + stderr.
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: path.join(REPO_ROOT, ".claude", "learning", "posture.json"),
      content: "{}",
    },
    cwd: REPO_ROOT,
  });
  assert.equal(out.code, 0);
  // Defense-in-depth halt MUST surface the rule citation + the path.
  const validation =
    out.json && out.json.hookSpecificOutput && out.json.hookSpecificOutput.validation;
  assert.ok(validation, "validation body missing");
  assert.match(validation, /posture\.json|R6-C-02|trust-posture/i);
  assert.match(validation, /Defense-in-depth/);
  // user_summary surfaces on stderr.
  assert.match(out.stderr, /posture-gate R6-C-02 halted/);
});

test("posture_gate_halts_on_edit_to_violations_jsonl_defense_in_depth", () => {
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(REPO_ROOT, ".claude", "learning", "violations.jsonl"),
      old_string: "x",
      new_string: "y",
    },
    cwd: REPO_ROOT,
  });
  assert.equal(out.code, 0);
  assert.match(out.stderr, /posture-gate R6-C-02 halted/);
});

test("posture_gate_passthrough_on_unrelated_edit", () => {
  // A normal Edit on an unrelated file MUST passthrough.
  const out = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(REPO_ROOT, "README.md"),
      old_string: "x",
      new_string: "y",
    },
    cwd: REPO_ROOT,
  });
  // The L5 default posture allows passthrough on Edit/Write for unrelated
  // paths (M0/C1 contract).
  assert.equal(out.code, 0);
});
