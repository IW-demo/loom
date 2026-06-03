#!/usr/bin/env node
/*
 * Value-prioritization ablation test (F-1 from
 * .claude/guides/rule-extracts/value-prioritization.md § "Deferred follow-ups").
 *
 * Behavioral A/B subprocess test: spawns CC TWICE per scenario, once with
 * the value-prioritization rule loaded into the fixture's CLAUDE.md and
 * once with the rule's MUST clauses stripped from the same baseline. Each
 * scenario pairs a HIGH-value-needs-decomposition candidate against a
 * LOW-value-fits-shard candidate.
 *
 * S1-S6 (F-1, regression baseline): user-anchored signal lives as a literal
 * user quote in the prompt body (closed-allowlist source (d) per
 * rules/value-prioritization.md MUST-1).
 *
 * S7-S10 (F-1.5, issue #86): user-anchored signal lives in an external
 * resource the agent must READ (closed-allowlist sources (a)-session brief,
 * (b)-workspace briefs/, (c)-journal DECISION, (e)-spec § success criterion).
 * Each F-1.5 scenario declares a `materialize` array; the runner pre-writes
 * those files into the fixture root before git init, so the agent reads
 * them via cwd at runtime. Each F-1.5 scenario also structurally forces
 * per-candidate anchor distinction (journal/0058): HIGH names an explicit
 * anchor source, LOW explicitly notes "no user-anchored source for (b)".
 *
 * Per rules/probe-driven-verification.md MUST-1, scoring is probe-driven —
 * regex matching against semantic claims is BLOCKED. The runner emits
 * `kind: "probe"` criteria with schema `ValuePrioritizationProbeAnswer`
 * (lib/probe-schemas.mjs) plus a `variant: "with-rule" | "without-rule"`
 * tag on each row; a CC-session orchestrator (`/test-harness-probe`)
 * dispatches subagent judges, validates each subagent's JSON answer
 * against the schema, and writes a `<basename>.probes.jsonl` companion.
 *
 * Per rules/loom-csq-boundary.md Rule 1, this is single-CLI (CC-only)
 * authoring-side smoke; it is NOT a parity matrix and MUST NOT grow into
 * one. csq's `coc-eval/` is the canonical multi-CLI evaluator.
 *
 * NOT WIRED INTO run-all.sh — opt-in invocation only. Each suite run
 * spawns 2 CC subprocesses per scenario (with-rule + without-rule),
 * incurring real Anthropic API cost on the parent CC session's auth. Full
 * 10-scenario run = 20 invocations. Restrict to a single scenario for dev:
 *
 *   node .claude/test-harness/tests/value-prioritization-ablation.test.mjs
 *   node .claude/test-harness/tests/value-prioritization-ablation.test.mjs --scenario S7-anchor-source-a-session-brief
 *
 * After the run, in a CC session at loom/:
 *   /test-harness-probe results/value-prioritization-ablation-<ts>.jsonl
 *
 * Then aggregate to compute the differential pass-rate per variant.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runTest,
  prepareFixture,
  setResultsFile,
  suiteHeader,
  FIXTURES_DIR,
} from "../lib/harness.mjs";
import {
  loadScenarios as loadScenariosImpl,
  makeFixtureSetup,
} from "../lib/vp-ablation-helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUITE_NAME = "value-prioritization-ablation";
const FIXTURE = "value-prioritization-ablation";

// Validator + fixture-setup live in lib/vp-ablation-helpers.mjs as a
// single source of truth so the unit-test layer can verify the path-
// traversal defense-in-depth gates without re-importing this runner
// (which would re-trigger top-level execution + paid CC subprocesses).
function loadScenarios() {
  return loadScenariosImpl(FIXTURES_DIR, FIXTURE);
}

// Per-scenario probe criterion. The schema name is the contract; the
// orchestrator looks it up in lib/probe-schemas.mjs::PROBE_SCHEMAS.
function buildCriteria(scenario, variant) {
  return [
    {
      kind: "probe",
      schema: "ValuePrioritizationProbeAnswer",
      label: `VP ablation [${variant}] ${scenario.id}: value-rank + anchor + pick (probe)`,
    },
  ];
}

// ─── Run ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
// Allow restricting to a single scenario via --scenario S<N>... for dev.
const scenarioFilter = args.includes("--scenario")
  ? args[args.indexOf("--scenario") + 1]
  : null;
// Allow restricting to scenarios with a specific anchor_source letter
// (F-1.5 used a/b/c/e; F-2.0 uses f). Useful for running JUST the F-2.0
// Failure-A reproduction cycle without re-running the F-1+F-1.5 baseline.
const anchorSourceFilter = args.includes("--anchor-source")
  ? args[args.indexOf("--anchor-source") + 1]
  : null;

const scenarios = loadScenarios();
let filtered = scenarios;
if (scenarioFilter) {
  filtered = filtered.filter((s) => s.id === scenarioFilter);
}
if (anchorSourceFilter) {
  filtered = filtered.filter(
    (s) => (s.anchor_source ?? "d") === anchorSourceFilter,
  );
}
if ((scenarioFilter || anchorSourceFilter) && filtered.length === 0) {
  console.error(
    `no scenario matches filters scenario=${scenarioFilter} anchor-source=${anchorSourceFilter}`,
  );
  process.exit(1);
}

setResultsFile(`${SUITE_NAME}-${Date.now()}.jsonl`);
suiteHeader(SUITE_NAME);

const VARIANTS = ["with-rule", "without-rule"];
const results = [];

console.log(
  `Running ${filtered.length} scenario(s) × ${VARIANTS.length} variants ` +
    `= ${filtered.length * VARIANTS.length} CC subprocess invocations.`,
);
console.log(
  `Each invocation incurs real Anthropic API cost on the parent CC session's auth.`,
);

for (const scenario of filtered) {
  for (const variant of VARIANTS) {
    const fixtureRoot = prepareFixture(FIXTURE, makeFixtureSetup(scenario, variant));
    const testName = `${scenario.id}__${variant}`;
    const criteria = buildCriteria(scenario, variant);
    console.log(
      `[RUN]  ${SUITE_NAME} ${testName} cli=cc axis=${scenario.axis}...`,
    );
    const rec = await runTest(
      SUITE_NAME,
      testName,
      "cc",
      fixtureRoot,
      scenario.prompt,
      criteria,
    );
    // Annotate the recorded row with the ablation tags so the probe
    // orchestrator and aggregator can join verdicts on (scenario, variant).
    rec.ablation = {
      scenario_id: scenario.id,
      axis: scenario.axis,
      variant,
      high_value_candidate: scenario.high_value_candidate,
      low_value_candidate: scenario.low_value_candidate,
    };
    const verdict =
      rec.state === "needs_probe"
        ? "PROBE"
        : rec.state === "skipped_quota_exhausted"
          ? "SKIP"
          : rec.score.pass
            ? "PASS"
            : "FAIL";
    console.log(
      `[${verdict}] ${SUITE_NAME} ${testName} runtime=${rec.runtimeMs}ms`,
    );
    results.push(rec);
  }
}

// ─── Summary ─────────────────────────────────────────────────────

const byVariant = { "with-rule": 0, "without-rule": 0 };
const probesByVariant = { "with-rule": 0, "without-rule": 0 };
for (const r of results) {
  if (r.state === "needs_probe") {
    probesByVariant[r.ablation.variant]++;
  }
  byVariant[r.ablation.variant]++;
}

console.log(`\n=== VALUE-PRIORITIZATION ABLATION SUMMARY ===`);
for (const v of VARIANTS) {
  console.log(
    `  ${v.padEnd(14)} ${byVariant[v]} runs, ${probesByVariant[v]} need probe scoring`,
  );
}
const totalProbes = probesByVariant["with-rule"] + probesByVariant["without-rule"];
if (totalProbes > 0) {
  console.log(
    `\n${totalProbes} probe rows pending — run \`/test-harness-probe\` ` +
      `in a CC session at loom/ to dispatch subagent judges.`,
  );
  console.log(
    `\nNext: probe scoring + aggregation produces the F-1 / F-1.5 differential.`,
  );
  console.log(
    `  F-1 baseline (anchor source (d), S1-S6): historical +17pp differential`,
  );
  console.log(
    `  with-rule = 6/6, without-rule ~5/6 (per journal/0058).`,
  );
  console.log(
    `  F-1.5 prediction (anchor sources (a/b/c/e), S7-S10): without-rule`,
  );
  console.log(
    `  baseline ≤2/6 if rule's empirical claim validated (issue #86 AC).`,
  );
}
