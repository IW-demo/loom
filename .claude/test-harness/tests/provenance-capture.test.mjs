#!/usr/bin/env node
/*
 * F101-2 — Claude Code capture hooks (loom#411, governance-as-DNA loom lane).
 *
 * F101-1 shipped the event FORMAT (provenance-event.js). F101-2 ships the hooks
 * that PRODUCE events through it, into a SEPARATE per-session local ledger (the
 * degraded-local-ledger half of the loom↔csq seam; csq drains + signs it).
 *
 * Pinned invariants:
 *   1. classify() kind dispatch: Task→Delegation, journal-DECISION write→Decision,
 *      mutation||Bash→Action, read-path→skip.
 *   2. SECRETS FENCE: raw prompt / Bash command / Task prompt are hashed, never
 *      stored verbatim; file_path / subagent_type are kept (accountability).
 *   3. operator_ref projection + attribution: verified / unrostered / unidentified
 *      (#411 "never silently mis-attributed").
 *   4. chain continuity: genesis null → hash → hash; corrupt last line → LOUD
 *      chain_reset_reason, never a silent fork.
 *   5. end-to-end walk: hooks never block ({continue:true}); the ledger lands the
 *      right chained, schema-valid, secret-free events.
 *
 * Run: node --test .claude/test-harness/tests/provenance-capture.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.resolve(__dirname, "../../hooks");

const ledgerLib = require("../../hooks/lib/provenance-ledger.js");
const {
  captureProvenance,
  _projectOperatorRef,
  _deriveChainHead,
  _ledgerPath,
  _relativizePath,
} = ledgerLib;
const { classify } = require("../../hooks/provenance-capture-tool.js");
const pe = require("../../hooks/lib/provenance-event.js");

const ID = {
  verified_id: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  person_id: "pid-maintainer-10e7dd16",
  display_id: "maintainer",
};
const TS = "2026-06-01T12:00:00Z";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prov-f101-2-"));
}

// ── 1. classify() kind dispatch ─────────────────────────────────────────────

test("classify: Task → Delegation, prompt hashed, subagent_type kept", () => {
  const r = classify("Task", {
    subagent_type: "reviewer",
    description: "review the diff",
    prompt: "SECRET-PROMPT-TEXT do the review",
  });
  assert.equal(r.kind, "Delegation");
  assert.equal(r.payload.subagent_type, "reviewer");
  assert.equal(r.payload.description_chars, "review the diff".length);
  assert.match(r.payload.prompt_sha256, /^[0-9a-f]{64}$/);
  // secrets fence: no raw prompt text anywhere in the payload
  assert.ok(!JSON.stringify(r.payload).includes("SECRET-PROMPT-TEXT"));
});

test("classify: mutation write to journal DECISION → Decision", () => {
  const r = classify("Write", {
    file_path: "/repo/journal/0192-maintainer-DECISION-foo.md",
  });
  assert.equal(r.kind, "Decision");
  assert.ok(r.payload.journal_path.endsWith("DECISION-foo.md"));
});

test("classify: legacy journal DECISION filename → Decision", () => {
  const r = classify("Edit", { file_path: "journal/0042-DECISION-topic.md" });
  assert.equal(r.kind, "Decision");
});

test("classify: mutation write to non-journal → Action with file_path", () => {
  const r = classify("Write", { file_path: "/repo/src/foo.js" });
  assert.equal(r.kind, "Action");
  assert.equal(r.payload.file_path, "/repo/src/foo.js");
});

test("classify: NotebookEdit uses notebook_path", () => {
  const r = classify("NotebookEdit", { notebook_path: "/repo/nb.ipynb" });
  assert.equal(r.kind, "Action");
  assert.equal(r.payload.file_path, "/repo/nb.ipynb");
});

test("classify: Bash → Action, command hashed not stored raw", () => {
  const r = classify("Bash", {
    command: "export TOKEN=sk-LEAKME123 && echo hi",
  });
  assert.equal(r.kind, "Action");
  assert.match(r.payload.command_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    r.payload.command_chars,
    "export TOKEN=sk-LEAKME123 && echo hi".length,
  );
  assert.ok(!JSON.stringify(r.payload).includes("sk-LEAKME123"));
});

test("classify: read-path tools → skip (null)", () => {
  for (const t of ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]) {
    assert.equal(classify(t, { file_path: "/repo/x" }), null, `${t} must skip`);
  }
});

// ── 1b. cross-CLI classify (F101 item 1, loom#411) ──────────────────────────
// ONE hook file is registered on all three CLIs; classify() recognizes each
// CLI's DISJOINT tool vocab and maps by EFFECT (not by CLI).

test("classify[gemini]: write_file → Action with file_path", () => {
  const r = classify("write_file", { file_path: "/repo/src/app.py" });
  assert.equal(r.kind, "Action");
  assert.equal(r.payload.file_path, "/repo/src/app.py");
  assert.equal(r.payload.tool, "write_file");
});

test("classify[gemini]: replace → Action (edit tool)", () => {
  const r = classify("replace", { file_path: "/repo/src/app.py" });
  assert.equal(r.kind, "Action");
});

test("classify[gemini]: write_file to journal DECISION → Decision", () => {
  const r = classify("write_file", {
    file_path: "/repo/journal/0216-maintainer-DECISION-foo.md",
  });
  assert.equal(r.kind, "Decision");
  assert.ok(r.payload.journal_path.endsWith("DECISION-foo.md"));
});

test("classify[gemini]: run_shell_command → Action, command hashed", () => {
  const r = classify("run_shell_command", {
    command: "export TOKEN=sk-GEMLEAK && echo hi",
  });
  assert.equal(r.kind, "Action");
  assert.match(r.payload.command_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(r.payload).includes("sk-GEMLEAK"));
});

test("classify[codex]: apply_patch → Action", () => {
  const r = classify("apply_patch", { file_path: "/repo/src/lib.rs" });
  assert.equal(r.kind, "Action");
  assert.equal(r.payload.file_path, "/repo/src/lib.rs");
});

test("classify[codex]: shell (string command) → Action, command hashed", () => {
  const r = classify("shell", { command: "cat secret.env" });
  assert.equal(r.kind, "Action");
  assert.match(r.payload.command_sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.payload.command_chars, "cat secret.env".length);
});

test("classify[codex]: shell (ARRAY command) → Action, joined+hashed (secrets fence)", () => {
  const r = classify("unified_exec", {
    command: ["bash", "-lc", "export TOKEN=sk-CODEXLEAK && echo hi"],
  });
  assert.equal(r.kind, "Action");
  assert.match(r.payload.command_sha256, /^[0-9a-f]{64}$/);
  // array form is joined for the length + hash; raw secret never stored
  assert.equal(
    r.payload.command_chars,
    "bash -lc export TOKEN=sk-CODEXLEAK && echo hi".length,
  );
  assert.ok(!JSON.stringify(r.payload).includes("sk-CODEXLEAK"));
});

test("classify[cross-cli]: read-path tool names on other CLIs → skip (null)", () => {
  for (const t of ["read_file", "grep_search", "list_directory", "glob"]) {
    assert.equal(classify(t, { file_path: "/repo/x" }), null, `${t} skip`);
  }
});

test("classify[cross-cli]: only CC Task is a delegation tool-call", () => {
  // Gemini @agent / Codex inline-cat are NOT tool calls — no delegation kind here.
  assert.equal(classify("Task", { subagent_type: "reviewer" }).kind, "Delegation");
});

// ── 2. operator_ref projection + attribution ────────────────────────────────

test("_projectOperatorRef: rostered → verified, all three id fields", () => {
  const { operatorRef, attribution } = _projectOperatorRef(ID);
  assert.equal(attribution, "verified");
  assert.deepEqual(Object.keys(operatorRef).sort(), [
    "display_id",
    "person_id",
    "verified_id",
  ]);
});

test("_projectOperatorRef: verified key, no person_id → unrostered, fp kept", () => {
  const { operatorRef, attribution } = _projectOperatorRef({
    verified_id: "ABC123",
    person_id: null,
  });
  assert.equal(attribution, "unrostered");
  assert.equal(operatorRef.verified_id, "ABC123");
  assert.match(operatorRef.person_id, /^unrostered@/);
});

test("_projectOperatorRef: no identity → unidentified sentinel", () => {
  for (const id of [null, {}, { verified_id: "" }]) {
    const { operatorRef, attribution } = _projectOperatorRef(id);
    assert.equal(attribution, "unidentified");
    assert.equal(operatorRef.verified_id, "unidentified");
    assert.match(operatorRef.person_id, /^unidentified@/);
  }
});

// ── 3. chain continuity via captureProvenance ───────────────────────────────

test("captureProvenance: genesis → hash → hash chain; events schema-valid", () => {
  const dir = mkTmp();
  const session = "sess-chain";

  const r1 = captureProvenance({
    repoDir: dir,
    session,
    kind: "HumanInput",
    identity: ID,
    payload: { prompt_sha256: "a".repeat(64), char_count: 10 },
    nowIso: TS,
  });
  assert.ok(r1.ok);
  assert.equal(r1.event.prev_link, null); // genesis
  assert.equal(r1.event.payload.attribution, "verified");
  assert.ok(pe.validateProvenanceEvent(r1.event).ok);

  const r2 = captureProvenance({
    repoDir: dir,
    session,
    kind: "Action",
    identity: ID,
    payload: { tool: "Write", file_path: "/x" },
    nowIso: TS,
  });
  assert.ok(r2.ok);
  assert.equal(r2.event.prev_link, pe.hashProvenanceEvent(r1.event));

  // ledger has exactly two lines, in order
  const lines = fs
    .readFileSync(r2.ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, "HumanInput");
  assert.equal(JSON.parse(lines[1]).kind, "Action");
});

test("_deriveChainHead: corrupt last line → loud chain_reset_reason", () => {
  const dir = mkTmp();
  const session = "sess-corrupt";
  captureProvenance({
    repoDir: dir,
    session,
    kind: "HumanInput",
    identity: ID,
    payload: { prompt_sha256: "b".repeat(64), char_count: 5 },
    nowIso: TS,
  });
  const lp = ledgerLib._ledgerPath(dir, session);
  fs.appendFileSync(lp, "{not valid json\n"); // corrupt the tail

  const head = _deriveChainHead(lp);
  assert.equal(head.priorEvent, null);
  assert.equal(head.resetReason, "prior_line_unparseable");

  // next capture records the reset reason rather than silently forking genesis
  const r = captureProvenance({
    repoDir: dir,
    session,
    kind: "Action",
    identity: ID,
    payload: { tool: "Bash" },
    nowIso: TS,
  });
  assert.ok(r.ok);
  assert.equal(r.event.payload.chain_reset_reason, "prior_line_unparseable");
});

// ── 4. determinism: same logical event → same hash regardless of key order ──

test("ledger events are byte-exact deterministic (seam contract)", () => {
  const mk = (extra) =>
    captureProvenance({
      repoDir: mkTmp(),
      session: "s",
      kind: "HumanInput",
      identity: ID,
      payload: extra,
      nowIso: TS,
    }).event;
  const a = mk({ char_count: 3, prompt_sha256: "c".repeat(64) });
  const b = mk({ prompt_sha256: "c".repeat(64), char_count: 3 });
  assert.equal(pe.hashProvenanceEvent(a), pe.hashProvenanceEvent(b));
});

// ── 5. end-to-end walk: hooks never block; ledger lands chained, secret-free ─

test("WALK: prompt hook → HumanInput; tool hook → chained Delegation; no block", () => {
  const dir = mkTmp();
  // resolveMainCheckout uses `git worktree list`; make dir a real repo so the
  // walk exercises the production path (not just the catch fallback).
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const session = "walk-sess-1";
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    COC_TEST_FINGERPRINT: ID.verified_id,
    COC_TEST_PERSON_ID: ID.person_id,
  };

  const RAW_PROMPT = "use short-lived tokens not sessions SECRET-sk-XYZ";
  const p1 = spawnSync(
    "node",
    [path.join(HOOKS, "provenance-capture-prompt.js")],
    {
      cwd: dir,
      env,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt: RAW_PROMPT,
      }),
      encoding: "utf8",
    },
  );
  assert.equal(p1.status, 0);
  assert.match(p1.stdout, /"continue":\s*true/); // never blocks

  const p2 = spawnSync(
    "node",
    [path.join(HOOKS, "provenance-capture-tool.js")],
    {
      cwd: dir,
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: session,
        tool_name: "Task",
        tool_input: {
          subagent_type: "reviewer",
          description: "review",
          prompt: "go",
        },
      }),
      encoding: "utf8",
    },
  );
  assert.equal(p2.status, 0);
  assert.match(p2.stdout, /"continue":\s*true/);

  // The ledger landed under the MAIN checkout, partitioned by session.
  const lp = _ledgerPath(dir, session);
  assert.ok(fs.existsSync(lp), "session ledger must exist");
  const events = fs
    .readFileSync(lp, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "HumanInput");
  assert.equal(events[0].prev_link, null);
  assert.equal(events[0].operator_ref.verified_id, ID.verified_id);
  assert.equal(events[0].payload.char_count, RAW_PROMPT.length);
  assert.match(events[0].payload.prompt_sha256, /^[0-9a-f]{64}$/);

  assert.equal(events[1].kind, "Delegation");
  assert.equal(events[1].prev_link, pe.hashProvenanceEvent(events[0]));
  assert.equal(events[1].payload.subagent_type, "reviewer");

  // SECRETS FENCE end-to-end: the raw secret never reaches the permanent ledger.
  const rawLedger = fs.readFileSync(lp, "utf8");
  assert.ok(
    !rawLedger.includes("SECRET-sk-XYZ"),
    "raw prompt must not be stored",
  );

  // Every landed event validates against the F101-1 schema (seam contract).
  for (const ev of events) assert.ok(pe.validateProvenanceEvent(ev).ok);
});

test("WALK: read-path tool records nothing (no ledger noise)", () => {
  const dir = mkTmp();
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const session = "walk-readpath";
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    COC_TEST_FINGERPRINT: ID.verified_id,
    COC_TEST_PERSON_ID: ID.person_id,
  };
  const r = spawnSync(
    "node",
    [path.join(HOOKS, "provenance-capture-tool.js")],
    {
      cwd: dir,
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: session,
        tool_name: "Read",
        tool_input: { file_path: "/repo/x.js" },
      }),
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"continue":\s*true/);
  const lp = _ledgerPath(dir, session);
  assert.ok(!fs.existsSync(lp), "read-path must not create a ledger");
});

// ── 6. R1 redteam regressions (resolved by construction) ────────────────────

test("MED-1: own-__proto__ payload key is REJECTED, not silently dropped", () => {
  // F101-1 bug-class #4: a plain-{} merge target would trigger the __proto__
  // setter and strip the key before the schema guard. captureProvenance uses a
  // null-proto merge target so the key survives and validation rejects the event.
  const malicious = JSON.parse('{"x":1,"__proto__":{"polluted":true}}');
  const r = captureProvenance({
    repoDir: mkTmp(),
    session: "s-proto",
    kind: "Action",
    identity: ID,
    payload: malicious,
    nowIso: TS,
  });
  assert.equal(
    r.ok,
    false,
    "event with __proto__ payload key must be rejected",
  );
  assert.equal({}.polluted, undefined, "global prototype must be unpolluted");
});

test("MEDIUM-1: absolute file_path under repo → repo-relative (disclosure fence)", () => {
  const dir = mkTmp();
  const r = captureProvenance({
    repoDir: dir,
    session: "s-rel",
    kind: "Action",
    identity: ID,
    payload: { tool: "Write", file_path: path.join(dir, "src", "billing.py") },
    nowIso: TS,
  });
  assert.ok(r.ok);
  assert.equal(r.event.payload.file_path, path.join("src", "billing.py"));
  // no absolute home/username prefix survives into the permanent record
  assert.ok(!r.event.payload.file_path.startsWith(dir));
});

test("_relativizePath: outside-repo absolute → basename only", () => {
  assert.equal(
    _relativizePath("/repo", "/Users/<user>/clients/acme/secret-layout.py"),
    "secret-layout.py",
  );
  assert.equal(
    _relativizePath("/repo", "/repo/src/a.js"),
    path.join("src", "a.js"),
  );
  assert.equal(_relativizePath("/repo", "src/a.js"), "src/a.js"); // already relative
});

test("R2 NEW-2: relative path escaping via .. → basename (exported-helper fence)", () => {
  // A caller-supplied relative path with a leading `..` would leak a sibling
  // root; the fence collapses it to basename. In-repo `..` that stays inside
  // normalizes cleanly and is retained (accountability).
  assert.equal(
    _relativizePath("/repo", "../sibling-client/secret.py"),
    "secret.py",
  );
  assert.equal(_relativizePath("/repo", "../../etc/passwd"), "passwd");
  assert.equal(
    _relativizePath("/repo", "src/../lib/a.js"),
    path.join("lib", "a.js"),
  );
  // R3 boundary: interior `..` that OUT-counts leading segments still escapes
  // (normalizes to a leading `..`) → basename, not the escaped `lib/a.js`.
  assert.equal(_relativizePath("/repo", "src/../../lib/a.js"), "a.js");
});

test("LOW injectivity: collision-distinct raw sessions → distinct ledger files", () => {
  const a = _ledgerPath("/repo", "sess/1");
  const b = _ledgerPath("/repo", "sess_1");
  assert.notEqual(a, b, "sanitize-colliding sessions must not share a ledger");
  // same raw id is deterministic (one chain)
  assert.equal(_ledgerPath("/repo", "sess/1"), _ledgerPath("/repo", "sess/1"));
});

test("cc-arch LOW-1: .pending and timestamp-prefixed DECISION stubs → Decision", () => {
  const a = classify("Write", {
    file_path: "/r/workspaces/x/journal/.pending/1779982055145-1-DECISION.md",
  });
  assert.equal(a.kind, "Decision");
  const b = classify("Write", {
    file_path: "journal/.pending/1779-2-DECISION.md",
  });
  assert.equal(b.kind, "Decision");
});

test("malformed nowIso (month 13) is rejected, not appended", () => {
  const r = captureProvenance({
    repoDir: mkTmp(),
    session: "s-badts",
    kind: "Action",
    identity: ID,
    payload: { tool: "Bash" },
    nowIso: "2026-13-01T00:00:00Z",
  });
  assert.equal(r.ok, false);
});
