#!/usr/bin/env node
/*
 * F101-3 — author-backing verifiability layer (loom#411, governance-as-DNA).
 *
 * checkAuthorBacking() answers ONE question against the LIVE per-session
 * provenance ledger (the F101-2 capture stream): is a `human`/`co-authored`
 * author claim BACKED by ≥1 real HumanInput provenance event?
 *
 * Pinned invariants:
 *   1. backed       — author human|co-authored + ≥1 session HumanInput.
 *   2. unbacked     — author human|co-authored + 0  session HumanInput.
 *   3. n/a-agent    — author agent → never verified, never "BACKED".
 *   4. undetermined — ledger absent / unreadable / no session.
 *   5. cosmetic label — agent → "n/a — agent-surfaced" (MUST-2).
 *   6. SECRETS FENCE — counts kind:"HumanInput", never reads event payload.
 *
 * Ledger path is resolved via provenance-ledger.js::_ledgerPath — the SAME
 * helper the production capture path uses (no re-derivation). Fixtures are
 * hand-written ledgers written to that resolved path inside a temp git repo.
 *
 * Run: node --test .claude/test-harness/tests/provenance-author-backing.test.mjs
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

const ledgerLib = require("../../hooks/lib/provenance-ledger.js");
const { _ledgerPath } = ledgerLib;
const backing = require("../../hooks/lib/provenance-author-backing.js");
const { checkAuthorBacking, backingLabel } = backing;
const pe = require("../../hooks/lib/provenance-event.js");

const ID = {
  verified_id: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  person_id: "pid-example-10e7dd16",
  display_id: "example",
};
const TS = "2026-06-01T12:00:00Z";

function mkRepo() {
  // A real git repo so the resolved ledger path matches the production shape
  // (and _ledgerPath's repoDir-relative join behaves as in capture).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prov-f101-3-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/**
 * Write a hand-authored ledger for (repoDir, session) carrying `n` HumanInput
 * events chained off a genesis. Mirrors the on-disk shape captureProvenance
 * lands (one JSON event per line). We build the chain through the real
 * provenance-event helpers so each line is schema-valid + the count semantics
 * are exercised against production-shaped data.
 */
function writeLedger(repoDir, session, kinds) {
  const lp = _ledgerPath(repoDir, session);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  let prior = null;
  const lines = [];
  for (const kind of kinds) {
    // Minimal kind-appropriate payload; the fence means the checker reads
    // ONLY `kind`, never these fields.
    const payload =
      kind === "HumanInput"
        ? { prompt_sha256: "a".repeat(64), char_count: 7 }
        : { tool: "Write", file_path: "src/x.js" };
    const event = pe.chainProvenanceEvent(prior, {
      kind,
      ts: TS,
      session,
      operatorRef: { verified_id: ID.verified_id, person_id: ID.person_id },
      payload,
    });
    lines.push(JSON.stringify(event));
    prior = event;
  }
  fs.writeFileSync(lp, lines.join("\n") + (lines.length ? "\n" : ""));
  return lp;
}

// ── 1. backed: human author + ≥1 HumanInput ─────────────────────────────────

test("backed: author=human + 1 HumanInput event → backed", () => {
  const dir = mkRepo();
  const session = "sess-backed-human";
  writeLedger(dir, session, ["HumanInput", "Action"]);
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "backed");
  assert.equal(r.humanInputCount, 1);
  assert.equal(r.label, "BACKED by human input");
});

test("backed: author=co-authored + 2 HumanInput events → backed", () => {
  const dir = mkRepo();
  const session = "sess-backed-coauthored";
  writeLedger(dir, session, ["HumanInput", "Delegation", "HumanInput"]);
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "co-authored",
  });
  assert.equal(r.status, "backed");
  assert.equal(r.humanInputCount, 2);
});

test("backed: author value is case/whitespace tolerant", () => {
  const dir = mkRepo();
  const session = "sess-backed-case";
  writeLedger(dir, session, ["HumanInput"]);
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "  Human  ",
  });
  assert.equal(r.status, "backed");
});

// ── 2. unbacked: human author + 0 HumanInput ────────────────────────────────

test("unbacked: author=human + ledger with NO HumanInput → unbacked", () => {
  const dir = mkRepo();
  const session = "sess-unbacked";
  // Ledger exists but carries only agent-side Action/Delegation events.
  writeLedger(dir, session, ["Action", "Delegation"]);
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "unbacked");
  assert.equal(r.humanInputCount, 0);
  assert.match(r.label, /UNBACKED/);
});

test("unbacked: author=co-authored + 0 HumanInput → unbacked", () => {
  const dir = mkRepo();
  const session = "sess-unbacked-coauthored";
  writeLedger(dir, session, ["Action"]);
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "co-authored",
  });
  assert.equal(r.status, "unbacked");
});

// ── 3. n/a-agent: author=agent → never verified ─────────────────────────────

test("n/a-agent: author=agent → n/a-agent even WITH HumanInput in ledger", () => {
  const dir = mkRepo();
  const session = "sess-agent";
  writeLedger(dir, session, ["HumanInput", "Action"]);
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "agent",
  });
  assert.equal(r.status, "n/a-agent");
  // MUST-2: agent-surfaced renders the cosmetic n/a label, NEVER "BACKED".
  assert.equal(r.label, "n/a — agent-surfaced");
  assert.notEqual(r.label, "BACKED by human input");
  // No ledger read needed for the agent branch.
  assert.equal(r.humanInputCount, null);
});

test("n/a-agent label maps agent → 'n/a — agent-surfaced' (cosmetic rule)", () => {
  // Direct label assertion per the brief's cosmetic-label requirement.
  assert.equal(backingLabel("n/a-agent"), "n/a — agent-surfaced");
});

// ── 4. undetermined: ledger absent / unreadable / no session ────────────────

test("undetermined: no ledger on disk → undetermined", () => {
  const dir = mkRepo();
  const session = "sess-no-ledger"; // never written
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "undetermined");
  assert.equal(r.humanInputCount, null);
  // The resolved path is surfaced so the caller can name it in the report.
  assert.equal(r.ledgerPath, _ledgerPath(dir, session));
});

test("undetermined: empty session id → undetermined (no path resolved)", () => {
  const dir = mkRepo();
  const r = checkAuthorBacking({
    repoDir: dir,
    session: "",
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "undetermined");
  assert.equal(r.ledgerPath, null);
});

test("undetermined: missing repoDir → undetermined", () => {
  const r = checkAuthorBacking({
    session: "sess-x",
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "undetermined");
});

// ── 5. SECRETS FENCE: count never reads payload ─────────────────────────────

test("SECRETS FENCE: count reads only kind, never event payload content", () => {
  const dir = mkRepo();
  const session = "sess-fence";
  const lp = _ledgerPath(dir, session);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  // Hand-plant a HumanInput line whose payload carries a SECRET-shaped string.
  // The checker MUST count it (kind matches) WITHOUT surfacing the secret.
  const ev = pe.chainProvenanceEvent(null, {
    kind: "HumanInput",
    ts: TS,
    session,
    operatorRef: { verified_id: ID.verified_id, person_id: ID.person_id },
    payload: { prompt_sha256: "c".repeat(64), char_count: 3 },
  });
  fs.writeFileSync(lp, JSON.stringify(ev) + "\n");
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "backed");
  assert.equal(r.humanInputCount, 1);
  // The returned object exposes ONLY status/count/path/label — no payload.
  assert.deepEqual(Object.keys(r).sort(), [
    "humanInputCount",
    "label",
    "ledgerPath",
    "status",
  ]);
});

test("corrupt ledger lines are skipped, not fatal; well-formed HumanInput still counts", () => {
  const dir = mkRepo();
  const session = "sess-corrupt-tail";
  const lp = writeLedger(dir, session, ["HumanInput"]);
  fs.appendFileSync(lp, "{not valid json\n"); // corrupt tail line
  const r = checkAuthorBacking({
    repoDir: dir,
    session,
    frontmatterAuthor: "human",
  });
  assert.equal(r.status, "backed");
  assert.equal(r.humanInputCount, 1);
});
