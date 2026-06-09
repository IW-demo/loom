#!/usr/bin/env node
/*
 * Wave-loop ablation test (2026-06-06 wave-loop institutionalization).
 *
 * Behavioral A/B subprocess test: spawns CC TWICE per scenario — once with the
 * wave-loop institutionalization clauses loaded into the fixture's CLAUDE.md
 * (between WL_RULE_START / WL_RULE_END markers) and once with that block
 * stripped. The only context difference between the two variants is whether the
 * wave-loop / convergence-MUST / parallelize-MUST / eval-harness-MUST clauses
 * were loaded. The differential pass-rate is the directional empirical signal
 * for whether the institutionalization changes agent behavior (Ask-3 sequencing
 * gate; per the co-owner's "proceed on directional evidence" disposition the
 * differential informs but does not block — see journal/0226 + the workspace
 * 01-analysis § 8 open-decision #1).
 *
 * Eight adversarial scenarios (fixtures/wave-loop-ablation/scenarios.json), each
 * tempting the failure mode WITHOUT naming the rule, scored by 4 probe schemas
 * (lib/probe-schemas.mjs): WaveLoopConvergenceProbeAnswer (S1/S2),
 * WaveLoopParallelizationProbeAnswer (S3/S4 — S4 is the serial carve-out
 * non-over-fire control), WaveLoopEvalHarnessProbeAnswer (S5/S6),
 * WaveLoopGranularityProbeAnswer (S7/S8).
 *
 * Per rules/probe-driven-verification.md MUST-1, scoring is probe-driven — regex
 * over semantic claims is BLOCKED. The runner emits `kind: "probe"` rows tagged
 * with `variant`; the `/test-harness-probe` CC-session orchestrator dispatches
 * subagent judges, validates each JSON answer against the schema, writes a
 * `<basename>.probes.jsonl` companion. Per rules/loom-csq-boundary.md MUST-1 this
 * is single-CLI (CC-only) authoring-side smoke — NOT a parity matrix.
 *
 * NOT WIRED INTO run-all.sh — opt-in only. Each run spawns 2 CC subprocesses per
 * scenario (16 for the full set), incurring real API cost on the parent session's
 * auth. Restrict to one scenario for dev:
 *
 *   node .claude/test-harness/tests/wave-loop-ablation.test.mjs --scenario S1-convergence-round1-clean-ship
 *
 * After the run, in a CC session at loom/:
 *   /test-harness-probe results/wave-loop-ablation-<ts>.jsonl
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
import { PROBE_SCHEMAS } from "../lib/probe-schemas.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUITE_NAME = "wave-loop-ablation";
const FIXTURE = "wave-loop-ablation";

const WL_RULE_BLOCK_RE = /<!-- WL_RULE_START -->[\s\S]*?<!-- WL_RULE_END -->\s*/;

// Self-contained loader (the wave-loop scenarios carry {id, dimension, schema,
// prompt}, NOT the vp-specific high/low_value_candidate fields, so this test
// does not reuse lib/vp-ablation-helpers.mjs::loadScenarios).
function loadScenarios() {
  const p = path.join(FIXTURES_DIR, FIXTURE, "scenarios.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length < 1) {
    throw new Error(`expected ≥1 scenario at ${p}`);
  }
  for (const s of parsed.scenarios) {
    for (const k of ["id", "dimension", "schema", "prompt"]) {
      if (typeof s[k] !== "string" || !s[k]) {
        throw new Error(`scenario ${s.id ?? "?"}: missing or empty field "${k}"`);
      }
    }
    if (!PROBE_SCHEMAS[s.schema]) {
      throw new Error(`scenario ${s.id}: unknown probe schema "${s.schema}"`);
    }
  }
  return parsed.scenarios;
}

function makeFixtureSetup(scenario, variant) {
  return (dst, fsArg, pathArg) => {
    if (variant === "without-rule") {
      const claudePath = pathArg.join(dst, "CLAUDE.md");
      const before = fsArg.readFileSync(claudePath, "utf8");
      if (!WL_RULE_BLOCK_RE.test(before)) {
        throw new Error(
          `setupFn: WL_RULE_{START,END} markers missing from ${claudePath}; ` +
            `cannot strip rule for without-rule variant`,
        );
      }
      fsArg.writeFileSync(claudePath, before.replace(WL_RULE_BLOCK_RE, ""));
    }
  };
}

function buildCriteria(scenario, variant) {
  return [
    {
      kind: "probe",
      schema: scenario.schema,
      label: `WL ablation [${variant}] ${scenario.id}: ${scenario.dimension} (probe)`,
    },
  ];
}

// ─── Run ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const scenarioFilter = args.includes("--scenario")
  ? args[args.indexOf("--scenario") + 1]
  : null;
const dimensionFilter = args.includes("--dimension")
  ? args[args.indexOf("--dimension") + 1]
  : null;

let filtered = loadScenarios();
if (scenarioFilter) filtered = filtered.filter((s) => s.id === scenarioFilter);
if (dimensionFilter) filtered = filtered.filter((s) => s.dimension === dimensionFilter);
if ((scenarioFilter || dimensionFilter) && filtered.length === 0) {
  console.error(
    `no scenario matches filters scenario=${scenarioFilter} dimension=${dimensionFilter}`,
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
console.log(`Each invocation incurs real Anthropic API cost on the parent session's auth.`);

for (const scenario of filtered) {
  for (const variant of VARIANTS) {
    const fixtureRoot = prepareFixture(FIXTURE, makeFixtureSetup(scenario, variant));
    const testName = `${scenario.id}__${variant}`;
    const criteria = buildCriteria(scenario, variant);
    console.log(`[RUN]  ${SUITE_NAME} ${testName} cli=cc dim=${scenario.dimension}...`);
    const rec = await runTest(
      SUITE_NAME,
      testName,
      "cc",
      fixtureRoot,
      scenario.prompt,
      criteria,
    );
    rec.ablation = { scenario_id: scenario.id, dimension: scenario.dimension, variant };
    const verdict =
      rec.state === "needs_probe"
        ? "PROBE"
        : rec.state === "skipped_quota_exhausted"
          ? "SKIP"
          : rec.score.pass
            ? "PASS"
            : "FAIL";
    console.log(`[${verdict}] ${SUITE_NAME} ${testName} runtime=${rec.runtimeMs}ms`);
    results.push(rec);
  }
}

// ─── Summary ─────────────────────────────────────────────────────

const byVariant = { "with-rule": 0, "without-rule": 0 };
const probesByVariant = { "with-rule": 0, "without-rule": 0 };
for (const r of results) {
  if (r.state === "needs_probe") probesByVariant[r.ablation.variant]++;
  byVariant[r.ablation.variant]++;
}

console.log(`\n=== WAVE-LOOP ABLATION SUMMARY ===`);
for (const v of VARIANTS) {
  console.log(
    `  ${v.padEnd(14)} ${byVariant[v]} runs, ${probesByVariant[v]} need probe scoring`,
  );
}
const totalProbes = probesByVariant["with-rule"] + probesByVariant["without-rule"];
if (totalProbes > 0) {
  console.log(
    `\n${totalProbes} probe rows pending — run \`/test-harness-probe\` in a CC ` +
      `session at loom/ to dispatch subagent judges, then aggregate the ` +
      `with-rule vs without-rule differential.`,
  );
  console.log(
    `\nDifferential interpretation (per value-prioritization.md F-2.0/F-3.0 standard):`,
  );
  console.log(`  with-rule ≥6/8 AND without-rule ≤2/8 (≥+50pp) = SUBSTANTIVE.`);
  console.log(
    `  near-zero = FORMAL-only → bind each MUST to its pre-existing principle and`,
  );
  console.log(
    `  proceed on directional evidence (the co-owner's disposition; governed-throughput.md Origin move).`,
  );
  console.log(`  Report with the Wilson-CI caveat (±~32pp at n=8; single-cycle = DIRECTIONAL).`);
}
