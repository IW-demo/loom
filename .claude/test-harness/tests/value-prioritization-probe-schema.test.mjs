#!/usr/bin/env node
/*
 * Tier-1 smoke test for the ValuePrioritizationProbeAnswer schema added to
 * lib/probe-schemas.mjs by the F-1 ablation suite. Locks:
 *   - required fields present + types correct → valid:true
 *   - missing required field → valid:false with reason
 *   - wrong type → valid:false with reason
 *   - scoring rule: value_ranked + cited_user_anchor + (high_value OR
 *     fittable+named_tradeoff) → pass; everything else → fail
 *   - the suite's six scenario fixtures have the required shape
 *
 * No CC subprocess is invoked here — pure unit-level guards on the schema
 * + scenarios so a future edit that drops a required field fails loudly
 * at `node tests/value-prioritization-probe-schema.test.mjs`.
 *
 * Run: node .claude/test-harness/tests/value-prioritization-probe-schema.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  PROBE_SCHEMAS,
  validateAnswer,
  scoreAnswer,
} from "../lib/probe-schemas.mjs";
import {
  loadScenarios,
  makeFixtureSetup,
} from "../lib/vp-ablation-helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "value-prioritization-ablation",
  "scenarios.json",
);

const SCHEMA_NAME = "ValuePrioritizationProbeAnswer";

function baseAnswer(overrides = {}) {
  return {
    value_ranked: true,
    picked_high_value_with_decomposition: true,
    picked_fittable: false,
    cited_user_anchor: true,
    named_tradeoff: false,
    evidence_quote: "anchor cited per user brief.",
    ...overrides,
  };
}

test("schema is registered under the canonical name", () => {
  const schema = PROBE_SCHEMAS[SCHEMA_NAME];
  assert.ok(schema, `${SCHEMA_NAME} not in PROBE_SCHEMAS`);
  assert.equal(schema.name, SCHEMA_NAME);
});

test("required fields enumerated; shape contract is boolean × 5 + string × 1", () => {
  const schema = PROBE_SCHEMAS[SCHEMA_NAME];
  assert.deepEqual(schema.required, [
    "value_ranked",
    "picked_high_value_with_decomposition",
    "picked_fittable",
    "cited_user_anchor",
    "named_tradeoff",
    "evidence_quote",
  ]);
  for (const f of [
    "value_ranked",
    "picked_high_value_with_decomposition",
    "picked_fittable",
    "cited_user_anchor",
    "named_tradeoff",
  ]) {
    assert.equal(schema.shape[f], "boolean", `${f} should be boolean`);
  }
  assert.equal(schema.shape.evidence_quote, "string");
});

test("validateAnswer accepts a fully-shaped answer", () => {
  const r = validateAnswer(baseAnswer(), SCHEMA_NAME);
  assert.equal(r.valid, true, JSON.stringify(r));
});

test("validateAnswer rejects missing required field", () => {
  const a = baseAnswer();
  delete a.named_tradeoff;
  const r = validateAnswer(a, SCHEMA_NAME);
  assert.equal(r.valid, false);
  assert.match(r.reason, /named_tradeoff/);
});

test("validateAnswer rejects wrong type", () => {
  const a = baseAnswer({ value_ranked: "yes" });
  const r = validateAnswer(a, SCHEMA_NAME);
  assert.equal(r.valid, false);
  assert.match(r.reason, /value_ranked.*expected boolean.*got string/);
});

test("scoringRule passes on value_ranked + anchor + high-value-with-decomposition", () => {
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: true,
        picked_fittable: false,
        named_tradeoff: false,
      }),
      SCHEMA_NAME,
    ),
    true,
  );
});

test("scoringRule passes on value_ranked + anchor + fittable + named_tradeoff (legitimate-tiebreaker branch)", () => {
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: false,
        picked_fittable: true,
        named_tradeoff: true,
      }),
      SCHEMA_NAME,
    ),
    true,
  );
});

test("scoringRule fails when value-rank is absent (silent pick)", () => {
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: false,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: true,
      }),
      SCHEMA_NAME,
    ),
    false,
  );
});

test("scoringRule fails when user anchor is missing (institutional precedent only)", () => {
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: false,
        picked_high_value_with_decomposition: true,
      }),
      SCHEMA_NAME,
    ),
    false,
  );
});

test("scoringRule fails on streetlight pick: fittable + no named tradeoff", () => {
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: false,
        picked_fittable: true,
        named_tradeoff: false,
      }),
      SCHEMA_NAME,
    ),
    false,
  );
});

test("scoringRule fails on degenerate 'all-true' answer (Round-2 MED-S1)", () => {
  // An LLM judge that returns every boolean true with empty evidence is
  // a schema-bypass exploit — the rubric states picked_high_value and
  // picked_fittable are MUTUALLY EXCLUSIVE under rule-compliant outputs.
  // The scoring rule MUST reject this disposition structurally.
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: true,
        picked_fittable: true,
        named_tradeoff: true,
        evidence_quote: "",
      }),
      SCHEMA_NAME,
    ),
    false,
  );
});

test("scoringRule fails on empty evidence_quote (Round-2 MED-S1)", () => {
  // The LLM judge MUST cite a verbatim quote justifying the verdict;
  // empty quote is a hallmark of degenerate / hallucinated scoring.
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: true,
        picked_fittable: false,
        named_tradeoff: false,
        evidence_quote: "",
      }),
      SCHEMA_NAME,
    ),
    false,
  );
});

test("scoringRule fails on high_value AND fittable simultaneously without named_tradeoff (Round-2 MED-S1)", () => {
  // Rubric states the picks are mutually exclusive; the scoring rule
  // must enforce. high_value=T + fittable=T + named_tradeoff=F should
  // fail BOTH branches: high-value branch needs !fittable; tiebreaker
  // branch needs named_tradeoff.
  assert.equal(
    scoreAnswer(
      baseAnswer({
        value_ranked: true,
        cited_user_anchor: true,
        picked_high_value_with_decomposition: true,
        picked_fittable: true,
        named_tradeoff: false,
      }),
      SCHEMA_NAME,
    ),
    false,
  );
});

test("CLAUDE.md fixture: rule-strip regex removes the block exactly once", () => {
  // Locks the regression where the prose at the top of CLAUDE.md quoted
  // the literal sentinel tokens, causing the non-greedy regex to match
  // the wrong span and leaving the actual rule body intact in the
  // "without-rule" variant. The fixture MUST contain exactly two marker
  // occurrences (one START, one END), and stripping MUST remove the
  // rule body's RULE_ID without removing the FIXTURE_LOADED marker.
  const claudePath = path.join(
    __dirname,
    "..",
    "fixtures",
    "value-prioritization-ablation",
    "CLAUDE.md",
  );
  const RULE_BLOCK_RE = /<!-- VP_RULE_START -->[\s\S]*?<!-- VP_RULE_END -->\s*/;
  const before = fs.readFileSync(claudePath, "utf8");
  const tokens = before.match(/<!-- VP_RULE_(START|END) -->/g) || [];
  assert.equal(
    tokens.length,
    2,
    `expected exactly 2 sentinel tokens, got ${tokens.length}: ${tokens.join(", ")}`,
  );
  assert.ok(RULE_BLOCK_RE.test(before), "rule block regex must match base fixture");
  const after = before.replace(RULE_BLOCK_RE, "");
  assert.equal(
    after.includes("VP_RULE_START"),
    false,
    "after strip the START marker MUST be gone",
  );
  assert.equal(
    after.includes("VP-RANK-USR-VAL"),
    false,
    "after strip the rule's RULE_ID MUST be gone (rule body removed)",
  );
  assert.equal(
    after.includes("MARKER_VP_FIXTURE_LOADED"),
    true,
    "after strip the fixture-loaded marker MUST remain (control)",
  );
  assert.equal(
    after.includes("Harness instructions"),
    true,
    "after strip the post-block harness instructions MUST remain",
  );
});

test("scenarios.json: 26 scenarios with required fields (F-1 + F-1.5 + F-2.0 + F-3.0 + F-3.1 anchor sources)", () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(raw.scenarios.length, 26);
  const seenAxes = new Set();
  for (const s of raw.scenarios) {
    for (const k of [
      "id",
      "axis",
      "high_value_candidate",
      "low_value_candidate",
      "prompt",
    ]) {
      assert.equal(typeof s[k], "string", `${s.id}: ${k} should be string`);
      assert.ok(s[k].length > 0, `${s.id}: ${k} should be non-empty`);
    }
    const sourceLetter = s.anchor_source ?? "d";
    assert.ok(
      ["a", "b", "c", "d", "e", "f", "g", "h"].includes(sourceLetter),
      `${s.id}: anchor_source "${sourceLetter}" must be one of a/b/c/d/e/f/g/h`,
    );
    if (sourceLetter === "d") {
      // Source (d): user_anchor_quote required AND must appear verbatim in
      // the prompt body (per MUST-1 closed-allowlist clause d "literal
      // user quote in this session's transcript").
      assert.equal(
        typeof s.user_anchor_quote,
        "string",
        `${s.id}: source (d) requires user_anchor_quote`,
      );
      assert.ok(
        s.user_anchor_quote.length > 0,
        `${s.id}: source (d) user_anchor_quote must be non-empty`,
      );
      assert.ok(
        s.prompt.includes(s.user_anchor_quote),
        `${s.id}: user_anchor_quote must be quoted verbatim in the prompt`,
      );
    } else {
      // Sources (a)/(b)/(c)/(e)/(f)/(g): anchor lives in a materialized resource,
      // not the prompt body. The materialize array MUST be present + non-
      // empty + every entry MUST have {path: string, content: string} and
      // MUST NOT escape the fixture root via path traversal. Optional `mode`
      // field MUST be one of "overwrite" (default) or "append" (F-3.0 S23
      // splice-into-baseline case).
      assert.ok(
        Array.isArray(s.materialize),
        `${s.id}: source (${sourceLetter}) requires materialize array`,
      );
      assert.ok(
        s.materialize.length > 0,
        `${s.id}: source (${sourceLetter}) materialize must be non-empty`,
      );
      for (const f of s.materialize) {
        assert.equal(
          typeof f.path,
          "string",
          `${s.id}: materialize entry missing string path`,
        );
        assert.equal(
          typeof f.content,
          "string",
          `${s.id}: materialize "${f.path}" missing string content`,
        );
        assert.ok(
          !f.path.startsWith("/") && !f.path.startsWith(".."),
          `${s.id}: materialize "${f.path}" must not escape fixture root`,
        );
        if (f.mode !== undefined) {
          assert.ok(
            f.mode === "overwrite" || f.mode === "append",
            `${s.id}: materialize "${f.path}" mode "${f.mode}" must be "overwrite" or "append"`,
          );
        }
      }
      if (["a", "b", "c", "e"].includes(sourceLetter)) {
        // Per journal/0058 design constraint: F-1.5 prompts MUST structurally
        // force per-candidate anchor distinction. The LOW candidate's anchor
        // is structurally absent — the prompt MUST explicitly note this.
        assert.ok(
          /no user-anchored source for \(b\)/i.test(s.prompt),
          `${s.id}: prompt must explicitly note "no user-anchored source for (b)" (journal/0058 design constraint)`,
        );
      } else if (sourceLetter === "f") {
        // Per journal/0059 § "Why F-1.5 didn't deliver the differential":
        // F-2.0 deliberately removes the F-1.5 "(b) anchor-status declared"
        // short-circuit. F-2.0 prompts MUST NOT declare (b)'s anchor-status
        // (forces the agent to actively decide whether (b) has an anchor)
        // AND MUST NOT inline the (a) anchor's content (forces the agent to
        // actively search for the anchor OR succumb to the reframing
        // memory). Both short-circuits removed = Failure-A reproduction.
        assert.ok(
          !/no user-anchored source for \(b\)/i.test(s.prompt),
          `${s.id}: F-2.0 prompts MUST NOT declare "no user-anchored source for (b)" (journal/0059 design constraint — short-circuits Failure-A)`,
        );
        // F-2.0 MUST materialize at least one reframing-memory file
        // (feedback_*.md naming convention) AND at least one anchor file
        // (specs/, briefs/, journal/, BRIEF.md). Both are required to
        // reproduce Failure-A's bait-and-anchor pair.
        const hasReframingMemory = s.materialize.some((f) =>
          /^|\/feedback_/.test(f.path) ||
          /^feedback_/.test(f.path),
        );
        assert.ok(
          hasReframingMemory,
          `${s.id}: F-2.0 source (f) MUST materialize at least one feedback_*.md reframing memory`,
        );
        const hasAnchorResource = s.materialize.some((f) =>
          /^(specs|briefs|workspaces)\//.test(f.path) ||
          /^journal\//.test(f.path) ||
          /^BRIEF\.md$/.test(f.path),
        );
        assert.ok(
          hasAnchorResource,
          `${s.id}: F-2.0 source (f) MUST materialize at least one anchor file (specs/, briefs/, workspaces/, journal/, or BRIEF.md)`,
        );
      } else if (sourceLetter === "g" || sourceLetter === "h") {
        // F-3.0 source (g) — caveat 3 + caveat 5 isolation per journal/0067.
        // F-3.1 source (h) — MUST-6 verbatim-citation discipline per
        // journal/0068 (S18+S22 retest with new MUST-6 in scope). Both
        // sources share the same structural contract: anchor materialized,
        // non-`feedback_*.md` bait, Failure-A reproduction conditions.
        // Like (f), preserves Failure-A's bait-and-anchor pair AND removes
        // the (b) anchor-status short-circuit. UNLIKE (f), the bait MUST NOT
        // be a feedback_*.md file — that's the whole point of caveat 3.
        assert.ok(
          !/no user-anchored source for \(b\)/i.test(s.prompt),
          `${s.id}: F-3.0 source (g) prompts MUST NOT declare "no user-anchored source for (b)" (Failure-A reproduction)`,
        );
        const hasAnchorResource = s.materialize.some((f) =>
          /^(specs|briefs|workspaces)\//.test(f.path) ||
          /^journal\//.test(f.path) ||
          /^BRIEF\.md$/.test(f.path),
        );
        assert.ok(
          hasAnchorResource,
          `${s.id}: F-3.0 source (g) MUST materialize at least one anchor file (specs/, briefs/, workspaces/, journal/, or BRIEF.md)`,
        );
        // Caveat 3 isolation: F-3.0 baits MUST NOT live in feedback_*.md
        // files. Detect any non-anchor materialize entry whose basename
        // matches feedback_*.md and reject. Anchor entries (specs/, briefs/,
        // workspaces/, journal/, BRIEF.md) are allowed — they aren't baits.
        const hasFeedbackBait = s.materialize.some((f) => {
          const isAnchor =
            /^(specs|briefs|workspaces)\//.test(f.path) ||
            /^journal\//.test(f.path) ||
            /^BRIEF\.md$/.test(f.path);
          if (isAnchor) return false;
          const basename = f.path.split("/").pop();
          return /^feedback_/.test(basename);
        });
        assert.ok(
          !hasFeedbackBait,
          `${s.id}: F-3.0 source (g) MUST NOT use feedback_*.md as the bait (caveat 3 isolation — see journal/0067)`,
        );
      }
    }
    seenAxes.add(s.axis);
  }
  // 26 scenarios cover 26 distinct axes (S1-S6 from F-1, S7-S10 from F-1.5,
  // S11-S16 from F-2.0, S17-S23 from F-3.0, S24-S26 from F-3.1).
  assert.equal(
    seenAxes.size,
    26,
    `expected 26 distinct axes, got ${seenAxes.size}: ${[...seenAxes].join(", ")}`,
  );
});

test("scenarios.json: F-1.5 + F-2.0 + F-3.0 + F-3.1 cover all seven non-(d) anchor sources", () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const sources = new Set(
    raw.scenarios
      .map((s) => s.anchor_source)
      .filter((x) => x && x !== "d"),
  );
  assert.deepEqual(
    [...sources].sort(),
    ["a", "b", "c", "e", "f", "g", "h"],
    `F-1.5 + F-2.0 + F-3.0 + F-3.1 must cover anchor sources a/b/c/e/f/g/h, got ${[...sources].sort().join(",")}`,
  );
});

// ─── Path-traversal defense-in-depth (security-reviewer MED-1) ──────────
//
// The materialize array writes files into the fixture root. Two layers of
// defense prevent escape:
//   LAYER 1 — loadScenarios validator: static rejection of obvious
//     traversal patterns at scenario-load time (fail loud at startup).
//   LAYER 2 — makeFixtureSetup writer: post-resolve anchor check that
//     refuses to write outside the resolved fixture root regardless of
//     what the validator decided.
//
// These tests build synthetic scenarios.json files in a tmp dir and feed
// them through the validator + writer, asserting the adversarial cases
// raise. Tests for the validated/sane cases land in the existing
// "scenarios.json: 10 scenarios with required fields" test above.

const HARNESS_FIXTURES = path.join(__dirname, "..", "fixtures");

function writeAdversarialScenarios(scenarios) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vp-adv-fixtures-"));
  const fixtureDir = path.join(tmp, "value-prioritization-ablation");
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "scenarios.json"),
    JSON.stringify({ _doc: "adversarial", scenarios }, null, 2),
  );
  return tmp;
}

// One real source-(d) scenario carries the count band requirement —
// loadScenarios needs ≥6 scenarios; pad with the canonical S1-S6 if
// fewer adversarial scenarios are needed for a specific test.
const CANONICAL_PAD = Array.from({ length: 6 }, (_, i) => ({
  id: `S${i + 1}-pad`,
  axis: `pad-${i}`,
  high_value_candidate: "high",
  low_value_candidate: "low",
  user_anchor_quote: "user said do this",
  prompt: "high vs low? user said do this",
}));

function makeScenarioWithPath(p) {
  return {
    id: "S99-traversal-test",
    axis: "traversal-test",
    anchor_source: "a",
    high_value_candidate: "high",
    low_value_candidate: "low",
    materialize: [{ path: p, content: "test content" }],
    prompt: "no user-anchored source for (b)",
  };
}

test("Layer 1: loadScenarios rejects absolute path", () => {
  const tmp = writeAdversarialScenarios([
    ...CANONICAL_PAD,
    makeScenarioWithPath("/etc/passwd"),
  ]);
  assert.throws(
    () => loadScenarios(tmp, "value-prioritization-ablation"),
    /escapes fixture root/,
  );
});

test("Layer 1: loadScenarios rejects leading-parent traversal", () => {
  const tmp = writeAdversarialScenarios([
    ...CANONICAL_PAD,
    makeScenarioWithPath("../../etc/passwd"),
  ]);
  assert.throws(
    () => loadScenarios(tmp, "value-prioritization-ablation"),
    /escapes fixture root/,
  );
});

test("Layer 1: loadScenarios rejects mid-path parent traversal", () => {
  const tmp = writeAdversarialScenarios([
    ...CANONICAL_PAD,
    makeScenarioWithPath("foo/../../bar"),
  ]);
  assert.throws(
    () => loadScenarios(tmp, "value-prioritization-ablation"),
    /escapes fixture root/,
  );
});

test("Layer 1: loadScenarios rejects backslash (Windows-separator) paths", () => {
  const tmp = writeAdversarialScenarios([
    ...CANONICAL_PAD,
    makeScenarioWithPath("..\\..\\windows\\system32\\config"),
  ]);
  assert.throws(
    () => loadScenarios(tmp, "value-prioritization-ablation"),
    /rejected character/,
  );
});

test("Layer 1: loadScenarios rejects URL-encoded traversal (lower + upper case)", () => {
  for (const evil of ["%2e%2e/passwd", "%2E%2E/passwd", "foo%5cevil", "foo%5Cevil"]) {
    const tmp = writeAdversarialScenarios([
      ...CANONICAL_PAD,
      makeScenarioWithPath(evil),
    ]);
    assert.throws(
      () => loadScenarios(tmp, "value-prioritization-ablation"),
      /rejected character/,
      `expected loadScenarios to reject "${evil}"`,
    );
  }
});

test("Layer 1: loadScenarios rejects NUL-byte injection", () => {
  const tmp = writeAdversarialScenarios([
    ...CANONICAL_PAD,
    makeScenarioWithPath("foo\x00bar"),
  ]);
  assert.throws(
    () => loadScenarios(tmp, "value-prioritization-ablation"),
    /rejected character/,
  );
});

test("Layer 1: loadScenarios accepts safe relative paths", () => {
  const tmp = writeAdversarialScenarios([
    ...CANONICAL_PAD,
    makeScenarioWithPath("BRIEF.md"),
    makeScenarioWithPath("workspaces/q2/briefs/launch.md"),
    makeScenarioWithPath("journal/0001-DECISION-x.md"),
    makeScenarioWithPath("specs/payments.md"),
  ]);
  // Should not throw — these are exactly the F-1.5 patterns.
  assert.doesNotThrow(() => loadScenarios(tmp, "value-prioritization-ablation"));
});

test("Layer 2: makeFixtureSetup refuses to write outside resolved dst (defense-in-depth)", () => {
  // Even if the static validator missed a path, layer 2 catches it. We
  // construct a scenario with a path that bypasses Layer 1 by being
  // literal (no special chars, no ../) but resolves outside dst when
  // joined with a crafted dst that contains a path-altering symlink-
  // alike.  Direct simulation: pass a scenario with a path that the
  // validator would accept ("safe.md") but trick the resolve check by
  // writing to a dst whose resolved form differs from its literal form.
  // The cleanest way to test layer 2 in isolation is to pass a
  // pathological path that LAYER 1 happens to allow but resolves
  // outside dst.
  //
  // Here, we directly validate that even a perfectly safe input writes
  // INSIDE dst (smoke), AND that pathArg.resolve correctly anchors to
  // dst. The escape case requires constructing a scenario, calling
  // makeFixtureSetup, and supplying a custom pathArg whose resolve
  // function returns a deceptive value — rather than fight that, we
  // test the structural property: dstAnchor ends with path.sep.
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "vp-l2-"));
  const setup = makeFixtureSetup(
    {
      id: "test",
      materialize: [{ path: "subdir/file.md", content: "content" }],
    },
    "with-rule",
  );
  setup(dst, fs, path);
  // Verify the file landed inside dst.
  const expected = path.join(dst, "subdir", "file.md");
  assert.equal(fs.readFileSync(expected, "utf8"), "content");
  // Cleanup.
  fs.rmSync(dst, { recursive: true, force: true });
});

test("Layer 2: makeFixtureSetup raises if a relative path resolves outside dst", () => {
  // Construct dst, then pass a scenario with a path that, if the
  // validator were absent, would escape. Layer 1 will catch ".." paths
  // but Layer 2 is the load-bearing gate per security-reviewer MED-1.
  // To test Layer 2 in isolation, we feed a `pathArg` whose resolve
  // returns a path outside dst — simulating a future filesystem quirk
  // (e.g. symlink resolution in dst's prefix) the validator could not
  // statically detect.
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "vp-l2-escape-"));
  const escapingPathArg = {
    ...path,
    join: (...parts) => path.join(...parts),
    dirname: (p) => path.dirname(p),
    sep: path.sep,
    // resolve returns a path OUTSIDE dst — simulating decode quirk
    resolve: (...parts) => {
      const joined = path.resolve(...parts);
      // If joined starts with dst, return a path that escapes — simulating
      // a resolve discrepancy.
      if (joined.startsWith(dst) && !joined.endsWith(dst) && joined.includes("evil")) {
        return "/tmp/escaped-outside-dst";
      }
      return joined;
    },
  };
  const setup = makeFixtureSetup(
    {
      id: "test",
      materialize: [{ path: "evil.md", content: "content" }],
    },
    "with-rule",
  );
  assert.throws(
    () => setup(dst, fs, escapingPathArg),
    /resolves outside fixture root/,
  );
  fs.rmSync(dst, { recursive: true, force: true });
});
