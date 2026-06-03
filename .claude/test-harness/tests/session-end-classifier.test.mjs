#!/usr/bin/env node
/*
 * Smoke test for .claude/hooks/lib/journal-classifier.js.
 *
 * Per cc-artifacts.md Rule 9 — every audit predicate the classifier
 * relies on ships with a committed fixture. This test loads the
 * fixture set under .claude/audit-fixtures/session-end-hook/ and
 * asserts the classifier produces the expected verdict for each.
 *
 * Pairs with issue #114 (Tighten SessionEnd hook journal-worthy
 * pattern) — the fixtures encode the acceptance criteria:
 *   - chore commit (skip)
 *   - feat commit with body (stub)
 *   - merge commit (skip)
 *   - security finding commit (stub)
 *   - plus three sibling cases (version-bump, feat-no-novel-body,
 *     fix-leak-discovery, coc-housekeeping) covering the rest of
 *     the classifier's predicates.
 *
 * Run: node .claude/test-harness/tests/session-end-classifier.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const fixturesDir = path.join(
  repoRoot,
  ".claude",
  "audit-fixtures",
  "session-end-hook",
);
const classifierPath = path.join(
  repoRoot,
  ".claude",
  "hooks",
  "lib",
  "journal-classifier.js",
);

const require = createRequire(import.meta.url);
const { classifyCommitForJournal } = require(classifierPath);

function listFixturePairs() {
  const entries = fs.readdirSync(fixturesDir);
  const inputs = entries
    .filter((e) => e.endsWith(".input.json"))
    .map((e) => e.replace(/\.input\.json$/, ""))
    .sort();
  return inputs.map((stem) => ({
    name: stem,
    inputPath: path.join(fixturesDir, `${stem}.input.json`),
    expectedPath: path.join(fixturesDir, `${stem}.expected.json`),
  }));
}

const fixtures = listFixturePairs();

test("session-end-classifier: at least four fixtures committed (issue #114 acceptance criteria minimum)", () => {
  assert.ok(
    fixtures.length >= 4,
    `expected >=4 fixtures (chore-skip, feat-stub, merge-skip, security-stub); got ${fixtures.length}`,
  );
});

for (const fx of fixtures) {
  test(`session-end-classifier fixture: ${fx.name}`, () => {
    const input = JSON.parse(fs.readFileSync(fx.inputPath, "utf8"));
    const expected = JSON.parse(fs.readFileSync(fx.expectedPath, "utf8"));
    const got = classifyCommitForJournal(input.subject, input.body || "");

    if (expected.type === null) {
      assert.equal(
        got.type,
        null,
        `${fx.name}: expected skip (type=null) but got type=${got.type}`,
      );
      assert.equal(
        got.skipReason,
        expected.skipReason,
        `${fx.name}: skipReason mismatch`,
      );
    } else {
      assert.equal(
        got.type,
        expected.type,
        `${fx.name}: expected type=${expected.type} but got type=${got.type} (skipReason=${got.skipReason})`,
      );
    }
  });
}

test("session-end-classifier: empty body never throws", () => {
  const verdict = classifyCommitForJournal("chore: tidy", null);
  assert.equal(verdict.type, null);
  assert.equal(typeof verdict.skipReason, "string");
});

test("session-end-classifier: missing subject returns no-match (defensive)", () => {
  const verdict = classifyCommitForJournal("", "");
  assert.equal(verdict.type, null);
  assert.equal(verdict.skipReason, "no-match");
});

test("session-end-classifier: feat with body=99 chars is short — must skip", () => {
  // Body length below the 100-char substantive threshold; even with
  // decision-language, must skip (avoids false positives on tiny commits).
  const shortBody = "Decided to add a flag. " + "x".repeat(70); // <100 chars trimmed
  // Sanity: confirm the threshold logic — the body without the keyword
  // would always skip, so we're testing that <100 chars + keyword
  // ALSO skips.
  const verdict = classifyCommitForJournal("feat(x): add flag", shortBody);
  assert.equal(verdict.type, null);
});
