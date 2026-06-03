#!/usr/bin/env node
/*
 * Smoke test for .claude/bin/emit.mjs shape contracts (Shard A — CDX-1/2/3).
 *
 * Tier 1 (deterministic, no LLM, no network). Asserts the three shape
 * contracts the /cli-audit 2026-05-10 surfaced as broken on AGENTS.md /
 * GEMINI.md emission:
 *
 *   CDX-1 — `stripRuleFrontmatter` removes the leading
 *           `---\npriority: 0\nscope: baseline\n---\n` block; emitted
 *           baseline contains zero `^priority: 0$` / `^scope: baseline$`
 *           lines (the per-rule frontmatter must not survive into the
 *           Codex/Gemini-rendered prose).
 *   CDX-2 — emitted baseline ends with a structural terminator
 *           (`\n---\n`), not the trailing prose of the last rule.
 *   CDX-3 — emitted baseline contains zero `^# <filename>.md$` H1
 *           prefixes (each rule's natural H1 is the boundary marker).
 *
 * Run: node .claude/test-harness/tests/emit-shape.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripRuleFrontmatter,
  emitBaseline,
  loadPerRuleBudgets,
  loadBudgetBlockThreshold,
  loadBudgetTolerance,
  loadCliCaps,
  validateAggregateHeadroom,
  validateTierCompleteness,
  validateManifestYaml,
  parseArgs,
} from "../../bin/emit.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

// ---------- stripRuleFrontmatter unit ----------

test("stripRuleFrontmatter removes leading priority/scope block", () => {
  const input = `---
priority: 0
scope: baseline
---

# Zero-Tolerance Rules

body content here
`;
  const out = stripRuleFrontmatter(input);
  assert.equal(
    out,
    "\n# Zero-Tolerance Rules\n\nbody content here\n",
    "leading frontmatter block must be stripped, body preserved verbatim",
  );
});

test("stripRuleFrontmatter is no-op when no frontmatter present", () => {
  const input = "# Header\n\nbody\n";
  assert.equal(stripRuleFrontmatter(input), input);
});

test("stripRuleFrontmatter strips path-scoped frontmatter (priority:10 + paths:)", () => {
  const input = `---
priority: 10
scope: path-scoped
paths:
  - "**/*.py"
---

# Path-scoped rule

body
`;
  const out = stripRuleFrontmatter(input);
  assert.ok(!/^priority:/m.test(out), "no priority line survives");
  assert.ok(!/^scope:/m.test(out), "no scope line survives");
  assert.ok(!/^paths:/m.test(out), "no paths line survives");
  assert.ok(out.startsWith("\n# Path-scoped rule"), "body preserved");
});

// ---------- emitBaseline integration (dry-run) ----------

function emitDryRun(cli) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `emit-shape-${cli}-`));
  const result = emitBaseline(cli, path.join(tmp, cli), { dryRun: true });
  // Dry-run does not write files; re-emit with write to inspect bytes.
  const writeRes = emitBaseline(cli, path.join(tmp, cli), {});
  const body = fs.readFileSync(writeRes.out_path, "utf8");
  return { tmp, result, body };
}

test("CDX-1: emitted AGENTS.md contains zero per-rule frontmatter blocks", () => {
  const { body } = emitDryRun("codex");
  assert.equal(
    (body.match(/^priority: 0$/gm) || []).length,
    0,
    "no `priority: 0` line should leak into the body",
  );
  assert.equal(
    (body.match(/^scope: baseline$/gm) || []).length,
    0,
    "no `scope: baseline` line should leak into the body",
  );
});

test("CDX-2: emitted AGENTS.md ends with a `---` document terminator", () => {
  const { body } = emitDryRun("codex");
  // Allow optional trailing whitespace / newline after the terminator.
  assert.match(
    body,
    /\n---\n\s*$/,
    "file MUST end with a `---` line so Codex sees a clean closure",
  );
});

test("CDX-3: emitted AGENTS.md contains zero `# <filename>.md` H1 prefixes", () => {
  const { body } = emitDryRun("codex");
  const hits = body.match(/^# [a-z][a-z0-9-]*\.md$/gm) || [];
  assert.deepEqual(
    hits,
    [],
    "no `# <filename>.md` H1 should appear (rule's own H1 is the boundary)",
  );
});

test("CDX-1/2/3 also hold for GEMINI.md", () => {
  const { body } = emitDryRun("gemini");
  assert.equal((body.match(/^priority: 0$/gm) || []).length, 0);
  assert.equal((body.match(/^scope: baseline$/gm) || []).length, 0);
  assert.match(body, /\n---\n\s*$/);
  assert.deepEqual(body.match(/^# [a-z][a-z0-9-]*\.md$/gm) || [], []);
});

test("emission preserves rule's natural H1 as the first line", () => {
  const { body } = emitDryRun("codex");
  // Alphabetically first CRIT rule is agents.md → "# Agent Orchestration Rules".
  assert.ok(
    body.startsWith("# Agent Orchestration Rules"),
    `first line should be the natural H1 of the alphabetically-first ` +
      `CRIT rule, got: ${body.slice(0, 80)}`,
  );
});

// ---------- Shard D: per-rule budget BLOCK validator ----------
// Closes CDX-7 (validator silent on +64% overrun), PRB-1 (zero-tolerance.md
// over budget), GEM-CAP-1 + CDX-6 (headroom <10% from same root cause).

test("loadBudgetBlockThreshold parses sync-manifest.yaml +30% literal", () => {
  const t = loadBudgetBlockThreshold();
  // Manifest declares per_rule_budget_block_threshold: "+30%" — parser
  // returns 0.30. If the manifest drifts to a different value, this
  // test catches the schema break before emit silently uses 0.30 fallback.
  assert.equal(t, 0.3, "block threshold MUST parse as 0.30 from '+30%'");
});

test("emitBaseline returns budget_block_violations array", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-block-codex-"));
  const result = emitBaseline("codex", path.join(tmp, "codex"), { dryRun: true });
  assert.ok(
    Array.isArray(result.budget_block_violations),
    "budget_block_violations MUST be an array (empty when no rule overruns)",
  );
});

test("zero-tolerance.md emits within budget (PRB-1 closure)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-prb1-"));
  const result = emitBaseline("codex", path.join(tmp, "codex"), { dryRun: true });
  const ztReport = result.per_rule.find((r) => r.rule === "zero-tolerance.md");
  assert.ok(ztReport, "zero-tolerance.md MUST appear in per-rule report");
  // Acceptance: ≤ 9000B budget per sync-manifest.yaml. Pre-Shard-D
  // emission was 14724B (+64% over). Shard D abridgement targets ≤9000B.
  assert.ok(
    ztReport.bytes <= 9000,
    `zero-tolerance.md MUST emit ≤9000B (per sync-manifest.yaml budget); got ${ztReport.bytes}B`,
  );
  assert.notEqual(
    ztReport.budget_status,
    "block",
    `zero-tolerance.md MUST NOT be in BLOCK status; got ${ztReport.budget_status}`,
  );
});

test("no rule exceeds per_rule_budget_block_threshold post-Shard-D", () => {
  // Whole-emission acceptance: every CRIT baseline rule MUST be at or
  // under budget * (1 + block_threshold). Pre-Shard-D, the validator
  // was silent — zero-tolerance.md (+64%) and git.md (+38.7%) both
  // exceeded the +30% block threshold without halting emission.
  for (const cli of ["codex", "gemini"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `emit-noblock-${cli}-`));
    const result = emitBaseline(cli, path.join(tmp, cli), { dryRun: true });
    assert.deepEqual(
      result.budget_block_violations,
      [],
      `[${cli}] no rule may exceed block_threshold; violations: ` +
        JSON.stringify(result.budget_block_violations),
    );
  }
});

// v6.2 Shard 1 — per-lang Risk-0004 enforcement. Pre-v6.2 the assertion
// ran lang=null (base) only; rs-lang sat at 9.81%/9.85% headroom, BELOW
// the floor, vacuously passing because the assertion never measured it.
// Post-v6.2: every cli × lang combo MUST be ≥10% AND headroom_floor_violations
// MUST be empty. The structured-violation array is the canonical signal;
// the headroom_pct comparison is belt-and-suspenders.
test("Codex + Gemini headroom both ≥10% per-lang (Risk-0004, v6.2 Shard 1)", () => {
  const langs = [null, "py", "rs", "rb"];
  for (const cli of ["codex", "gemini"]) {
    for (const lang of langs) {
      const tmp = fs.mkdtempSync(
        path.join(os.tmpdir(), `emit-headroom-${cli}-${lang ?? "base"}-`),
      );
      const result = emitBaseline(cli, path.join(tmp, cli), {
        lang,
        dryRun: true,
      });
      assert.ok(
        result.headroom_pct >= 10,
        `[${cli} ${lang ?? "base"}] headroom MUST be ≥10% (v6.2 Risk-0004 floor); got ${result.headroom_pct}%`,
      );
      assert.equal(
        result.headroom_floor_violations.length,
        0,
        `[${cli} ${lang ?? "base"}] headroom_floor_violations MUST be empty; ` +
          `got ${JSON.stringify(result.headroom_floor_violations)}`,
      );
    }
  }
});

// ────────────────────────────────────────────────────────────────
// Early-warning band — diagnostic visibility for "next CRIT rule will
// refail" approach to the Risk-0004 floor. Per codex-architect Round-1
// F2 / gemini-architect Round-1 F3 — the structural validator that
// hard-blocks oversize Why content at emission time is the proper fix
// (v6.2 spec review follow-up). This test surfaces operational
// visibility WITHOUT breaking CI: emits diagnostic when margin above
// floor drops below 1500B (~one mid-sized CRIT rule worth of bytes).
// ────────────────────────────────────────────────────────────────
// v6.2 Shard 1 — pure unit tests for validateAggregateHeadroom. Negative
// path uses synthetic inputs so we don't have to mutate the manifest to
// confirm the BLOCK shape fires. Locks the violation contract: shape,
// math, and remediation message all stable.
test("validateAggregateHeadroom returns [] when headroom ≥ floor", () => {
  // 50,000B emission against 61,440B cap = 18.62% headroom; floor 10%.
  const violations = validateAggregateHeadroom({
    cli: "codex",
    lang: null,
    emissionBytes: 50000,
    blockCap: 61440,
    floorPct: 10,
  });
  assert.deepEqual(violations, []);
});

test("validateAggregateHeadroom returns structured violation when below floor", () => {
  // 56,000B emission against 61,440B cap = 8.85% headroom; floor 10%.
  const violations = validateAggregateHeadroom({
    cli: "gemini",
    lang: "rs",
    emissionBytes: 56000,
    blockCap: 61440,
    floorPct: 10,
  });
  assert.equal(violations.length, 1);
  const v = violations[0];
  assert.equal(v.cli, "gemini");
  assert.equal(v.lang, "rs");
  assert.equal(v.emission_bytes, 56000);
  assert.equal(v.block_cap_bytes, 61440);
  assert.equal(v.headroom_floor_pct, 10);
  assert.equal(v.headroom_floor_bytes, 55296); // floor(61440 * 0.90)
  assert.equal(v.under_by_bytes, 56000 - 55296); // 704
  assert.ok(v.headroom_pct < 10, `headroom_pct must be <10; got ${v.headroom_pct}`);
  assert.ok(
    /v6\.2 Risk-0004 floor breach/.test(v.remediation),
    "remediation MUST cite the v6.2 floor breach + plan path",
  );
});

test("validateAggregateHeadroom defaults lang to 'base' when null", () => {
  const violations = validateAggregateHeadroom({
    cli: "codex",
    lang: null,
    emissionBytes: 56000,
    blockCap: 61440,
    floorPct: 10,
  });
  assert.equal(violations[0].lang, "base");
});

test("loadCliCaps parses headroom_floor_pct from sync-manifest.yaml", () => {
  const caps = loadCliCaps();
  assert.equal(
    caps.codex.headroom_floor_pct,
    10,
    "codex floor MUST be parsed from manifest, not fallback default",
  );
  assert.equal(
    caps.gemini.headroom_floor_pct,
    10,
    "gemini floor MUST be parsed from manifest (was implicit pre-v6.2)",
  );
  // v6.2 R2 — security-reviewer audit (PR #218): the loader Math.max(10, parsed)
  // clamps any manifest edit setting floor < 10 back to 10. Live caps both
  // sit at the contract floor, so the clamp is a no-op here; the property
  // tested is "loaded value is never less than 10."
  assert.ok(
    caps.codex.headroom_floor_pct >= 10,
    "codex floor MUST be ≥10 (Risk-0004 contract); loader clamps below-floor edits",
  );
  assert.ok(
    caps.gemini.headroom_floor_pct >= 10,
    "gemini floor MUST be ≥10 (Risk-0004 contract); loader clamps below-floor edits",
  );
});

test("Codex + Gemini headroom early-warning band per-lang (diagnostic, never fails)", (t) => {
  const BLOCK_CAP_BYTES = 61440; // matches sync-manifest.yaml §abridgement_protocol
  const SAFETY_MARGIN_BYTES = 1500;
  const langs = [null, "py", "rs", "rb"];
  for (const cli of ["codex", "gemini"]) {
    for (const lang of langs) {
      const tmp = fs.mkdtempSync(
        path.join(os.tmpdir(), `emit-band-${cli}-${lang ?? "base"}-`),
      );
      const result = emitBaseline(cli, path.join(tmp, cli), {
        lang,
        dryRun: true,
      });
      // Bytes above the 10% floor (NOT bytes above block_cap_bytes).
      const marginAboveFloor = Math.floor(
        BLOCK_CAP_BYTES * ((result.headroom_pct - 10) / 100),
      );
      if (marginAboveFloor < SAFETY_MARGIN_BYTES) {
        const msg = `[${cli} ${lang ?? "base"}] EARLY-WARNING: only ${marginAboveFloor}B above 10% floor (headroom=${result.headroom_pct}%); next CRIT-rule landing will likely refail Risk-0004 — see workspaces/multi-cli-coc/02-plans/08-loom-v6.2-headroom-validator.md`;
        t.diagnostic(msg);
        process.stderr.write(`emit-shape WARN: ${msg}\n`);
      }
    }
  }
  // Always-pass: this test is operational visibility, not enforcement.
  // The 10% floor enforcement lives in the prior test (v6.2 Shard 1).
  assert.ok(true);
});

// ---------- Shard B: V13 MCP bijection — Shape D + dual-output ----------
// Closes CDX-4 (Shape vocabulary missed instruct-and-wait pattern) and
// CDX-5 (schema drift between predicate-dump and runtime policies.json).

test("wireMcpPolicies emits runtime policies.json + sidecar audit dump", async () => {
  const { wireMcpPolicies } = await import("../../bin/emit.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-mcp-"));
  const policiesPath = wireMcpPolicies(tmp);
  // Runtime file present
  assert.ok(fs.existsSync(policiesPath), "policies.json (runtime) MUST exist");
  // Sidecar audit dump present
  const auditPath = path.join(tmp, "extract-policies.dump.json");
  assert.ok(
    fs.existsSync(auditPath),
    "extract-policies.dump.json (audit sidecar) MUST exist",
  );
});

test("policies.json emits server.js-consumable runtime shape", async () => {
  const { wireMcpPolicies } = await import("../../bin/emit.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-mcp-runtime-"));
  const policiesPath = wireMcpPolicies(tmp);
  const raw = JSON.parse(fs.readFileSync(policiesPath, "utf8"));
  // Server.js::loadPolicies (.claude/codex-mcp-guard/server.js:71-89)
  // reads `raw.policies[t]` for each WRAPPED_TOOL — verify the shape.
  assert.ok(
    typeof raw.policies === "object" && raw.policies !== null,
    "runtime policies.json MUST have a `.policies` object",
  );
  for (const tool of ["shell", "unified_exec", "apply_patch"]) {
    assert.ok(
      Array.isArray(raw.policies[tool]),
      `runtime policies.json MUST have an array at policies.${tool}`,
    );
  }
  // POLICIES_POPULATED derives from at least one wrapped tool having
  // ≥1 entry. With validate-bash-command.js + posture-gate.js +
  // gitignored-claude-warn.js all registered, this MUST be true.
  const populated = ["shell", "unified_exec", "apply_patch"].some(
    (t) => raw.policies[t].length > 0,
  );
  assert.ok(populated, "POLICIES_POPULATED MUST be true post-Shard-B");
});

test("audit dump captures Shape D in shape_summary (CDX-4)", async () => {
  const { wireMcpPolicies } = await import("../../bin/emit.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-mcp-audit-"));
  wireMcpPolicies(tmp);
  const audit = JSON.parse(
    fs.readFileSync(path.join(tmp, "extract-policies.dump.json"), "utf8"),
  );
  // Shape D landed at Shard B 2026-05-10 — vocabulary now covers the
  // instruct-and-wait halting pattern. validate-bash-command.js's
  // validateBashCommand is the canonical Shape D predicate in the live
  // hook tree; without Shape D it was silently unclassified pre-Shard-B.
  assert.ok(
    "D" in audit.shape_summary,
    "audit dump shape_summary MUST include Shape D vocabulary",
  );
  assert.ok(
    audit.shape_summary.D >= 1,
    `audit dump MUST classify ≥1 Shape D predicate (got ${audit.shape_summary.D})`,
  );
  // The canonical Shape D predicate is validateBashCommand.
  const validateBash = audit.predicates.find(
    (p) => p.id === "validateBashCommand",
  );
  assert.ok(
    validateBash,
    "validateBashCommand MUST appear in audit predicates",
  );
  assert.equal(
    validateBash.shape,
    "D",
    `validateBashCommand MUST classify as Shape D, got ${validateBash.shape}`,
  );
});

// ---------- Shard C: wrapper emission deferral (CDX-8) ----------
// Closes CDX-8 — the wrappers/*.sh.template.codex.emit_to manifest
// declarations were dead config (never wired into emit-cli-artifacts.mjs;
// runtime dependency .codex/developer-instructions/ never authored;
// native .codex/prompts/ + .gemini/commands/ surface ships everywhere).
// Stripped at Shard C 2026-05-10 per journal/0006-DECISION-wrapper-
// emission-disposition-strip.md.

test("sync-manifest.yaml MUST NOT declare wrappers emit_to (Shard C strip)", () => {
  const manifestPath = path.join(
    process.cwd(),
    ".claude",
    "sync-manifest.yaml",
  );
  const src = fs.readFileSync(manifestPath, "utf8");
  // The dead declaration was: wrappers/*.sh.template:\n    codex:\n      emit_to: "bin/coc-{name}"
  // Allow the historical block-comment that explains the deferral, but
  // the live YAML keys MUST be absent.
  assert.doesNotMatch(
    src,
    /^\s*wrappers\/\*\.sh\.template:\s*$/m,
    "wrappers/*.sh.template: top-level key MUST be stripped — the emit_to declaration was a stub per zero-tolerance.md Rule 2",
  );
  assert.doesNotMatch(
    src,
    /^\s*emit_to:\s*"bin\/coc-\{name\}"/m,
    "bin/coc-{name} emit_to declaration MUST be stripped",
  );
});

test("budget BLOCK violation shape includes diagnostic fields", () => {
  // Synthetic check: verify the violation record carries the fields
  // main()'s stderr remediation message reads. Done by stubbing a
  // budget-overrun condition through manifest budget tightening would
  // require a temp manifest; instead, verify the record-shape contract
  // by parsing one if present (currently empty post-Shard-D, so this
  // test asserts the field-shape contract only when violations exist).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-shape-"));
  const result = emitBaseline("codex", path.join(tmp, "codex"), { dryRun: true });
  for (const v of result.budget_block_violations) {
    assert.ok(typeof v.rule === "string", "violation.rule MUST be string");
    assert.ok(typeof v.bytes === "number", "violation.bytes MUST be number");
    assert.ok(typeof v.budget === "number", "violation.budget MUST be number");
    assert.ok(
      typeof v.block_threshold_bytes === "number",
      "violation.block_threshold_bytes MUST be number",
    );
    assert.ok(typeof v.over_by_bytes === "number", "violation.over_by_bytes MUST be number");
    assert.ok(typeof v.over_by_pct === "number", "violation.over_by_pct MUST be number");
  }
});

// ---------- issue #235: parseArgs warns on unrecognized flags ----------
// Pre-v6.2 parseArgs had no else-branch: any token it did not recognize
// (a typo'd --no-strict-headroon, a removed legacy --strict-headroom) was
// silently swallowed. The operator burned a round trip diagnosing why an
// explicit opt-out never fired. These are STRUCTURAL assertions (array
// contents, boolean state, stderr byte presence) — regex/structural is
// the correct verification class per probe-driven-verification.md Rule 3;
// no semantic claim about assistant prose is involved.

// Capture process.stderr.write for the duration of `fn`, return the text.
function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = "";
  process.stderr.write = (chunk) => {
    buf += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

test("parseArgs: known flags produce an empty unknownArgs array", () => {
  const args = parseArgs([
    "--cli",
    "codex",
    "--lang",
    "py",
    "--all",
    "--out",
    "/tmp/x",
    "--dry-run",
    "--no-strict-headroom",
    "-v",
  ]);
  assert.deepEqual(
    args.unknownArgs,
    [],
    "every recognized flag MUST be consumed; unknownArgs stays empty",
  );
  assert.equal(args.cli, "codex");
  assert.equal(args.lang, "py");
  assert.equal(args.all, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.verbose, true);
  assert.equal(
    args.strictHeadroom,
    false,
    "correctly-spelled --no-strict-headroom MUST flip strictHeadroom off",
  );
});

test("parseArgs: flag values are NOT misclassified as unknown args", () => {
  // --cli/--out/--lang each consume the next token via ++i. The value
  // token ("codex", "/tmp/x", "rs") must never land in unknownArgs.
  const args = parseArgs(["--cli", "gemini", "--out", "/tmp/y", "--lang", "rs"]);
  assert.deepEqual(args.unknownArgs, []);
});

test("parseArgs: a typo'd --no-strict-headroom is captured, not swallowed (issue #235)", () => {
  let args;
  const stderr = captureStderr(() => {
    args = parseArgs(["--cli", "codex", "--no-strict-headroon"]);
  });
  assert.deepEqual(
    args.unknownArgs,
    ["--no-strict-headroon"],
    "the typo MUST be captured in unknownArgs",
  );
  assert.equal(
    args.strictHeadroom,
    true,
    "fail-safe: a typo'd opt-out leaves strict mode ON",
  );
  assert.match(
    stderr,
    /WARNING — ignored unrecognized argument\(s\): "--no-strict-headroon"/,
    "the warning MUST name the offending token (JSON-quoted) on stderr",
  );
  assert.match(
    stderr,
    /strict mode ON/,
    "the warning MUST tell the operator their opt-out did NOT apply",
  );
});

test("parseArgs: removed legacy --strict-headroom is now an unknown flag", () => {
  // v6.2 cycle-3(a) removed --strict-headroom no-op acceptance. It must
  // now surface as unrecognized rather than be silently tolerated.
  let args;
  const stderr = captureStderr(() => {
    args = parseArgs(["--cli", "gemini", "--strict-headroom"]);
  });
  assert.deepEqual(args.unknownArgs, ["--strict-headroom"]);
  assert.match(stderr, /"--strict-headroom"/);
});

test("parseArgs: multiple unknown tokens are all captured and reported", () => {
  let args;
  const stderr = captureStderr(() => {
    args = parseArgs(["--bogus", "--cli", "codex", "stray-positional"]);
  });
  assert.deepEqual(args.unknownArgs, ["--bogus", "stray-positional"]);
  assert.match(stderr, /"--bogus", "stray-positional"/);
});

test("parseArgs: control / ANSI characters in an argv token are neutralized in the warning", () => {
  // argv is operator-controlled; a token carrying a raw ESC sequence
  // (terminal title-bar rewrite) MUST NOT reach the terminal verbatim.
  // JSON.stringify escapes it to a printable  form.
  const evil = "\x1b]0;pwned\x07";
  let args;
  const stderr = captureStderr(() => {
    args = parseArgs(["--cli", "codex", evil]);
  });
  assert.deepEqual(
    args.unknownArgs,
    [evil],
    "unknownArgs MUST hold the raw token (structured data is verbatim)",
  );
  assert.ok(
    !stderr.includes("\x1b"),
    "the raw ESC byte MUST NOT appear in the stderr warning",
  );
  assert.match(
    stderr,
    /\\u001b/,
    "the ESC byte MUST be echoed in escaped \\u001b form",
  );
});

test("parseArgs: no warning is written when every token is recognized", () => {
  const stderr = captureStderr(() => {
    parseArgs(["--all", "--dry-run"]);
  });
  assert.equal(stderr, "", "clean input MUST NOT write to stderr");
});

// ---------- validateTierCompleteness (Validator 15, journal 0078) ----------

// Live invariant: every .claude/rules/*.md MUST be tier-listed OR
// use_obsoleted OR use_exclude in sync-manifest.yaml. This is the exact
// regression the validator exists to prevent — a rule authored without
// a manifest classification silently falls out of the subscription sync.
// Asserting pass===true here makes the regression a CI failure, not just
// a /sync-time failure.
test("validateTierCompleteness: every rule in the repo is manifest-managed", () => {
  const r = validateTierCompleteness();
  assert.equal(
    r.pass,
    true,
    `unmanaged rules (add to a tier OR use_obsoleted OR use_exclude in ` +
      `sync-manifest.yaml):\n${r.failures.join("\n")}`,
  );
});

// Negative path: an injected rule with no manifest classification MUST
// be flagged. The function reads the real .claude/rules/ dir (REPO-
// relative, not parameterized), so the fixture is a uniquely-named file
// removed in finally — keeps the test deterministic and self-cleaning.
test("validateTierCompleteness: flags an unmanaged rule, then clean after removal", () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const rulesDir = path.join(here, "..", "..", "rules");
  const probe = path.join(rulesDir, "zzz-tier-completeness-selftest.md");
  try {
    fs.writeFileSync(probe, "---\npriority: 0\nscope: baseline\n---\n# Z\n");
    const flagged = validateTierCompleteness();
    assert.equal(flagged.pass, false, "injected unmanaged rule MUST flag");
    assert.ok(
      flagged.failures.some((f) =>
        f.startsWith("zzz-tier-completeness-selftest.md:"),
      ),
      "failure list MUST name the injected rule",
    );
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
  assert.equal(
    validateTierCompleteness().pass,
    true,
    "MUST be clean again after the probe file is removed",
  );
});

// ---------- validateManifestYaml (Validator 16, journal 0080) ----------

// Live invariant: the committed sync-manifest.yaml MUST be strict-valid
// YAML. This is the exact regression V16 exists to prevent — PR #246
// shipped a manifest the regex parser accepted but strict YAML rejected.
test("validateManifestYaml: committed manifest is strict-valid YAML", () => {
  const r = validateManifestYaml();
  assert.equal(
    r.pass,
    true,
    `sync-manifest.yaml failed strict YAML parse:\n${r.failures.join("\n")}`,
  );
});

// Negative path: a syntactically broken manifest MUST be flagged. The
// function reads the real manifest (REPO-relative, not parameterized),
// so we append a broken line and restore the exact original bytes in
// finally — bulletproof restore (write back the captured Buffer).
test("validateManifestYaml: flags broken YAML, then clean after restore", () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const manifest = path.join(here, "..", "..", "sync-manifest.yaml");
  const original = fs.readFileSync(manifest); // Buffer — exact bytes
  try {
    fs.appendFileSync(manifest, "\nbroken: [unclosed flow seq\n");
    const flagged = validateManifestYaml();
    assert.equal(flagged.pass, false, "broken YAML MUST flag");
    assert.ok(
      flagged.failures[0]?.includes("not valid YAML"),
      "failure message MUST name the YAML defect",
    );
  } finally {
    fs.writeFileSync(manifest, original); // restore exact bytes
  }
  assert.equal(
    validateManifestYaml().pass,
    true,
    "MUST be strict-valid again after restore",
  );
});
