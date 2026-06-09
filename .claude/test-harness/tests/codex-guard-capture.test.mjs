#!/usr/bin/env node
/*
 * F101 item 1 #440 — codex·Decision capture via the codex-mcp-guard
 * (loom#411 governance-as-DNA, loom lane). Tier 1, deterministic, no network.
 *
 * apply_patch is the ONE wrapped Codex tool with NO native hook (codex#16732),
 * so journal-DECISION + file-write Action capture on Codex rides server.js, not
 * .codex/hooks.json. These tests PROVE the runtime chain end-to-end: the guard
 * synthesizes a CC-shaped payload from the apply_patch V4A envelope, spawns
 * provenance-capture-tool.js as a NON-BLOCKING side-effect, and the hook writes
 * the Action / Decision event to the per-session ledger. This is the "runtime
 * capture proven" gate the #440 manifest flip requires (journal/0218).
 *
 * Predicate matrix:
 *   P1 parseApplyPatchTargets — Update/Add/Delete/Move; key-robust; multi-file
 *   P2 synthesizeCaptureInput — DECISION-prefer / Action / no-path / non-apply_patch
 *   P3 runProvenanceCapture e2e — apply_patch journal-DECISION → Decision in ledger
 *   P4 runProvenanceCapture e2e — apply_patch regular file → Action in ledger
 *   P5 runProvenanceCapture — shell / unified_exec → no-op (no double-capture)
 *   P6 runProvenanceCapture — never throws, returns a result, never denies
 *
 * Run: node --test .claude/test-harness/tests/codex-guard-capture.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const guard = require(
  path.join(REPO_ROOT, ".claude", "codex-mcp-guard", "server.js"),
);
const { parseApplyPatchTargets, synthesizeCaptureInput, runProvenanceCapture } =
  guard;
const { _ledgerPath } = require(
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "provenance-ledger.js"),
);

// Deterministic identity for the spawned hook (it reads these env vars).
const ID_ENV = {
  COC_TEST_FINGERPRINT: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  COC_TEST_PERSON_ID: "pid-maintainer-10e7dd16",
};

function patch(target, kind = "Update") {
  return `*** Begin Patch\n*** ${kind} File: ${target}\n@@\n+example line\n*** End Patch`;
}

function readLedgerEvents(repoDir, session) {
  const p = _ledgerPath(repoDir, session);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ===========================================================================
//  P1 — parseApplyPatchTargets: V4A markers, key-robust, multi-file
// ===========================================================================
test("P1a extracts Update/Add/Delete/Move File targets", () => {
  assert.deepEqual(parseApplyPatchTargets({ input: patch("a/b.py", "Update") }), [
    "a/b.py",
  ]);
  assert.deepEqual(parseApplyPatchTargets({ input: patch("a/b.py", "Add") }), [
    "a/b.py",
  ]);
  assert.deepEqual(parseApplyPatchTargets({ input: patch("a/b.py", "Delete") }), [
    "a/b.py",
  ]);
  assert.deepEqual(
    parseApplyPatchTargets({ input: "*** Begin Patch\n*** Move to: x/y.md\n*** End Patch" }),
    ["x/y.md"],
  );
});

test("P1b key-robust — patch text under any key OR bare string OR nested", () => {
  const t = "journal/0001-maintainer-DECISION-x.md";
  assert.deepEqual(parseApplyPatchTargets({ input: patch(t) }), [t]);
  assert.deepEqual(parseApplyPatchTargets({ patch: patch(t) }), [t]);
  assert.deepEqual(parseApplyPatchTargets({ content: patch(t) }), [t]);
  assert.deepEqual(parseApplyPatchTargets(patch(t)), [t]); // bare string
  assert.deepEqual(parseApplyPatchTargets({ a: { b: { c: patch(t) } } }), [t]); // nested
});

test("P1c multi-file patch returns all distinct targets in order", () => {
  const multi =
    "*** Begin Patch\n*** Add File: src/foo.py\n@@\n+y\n*** Update File: journal/0002-maintainer-DECISION-z.md\n@@\n+w\n*** End Patch";
  assert.deepEqual(parseApplyPatchTargets({ input: multi }), [
    "src/foo.py",
    "journal/0002-maintainer-DECISION-z.md",
  ]);
});

test("P1d no V4A markers / empty → [] (caller degrades to Action)", () => {
  assert.deepEqual(parseApplyPatchTargets({ foo: "bar" }), []);
  assert.deepEqual(parseApplyPatchTargets({}), []);
  assert.deepEqual(parseApplyPatchTargets(null), []);
  assert.deepEqual(parseApplyPatchTargets({ input: "no markers here" }), []);
});

// ===========================================================================
//  P2 — synthesizeCaptureInput: DECISION-prefer / Action / no-path / non-apply_patch
// ===========================================================================
test("P2a apply_patch on a journal-DECISION path → {file_path} (→ Decision)", () => {
  const out = synthesizeCaptureInput("apply_patch", {
    input: patch("journal/0003-maintainer-DECISION-x.md"),
  });
  assert.equal(out.file_path, "journal/0003-maintainer-DECISION-x.md");
});

test("P2b apply_patch on a regular file → {file_path} (→ Action)", () => {
  const out = synthesizeCaptureInput("apply_patch", { input: patch("src/foo.py") });
  assert.equal(out.file_path, "src/foo.py");
});

test("P2c multi-file patch PREFERS the journal-DECISION target", () => {
  const multi =
    "*** Begin Patch\n*** Add File: src/foo.py\n*** Update File: journal/0004-maintainer-DECISION-z.md\n*** End Patch";
  const out = synthesizeCaptureInput("apply_patch", { input: multi });
  assert.equal(out.file_path, "journal/0004-maintainer-DECISION-z.md");
});

test("P2d apply_patch with no extractable path → {} (classify → Action default)", () => {
  assert.deepEqual(synthesizeCaptureInput("apply_patch", { foo: "bar" }), {});
});

test("P2e non-apply_patch tool → {} (defense-in-depth: NEVER forward raw input)", () => {
  // Returns {} not the raw input so a future CAPTURE_TOOLS widening to a
  // command-bearing tool cannot leak a raw argv (carrying secret values) to the
  // ledger through this path (security R1 LOW, journal/0219).
  assert.deepEqual(synthesizeCaptureInput("shell", { command: "ls" }), {});
});

// ===========================================================================
//  P3 / P4 — runProvenanceCapture END-TO-END: guard → hook subprocess → ledger
// ===========================================================================
function withTmpRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cap-"));
  const prev = { ...process.env };
  Object.assign(process.env, ID_ENV);
  try {
    return fn(dir);
  } finally {
    process.env = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("P3 apply_patch on a journal-DECISION path → Decision event lands in the ledger", () => {
  withTmpRepo((dir) => {
    const session = "sess-decision";
    const r = runProvenanceCapture({
      tool: "apply_patch",
      input: { input: patch("journal/0005-maintainer-DECISION-foo.md") },
      session_id: session,
      cwd: dir,
    });
    assert.equal(r.captured, true, JSON.stringify(r));
    const events = readLedgerEvents(dir, session);
    assert.equal(events.length, 1, "exactly one event captured");
    assert.equal(events[0].kind, "Decision", JSON.stringify(events[0]));
    assert.match(events[0].payload.journal_path, /0005-maintainer-DECISION-foo\.md$/);
  });
});

test("P4 apply_patch on a regular file → Action event lands in the ledger", () => {
  withTmpRepo((dir) => {
    const session = "sess-action";
    const r = runProvenanceCapture({
      tool: "apply_patch",
      input: { input: patch("src/widget.py") },
      session_id: session,
      cwd: dir,
    });
    assert.equal(r.captured, true, JSON.stringify(r));
    const events = readLedgerEvents(dir, session);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "Action", JSON.stringify(events[0]));
    assert.match(events[0].payload.file_path, /widget\.py$/);
  });
});

test("P4b apply_patch with no extractable path → Action (no file_path), never fake", () => {
  withTmpRepo((dir) => {
    const session = "sess-nopath";
    const r = runProvenanceCapture({
      tool: "apply_patch",
      input: { opaque: 1 },
      session_id: session,
      cwd: dir,
    });
    assert.equal(r.captured, true);
    const events = readLedgerEvents(dir, session);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "Action");
  });
});

// ===========================================================================
//  P5 — shell / unified_exec are NOT captured by the guard (no double-capture;
//       they capture via the native .codex/hooks.json shell registration)
// ===========================================================================
for (const tool of ["shell", "unified_exec"]) {
  test(`P5 ${tool} → guard capture is a no-op (no ledger write, no double-capture)`, () => {
    withTmpRepo((dir) => {
      const session = `sess-${tool}`;
      const r = runProvenanceCapture({
        tool,
        input: { command: "echo hi" },
        session_id: session,
        cwd: dir,
      });
      assert.equal(r.captured, false);
      assert.equal(r.reason, "tool-not-in-capture-scope");
      assert.deepEqual(readLedgerEvents(dir, session), []);
    });
  });
}

// ===========================================================================
//  P6 — runProvenanceCapture is non-blocking: never throws, never denies
// ===========================================================================
test("P6 never throws on a malformed input; returns a result object", () => {
  withTmpRepo((dir) => {
    // Circular object would throw in JSON.stringify inside the spawn; the guard
    // MUST swallow it (capture is best-effort, NEVER blocks the tool call).
    const circular = {};
    circular.self = circular;
    let r;
    assert.doesNotThrow(() => {
      r = runProvenanceCapture({
        tool: "apply_patch",
        input: circular,
        session_id: "sess-circular",
        cwd: dir,
      });
    });
    assert.equal(typeof r, "object");
    // captured may be false (degraded); the contract is "no throw, no deny".
    assert.notEqual(r.verdict, "deny");
  });
});

// ===========================================================================
//  P7 — SECRETS FENCE: patch CONTENT (secret values in added lines) NEVER
//       reaches the ledger. Only the V4A target path survives (security.md
//       "no secrets in logs"). Committed regression lock for the fence the
//       redteam proved manually each round (cc-architect R3 LOW, journal/0219).
// ===========================================================================
test("P7 apply_patch with secrets in added lines → ledger holds ONLY file_path, no secret", () => {
  withTmpRepo((dir) => {
    const session = "sess-secrets";
    const secretPatch = [
      "*** Begin Patch",
      "*** Update File: src/config.py",
      "@@",
      '+OPENAI_API_KEY = "sk-PROD-SUPERSECRET-9999"',
      '+DATABASE_URL = "postgres://admin:hunter2@db/prod"',
      "*** End Patch",
    ].join("\n");
    const r = runProvenanceCapture({
      tool: "apply_patch",
      input: { input: secretPatch },
      session_id: session,
      cwd: dir,
    });
    assert.equal(r.captured, true, JSON.stringify(r));
    const events = readLedgerEvents(dir, session);
    assert.equal(events.length, 1);
    // The intended capture: only the target path.
    assert.equal(events[0].kind, "Action");
    assert.match(events[0].payload.file_path, /config\.py$/);
    // The fence: NO secret value, NO patch marker, anywhere in the raw ledger bytes.
    const raw = JSON.stringify(events[0]);
    for (const leak of [
      "sk-PROD-SUPERSECRET-9999",
      "hunter2",
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "Begin Patch",
      "@@",
    ]) {
      assert.ok(
        !raw.includes(leak),
        `secrets-fence breach: ledger leaked "${leak}" — ${raw}`,
      );
    }
  });
});
