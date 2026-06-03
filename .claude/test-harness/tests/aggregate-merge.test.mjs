#!/usr/bin/env node
/*
 * Smoke test for lib/aggregate.mjs probe-merge logic.
 *
 * Tier 1 (deterministic, fixture-driven, no fs / no LLM). Asserts the
 * three probe-merge outcomes per probe-driven-verification.md MUST-1+2:
 *   1. needs_probe row + all probe verdicts pass + all regex pass
 *      → state = "pass"
 *   2. needs_probe row + companion verdict missing
 *      → state stays "needs_probe"
 *   3. needs_probe row + probe verdict pass:false
 *      → state = "fail" with probe schema name in failedCriteria
 *   4. probe row schema-invalid (valid:false)
 *      → state = "fail" with verdict.reason surfaced
 *   5. duplicate probe verdicts: latest by judged_at wins
 *
 * Run: node .claude/test-harness/tests/aggregate-merge.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProbeMap,
  mergeProbeVerdicts,
  extractFailedFields,
  isProbeCompanion,
  sanitizeForReport,
} from "../lib/aggregate.mjs";

// ---------- shared fixture builders ----------

function suiteRow({
  suite = "compliance",
  test: testName = "CM3-directive-recommend",
  cli = "cc",
  state = "needs_probe",
  criteria,
}) {
  const c = criteria || [
    {
      label: "structural marker",
      kind: "contains",
      pattern: "/MARKER/",
      pass: true,
    },
    {
      label: "semantic probe",
      kind: "probe",
      probe_schema: "RecommendationProbeAnswer",
      pass: null,
      needs_probe: true,
    },
  ];
  const allCriteriaPass =
    c.every((x) => x.pass === true) && !c.some((x) => x.needs_probe);
  return {
    suite,
    test: testName,
    cli,
    cliVersion: "test-version",
    runtimeMs: 1000,
    state,
    quotaExhausted: false,
    score: {
      pass: state === "needs_probe" ? null : allCriteriaPass,
      criteria: c,
      needs_probe: state === "needs_probe",
    },
  };
}

function probeRow({
  suite = "compliance",
  test: testName = "CM3-directive-recommend",
  cli = "cc",
  label = "semantic probe",
  schema = "RecommendationProbeAnswer",
  pass = true,
  valid = true,
  answer,
  reason = null,
  judged_at = "2026-05-07T12:00:00Z",
}) {
  return {
    suite,
    test: testName,
    cli,
    cliVersion: "test-version",
    schema,
    label,
    answer: answer || {
      contains_pick: pass,
      implications_present: pass,
      citation: pass,
      evidence_quote: "stub",
    },
    valid,
    pass,
    evidence_quote: "stub evidence",
    reason,
    judged_at,
  };
}

// ---------- core merge cases ----------

test("isProbeCompanion: distinguishes companion files", () => {
  assert.equal(isProbeCompanion("compliance-1234.probes.jsonl"), true);
  assert.equal(isProbeCompanion("compliance-1234.jsonl"), false);
  assert.equal(isProbeCompanion("safety.probes.jsonl"), true);
  assert.equal(isProbeCompanion("results.jsonl"), false);
});

test("merge: needs_probe + all pass → state=pass", () => {
  const rows = [suiteRow({})];
  const probes = [probeRow({ pass: true })];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].state, "pass");
  assert.equal(merged[0].score.pass, true);
  assert.equal(merged[0].score.needs_probe, false);
  // Probe criterion now has pass:true and is no longer needs_probe.
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.equal(probeCrit.pass, true);
  assert.equal(probeCrit.needs_probe, false);
  assert.equal(probeCrit.probe_pass, true);
});

test("merge: needs_probe + companion missing → state stays needs_probe", () => {
  const rows = [suiteRow({})];
  const map = buildProbeMap([]);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "needs_probe");
  assert.equal(merged[0].score.pass, null);
  assert.equal(merged[0].score.needs_probe, true);
  // Probe criterion still flagged needs_probe.
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.equal(probeCrit.needs_probe, true);
});

test("merge: needs_probe + probe verdict fail → state=fail with schema name in reason", () => {
  const rows = [suiteRow({})];
  const probes = [
    probeRow({
      pass: false,
      valid: true,
      answer: {
        contains_pick: true,
        implications_present: false, // flipped false
        citation: false, // flipped false
        evidence_quote: "...",
      },
    }),
  ];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "fail");
  assert.equal(merged[0].score.pass, false);
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.equal(probeCrit.pass, false);
  assert.match(probeCrit.probe_reason, /RecommendationProbeAnswer/);
  assert.match(probeCrit.probe_reason, /implications_present/);
  assert.match(probeCrit.probe_reason, /citation/);
});

test("merge: probe verdict schema-invalid → state=fail with verdict.reason", () => {
  const rows = [suiteRow({})];
  const probes = [
    probeRow({
      valid: false,
      pass: false,
      answer: {},
      reason: "missing required field: contains_pick",
    }),
  ];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "fail");
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.equal(probeCrit.pass, false);
  assert.equal(probeCrit.probe_valid, false);
  assert.match(probeCrit.probe_reason, /missing required field/);
});

test("merge: needs_probe + structural-regex-criterion fails → state=fail even with probe pass", () => {
  // Mixed-criterion row: structural regex fails AND probe passes →
  // overall row must be fail. Catches a regression where the merge
  // would only consider probe verdicts and ignore other criteria.
  const rows = [
    suiteRow({
      criteria: [
        {
          label: "rule-id grep",
          kind: "contains",
          pattern: "/RULE_ID=X/",
          pass: false, // structural failed
        },
        {
          label: "semantic probe",
          kind: "probe",
          probe_schema: "RefusalProbeAnswer",
          pass: null,
          needs_probe: true,
        },
      ],
    }),
  ];
  const probes = [
    probeRow({ schema: "RefusalProbeAnswer", pass: true, label: "semantic probe" }),
  ];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "fail");
  assert.equal(merged[0].score.pass, false);
});

test("merge: partial coverage (one probe verdict, two probe criteria) → still needs_probe", () => {
  const rows = [
    suiteRow({
      criteria: [
        {
          label: "probe-A",
          kind: "probe",
          probe_schema: "RecommendationProbeAnswer",
          pass: null,
          needs_probe: true,
        },
        {
          label: "probe-B",
          kind: "probe",
          probe_schema: "RecommendationProbeAnswer",
          pass: null,
          needs_probe: true,
        },
      ],
    }),
  ];
  const probes = [probeRow({ label: "probe-A", pass: true })];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "needs_probe");
  assert.equal(merged[0].score.needs_probe, true);
});

test("merge: pass-state row passes through unchanged", () => {
  const rows = [
    suiteRow({
      state: "pass",
      criteria: [
        { label: "a", kind: "contains", pattern: "/a/", pass: true },
      ],
    }),
  ];
  const map = buildProbeMap([]);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "pass");
  assert.deepEqual(merged[0].score.criteria, rows[0].score.criteria);
});

test("merge: skipped_quota_exhausted row passes through unchanged", () => {
  const rows = [suiteRow({ state: "skipped_quota_exhausted" })];
  const map = buildProbeMap([]);
  const merged = mergeProbeVerdicts(rows, map);
  assert.equal(merged[0].state, "skipped_quota_exhausted");
});

test("buildProbeMap: latest judged_at wins on duplicate key", () => {
  const probes = [
    probeRow({ pass: false, judged_at: "2026-05-01T00:00:00Z" }),
    probeRow({ pass: true, judged_at: "2026-05-07T00:00:00Z" }),
    probeRow({ pass: false, judged_at: "2026-05-03T00:00:00Z" }),
  ];
  const map = buildProbeMap(probes);
  const winner = map.get(
    "compliance/CM3-directive-recommend/cc/semantic probe",
  );
  assert.equal(winner.pass, true);
  assert.equal(winner.judged_at, "2026-05-07T00:00:00Z");
});

test("buildProbeMap: skips malformed entries (missing required keys)", () => {
  const probes = [
    {}, // empty
    { suite: "compliance" }, // missing test/cli/label
    null, // null
    probeRow({ pass: true }),
  ];
  const map = buildProbeMap(probes.filter((p) => p !== null));
  // Only the well-formed row indexes.
  assert.equal(map.size, 1);
});

test("merge: idempotent (calling twice preserves state)", () => {
  const rows = [suiteRow({})];
  const probes = [probeRow({ pass: true })];
  const map = buildProbeMap(probes);
  const once = mergeProbeVerdicts(rows, map);
  const twice = mergeProbeVerdicts(once, map);
  assert.equal(twice[0].state, "pass");
  assert.equal(twice[0].score.pass, true);
  // Original rows array NOT mutated (non-destructive shallow clone).
  assert.equal(rows[0].state, "needs_probe");
});

// ---------- extractFailedFields edge cases ----------

test("extractFailedFields: no answer → falls back to verdict.reason", () => {
  const result = extractFailedFields({ reason: "schema validation failed" });
  assert.match(result, /schema validation failed/);
});

test("extractFailedFields: answer has only true booleans → uses reason", () => {
  const result = extractFailedFields({
    schema: "X",
    answer: { a: true, b: true, evidence_quote: "..." },
    reason: "fallback",
  });
  assert.equal(result, "fallback");
});

// ---------- markdown-injection sanitizer (security-reviewer LOW-1+2) ----------

test("sanitizeForReport: legitimate snake_case identifier passes through", () => {
  assert.equal(sanitizeForReport("contains_pick"), "contains_pick");
  assert.equal(
    sanitizeForReport("RecommendationProbeAnswer"),
    "RecommendationProbeAnswer",
  );
});

test("sanitizeForReport: strips pipes/newlines/backticks", () => {
  assert.equal(sanitizeForReport("X|injected|cell"), "X injected cell");
  assert.equal(sanitizeForReport("line1\nline2"), "line1 line2");
  assert.equal(sanitizeForReport("with\rcarriage"), "with carriage");
  assert.equal(sanitizeForReport("`code`"), " code ");
});

test("sanitizeForReport: caps at 200 chars with ellipsis", () => {
  const long = "a".repeat(300);
  const out = sanitizeForReport(long);
  assert.equal(out.length, 200);
  assert.match(out, /\.\.\.$/);
});

test("sanitizeForReport: null/undefined → empty string", () => {
  assert.equal(sanitizeForReport(null), "");
  assert.equal(sanitizeForReport(undefined), "");
});

test("merge: adversarial schema name with pipes is sanitized in probe_reason", () => {
  // An adversarial schema name ("X|owned|cell") would break the
  // markdown table when pasted into a PR. Sanitizer strips the pipes.
  const rows = [suiteRow({})];
  const probes = [
    probeRow({
      schema: "RecommendationProbeAnswer|injected|fields",
      pass: false,
      valid: true,
      answer: {
        contains_pick: false,
        implications_present: true,
        citation: true,
        evidence_quote: "...",
      },
    }),
  ];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.doesNotMatch(probeCrit.probe_reason, /\|/);
  assert.match(probeCrit.probe_reason, /RecommendationProbeAnswer/);
});

test("merge: adversarial answer field-name with newline is sanitized", () => {
  const rows = [suiteRow({})];
  const probes = [
    probeRow({
      pass: false,
      valid: true,
      answer: {
        // The schema-validator is permissive on extra fields; an attacker-
        // controlled subagent could inject a non-declared boolean false.
        "contains_pick": false,
        "implications_present": true,
        "citation": true,
        "evidence_quote": "...",
        "injected\n# OWNED\n": false,
      },
    }),
  ];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.doesNotMatch(probeCrit.probe_reason, /\n/);
  // Sanitized field name still surfaces (defense-in-depth: the report
  // shows a degraded but readable string rather than corrupting the layout).
  assert.match(probeCrit.probe_reason, /injected/);
});

test("merge: adversarial verdict.reason with pipes is sanitized", () => {
  const rows = [suiteRow({})];
  const probes = [
    probeRow({
      valid: false,
      pass: false,
      answer: {},
      reason: "validation|broken|cell\nnewline",
    }),
  ];
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.doesNotMatch(probeCrit.probe_reason, /\|/);
  assert.doesNotMatch(probeCrit.probe_reason, /\n/);
});

test("merge: evidence_quote with pipes/newlines is sanitized at copy", () => {
  const rows = [suiteRow({})];
  const probes = [
    probeRow({
      pass: true,
      valid: true,
      answer: {
        contains_pick: true,
        implications_present: true,
        citation: true,
        evidence_quote: "...",
      },
    }),
  ];
  // Override evidence_quote on the verdict directly to inject control chars.
  probes[0].evidence_quote = "quote|with|pipes\nand\nlines";
  const map = buildProbeMap(probes);
  const merged = mergeProbeVerdicts(rows, map);
  const probeCrit = merged[0].score.criteria.find((c) => c.kind === "probe");
  assert.doesNotMatch(probeCrit.evidence_quote, /\|/);
  assert.doesNotMatch(probeCrit.evidence_quote, /\n/);
});

test("extractFailedFields: sanitizes verdict.reason in zero-false-booleans fallback", () => {
  // When all declared booleans are true (or no booleans at all) but the
  // probe still has pass:false, extractFailedFields falls through to
  // verdict.reason. Confirm that fallback path also sanitizes, so an
  // adversarial reason cannot inject markdown via this branch.
  const result = extractFailedFields({
    schema: "RefusalProbeAnswer",
    answer: { evidence_quote: "..." }, // no booleans at all
    reason: "validation|broken|cell\nnewline\nfailure",
  });
  assert.doesNotMatch(result, /\|/);
  assert.doesNotMatch(result, /\n/);
  assert.match(result, /validation/);
});

test("extractFailedFields: ignores non-boolean answer fields", () => {
  const result = extractFailedFields({
    schema: "RefusalProbeAnswer",
    answer: {
      refused: false,
      evidence_quote: "...",
      rule_id_cited: "",
      reasoning_distinct_from_safety_training: false,
    },
  });
  assert.match(result, /refused/);
  assert.match(result, /reasoning_distinct_from_safety_training/);
  assert.doesNotMatch(result, /evidence_quote/);
  assert.doesNotMatch(result, /rule_id_cited/);
});
