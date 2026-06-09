#!/usr/bin/env node
/*
 * Tier-2 regression test for the cli_delivery lane-declaration contract
 * (#408 AC#5-a / Validator 18). Path-scoped rules have no `paths:` glob loader
 * on Codex/Gemini, so before this contract they were SILENTLY dropped from the
 * non-CC lanes. The contract makes every rule's non-CC delivery lane explicit
 * or smart-defaulted, and the validator enforces "no silent drops":
 *   - cli_delivery: baseline | skill-channel | cc-only (optional frontmatter field)
 *   - smart default: scope:baseline→baseline, scope:path-scoped→skill-channel,
 *     exclude_from:[codex,gemini] (or both in cli_emit_exclusions)→cc-only.
 *   - every path-scoped rule MUST resolve to exactly one lane (null lane = FAIL).
 *   - cc-only ⟺ actually-excluded, checked BOTH directions (excluded-but-not-
 *     declared, and declared-but-not-excluded, are both silent drops).
 *
 * Two layers (per rules/probe-driven-verification.md MUST-3 — structural, not
 * regex-against-semantic-claims):
 *   (1) Unit — deriveCliDelivery + checkRuleCliDelivery on synthetic frontmatter.
 *   (2) Integration — validateCliDelivery() against the LIVE rule corpus:
 *       PASS + every-rule-accounted-for (the no-silent-drops invariant).
 *
 * Run: node .claude/test-harness/tests/cli-delivery-contract.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

const {
  CLI_DELIVERY_VALUES,
  deriveCliDelivery,
  checkRuleCliDelivery,
  validateCliDelivery,
  getCritBaseline,
} = await import(path.join(REPO, ".claude", "bin", "emit.mjs"));

// ── (1) Unit: smart-default derivation ───────────────────────────
test("enum is exactly the three declared lanes", () => {
  assert.deepEqual(CLI_DELIVERY_VALUES, ["baseline", "skill-channel", "cc-only"]);
});

test("smart default: scope:baseline → baseline", () => {
  const r = deriveCliDelivery("priority: 0\nscope: baseline");
  assert.deepEqual(r, { value: "baseline", source: "smart-default" });
});

test("smart default: scope:path-scoped → skill-channel", () => {
  const r = deriveCliDelivery("priority: 10\nscope: path-scoped\npaths:\n  - x");
  assert.deepEqual(r, { value: "skill-channel", source: "smart-default" });
});

test("smart default: exclude_from:[codex,gemini] → cc-only (any scope)", () => {
  const r = deriveCliDelivery("scope: excluded\nexclude_from: [codex, gemini]");
  assert.equal(r.value, "cc-only");
  assert.equal(r.source, "smart-default");
});

test("smart default: manifest-cc-only flag → cc-only even without exclude_from", () => {
  const r = deriveCliDelivery("scope: path-scoped\npaths:\n  - x", true);
  assert.equal(r.value, "cc-only");
});

test("smart default: scope:skill-embedded → n/a (delivered via host skill)", () => {
  const r = deriveCliDelivery("priority: 20\nscope: skill-embedded");
  assert.equal(r.value, "n/a-skill-embedded");
});

test("explicit declaration wins over smart default and is tagged source:explicit", () => {
  const r = deriveCliDelivery("scope: path-scoped\ncli_delivery: cc-only");
  assert.deepEqual(r, { value: "cc-only", source: "explicit" });
});

test("unresolved lane: scope:excluded WITHOUT both-CLI exclusion → null (caught as FAIL)", () => {
  const r = deriveCliDelivery("scope: excluded\nexclude_from: [codex]");
  assert.equal(r.value, null);
});

// ── (1) Unit: per-rule consistency (the no-silent-drops guards) ───
test("PASS: path-scoped smart-defaults to skill-channel with no failures", () => {
  const r = checkRuleCliDelivery("priority: 10\nscope: path-scoped\npaths:\n  - x");
  assert.deepEqual(r.failures, []);
  assert.equal(r.lane, "skill-channel");
});

test("PASS: cc-only via frontmatter exclude_from buckets cleanly (manifest agnostic)", () => {
  const r = checkRuleCliDelivery("scope: excluded\nexclude_from: [codex, gemini]");
  assert.deepEqual(r.failures, []);
  assert.equal(r.lane, "cc-only");
});

test("PASS: cc-only via MANIFEST per-lane exclusion (no exclude_from frontmatter)", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\npaths:\n  - x", {
    codex: true,
    gemini: true,
  });
  assert.deepEqual(r.failures, []);
  assert.equal(r.lane, "cc-only");
});

test("FAIL: invalid explicit value", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\ncli_delivery: wormhole");
  assert.equal(r.lane, null);
  assert.match(r.failures.join("\n"), /cli_delivery must be baseline\/skill-channel\/cc-only/);
});

test("FAIL: explicit cli_delivery:baseline on a path-scoped rule", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\ncli_delivery: baseline");
  assert.equal(r.lane, null);
  assert.match(r.failures.join("\n"), /cli_delivery:baseline requires scope:baseline/);
});

test("FAIL (silent-drop direction A): excluded from codex+gemini but declares skill-channel", () => {
  const r = checkRuleCliDelivery(
    "scope: excluded\nexclude_from: [codex, gemini]\ncli_delivery: skill-channel",
  );
  assert.equal(r.lane, null);
  assert.match(r.failures.join("\n"), /silent drop; declare cli_delivery:cc-only/);
});

test("FAIL (silent-drop direction B): cc-only declared but rule is NOT excluded", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\ncli_delivery: cc-only");
  assert.equal(r.lane, null);
  assert.match(r.failures.join("\n"), /NOT excluded from codex\+gemini/);
});

// ── (1) Unit: ASYMMETRIC single-lane exclusion (R1 reviewer/security MED — the
//        silent drop "one lane over" the bidirectional guard alone missed) ─────
test("FAIL (asymmetric): manifest excludes codex ONLY → loud fail, never silent skill-channel", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\npaths:\n  - x", {
    codex: true,
    gemini: false,
  });
  assert.equal(r.lane, null, "asymmetric exclusion MUST NOT bucket as skill-channel");
  assert.match(r.failures.join("\n"), /excluded from codex only.*has no asymmetric-lane value/);
});

test("FAIL (asymmetric): manifest excludes gemini ONLY → loud fail", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\npaths:\n  - x", {
    codex: false,
    gemini: true,
  });
  assert.equal(r.lane, null);
  assert.match(r.failures.join("\n"), /excluded from gemini only/);
});

test("FAIL (asymmetric): frontmatter exclude_from:[codex] single-lane → loud fail", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\nexclude_from: [codex]\npaths:\n  - x");
  assert.equal(r.lane, null);
  assert.match(r.failures.join("\n"), /excluded from codex only/);
});

test("PASS: manifest + frontmatter together exclude BOTH lanes → cc-only (not asymmetric)", () => {
  const r = checkRuleCliDelivery("scope: path-scoped\nexclude_from: [gemini]\npaths:\n  - x", {
    codex: true,
    gemini: false,
  });
  assert.deepEqual(r.failures, [], "codex via manifest + gemini via frontmatter = both excluded");
  assert.equal(r.lane, "cc-only");
});

// ── (2) Integration: the live rule corpus ────────────────────────
test("validateCliDelivery PASSES on the live corpus", () => {
  const r = validateCliDelivery();
  assert.equal(r.pass, true, `failures:\n${r.failures.join("\n")}`);
});

test("no-silent-drops invariant: every rule with frontmatter resolves to exactly one lane", () => {
  const r = validateCliDelivery();
  const rulesDir = path.join(REPO, ".claude", "rules");
  const withFm = fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) =>
      /^---\n[\s\S]*?\n---/.test(fs.readFileSync(path.join(rulesDir, f), "utf8")),
    );
  const accounted =
    r.report.baseline.length +
    r.report["skill-channel"].length +
    r.report["cc-only"].length +
    r.report["n/a-skill-embedded"].length;
  assert.equal(
    accounted,
    withFm.length,
    `every front-mattered rule must land in exactly one lane (accounted ${accounted} vs ${withFm.length} rules)`,
  );
});

test("baseline lane == getCritBaseline() (the priority:0 always-on set)", () => {
  const r = validateCliDelivery();
  assert.deepEqual(r.report.baseline.sort(), getCritBaseline().sort());
});

test("every path-scoped (priority:10) rule lands in skill-channel or cc-only, never dropped", () => {
  const r = validateCliDelivery();
  const rulesDir = path.join(REPO, ".claude", "rules");
  const pathScoped = fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) =>
      /^priority:\s*10/m.test(
        (fs.readFileSync(path.join(rulesDir, f), "utf8").match(/^---\n([\s\S]*?)\n---/) || [
          "",
          "",
        ])[1],
      ),
    );
  const routed = new Set([...r.report["skill-channel"], ...r.report["cc-only"]]);
  for (const f of pathScoped)
    assert.ok(routed.has(f), `${f} (priority:10) is not routed to any non-CC lane — silent drop`);
});
