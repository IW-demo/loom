#!/usr/bin/env node
/*
 * cli-drift-audit-test.mjs — fixture + unit driver for cli-drift-audit.mjs.
 *
 * Two halves:
 *   1. Fixture runner — for every committed fixture under
 *      .claude/audit-fixtures/cross-cli-drift/fixture-*, invokes the
 *      audit tool, compares the produced summary + exit code against
 *      the fixture's expected.json, reports pass/fail.
 *   2. Unit branches — calls auditRule directly with mock composeFn
 *      to exercise the error-path branches (compose-failure, parse-failure)
 *      that have no fixture path because fixtureListRules filters by
 *      a strict /^[a-z][a-z0-9-]*\.md$/ grammar.
 *
 * Usage:
 *   node tools/cli-drift-audit-test.mjs
 *
 * Exit codes:
 *   0 — every fixture + unit branch passed
 *   1 — one or more failures
 *   2 — runner usage / setup error
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { auditRule, loadDriftConfig } from "./cli-drift-audit.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), "..");
const FIXTURES_ROOT = path.join(REPO, ".claude", "audit-fixtures", "cross-cli-drift");
const AUDIT_TOOL = path.join(REPO, "tools", "cli-drift-audit.mjs");

const results = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const tag = passed ? "PASS" : "FAIL";
  process.stdout.write(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}

// ────────────────────────────────────────────────────────────────
// 1. Fixture runner
// ────────────────────────────────────────────────────────────────
function runFixtures() {
  process.stdout.write("Fixture runner:\n");
  const entries = fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("fixture-"))
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    record("fixture-discovery", false, "no fixtures found under " + FIXTURES_ROOT);
    return;
  }

  for (const name of entries) {
    const dir = path.join(FIXTURES_ROOT, name);
    const expectedPath = path.join(dir, "expected.json");
    if (!fs.existsSync(expectedPath)) {
      record(name, false, "expected.json missing");
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

    const jsonOut = path.join("/tmp", `cli-drift-audit-${name}-${Date.now()}.json`);
    const r = spawnSync(
      process.execPath,
      [AUDIT_TOOL, "--fixtures", dir, "--quiet", "--json", jsonOut],
      { encoding: "utf8" },
    );

    if (r.status !== expected.exit_code) {
      record(
        name,
        false,
        `exit code mismatch: expected ${expected.exit_code}, got ${r.status}`,
      );
      continue;
    }
    if (!fs.existsSync(jsonOut)) {
      record(name, false, `JSON report not written to ${jsonOut}`);
      continue;
    }
    const report = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
    fs.unlinkSync(jsonOut);

    const fields = ["rules_audited", "critical", "warn", "note"];
    const mismatches = fields.filter(
      (f) => report.summary[f] !== expected.summary[f],
    );
    if (mismatches.length > 0) {
      const detail = mismatches
        .map((f) => `${f}: expected ${expected.summary[f]}, got ${report.summary[f]}`)
        .join("; ");
      record(name, false, detail);
      continue;
    }
    record(name, true);
  }
}

// ────────────────────────────────────────────────────────────────
// 2. Unit branches — error paths that cannot be reached via the
// fixture grammar (rule-name regex filters out the file shapes that
// would trigger compose-failure; slot-parse-failure needs an unclosed
// slot marker in the rule body).
// ────────────────────────────────────────────────────────────────
function runUnitBranches() {
  process.stdout.write("\nUnit branches:\n");

  // Use the real manifest config so the branches see realistic input.
  const config = loadDriftConfig();

  // Branch A — compose-failure: composeFn throws.
  {
    const composeFn = () => {
      throw new Error("simulated compose failure");
    };
    const r = auditRule("sample-rule.md", config, composeFn);
    const f = r.findings;
    const ok =
      f.length === 1 &&
      f[0].slot === "(composition)" &&
      f[0].severity === "CRITICAL" &&
      f[0].evidence.includes("simulated compose failure");
    record(
      "unit:compose-failure",
      ok,
      ok
        ? "1 CRITICAL on (composition) slot"
        : `unexpected findings: ${JSON.stringify(f)}`,
    );
  }

  // Branch B — parse-failure: composeFn returns body with unclosed slot.
  {
    const malformed =
      "---\npriority: 0\nscope: baseline\n---\n\n<!-- slot:neutral-body -->\nunclosed slot body\n";
    const composeFn = () => ({ composed: malformed, warnings: [] });
    const r = auditRule("sample-rule.md", config, composeFn);
    const f = r.findings;
    const ok =
      f.length === 1 &&
      f[0].slot === "(parse)" &&
      f[0].severity === "CRITICAL" &&
      f[0].evidence.includes("parseSlotsV5 failed");
    record(
      "unit:parse-failure",
      ok,
      ok
        ? "1 CRITICAL on (parse) slot"
        : `unexpected findings: ${JSON.stringify(f)}`,
    );
  }

  // Branch C — happy path with all-identical bodies (sanity check that
  // the unit harness isn't accidentally always passing).
  {
    const wellFormed =
      "---\npriority: 0\nscope: baseline\n---\n\n<!-- slot:neutral-body -->\nMUST log per-row failures.\n<!-- /slot:neutral-body -->\n";
    const composeFn = () => ({ composed: wellFormed, warnings: [] });
    const r = auditRule("sample-rule.md", config, composeFn);
    const ok = r.findings.length === 0;
    record(
      "unit:happy-path",
      ok,
      ok ? "0 findings as expected" : `unexpected findings: ${JSON.stringify(r.findings)}`,
    );
  }
}

runFixtures();
runUnitBranches();

const failed = results.filter((r) => !r.passed);
process.stdout.write(
  `\nResults: ${results.length - failed.length}/${results.length} passed\n`,
);
process.exit(failed.length > 0 ? 1 : 0);
