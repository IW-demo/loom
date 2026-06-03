#!/usr/bin/env node
/*
 * cli-drift-audit.mjs — cross-CLI drift executor for the `sees` verb.
 *
 * Implements spec v6 §6.2 + sync-manifest.yaml::parity_enforcement.cross_cli_drift_audit:
 *   For every CRIT rule, compose the rule body under each CLI (cc, codex, gemini),
 *   extract slots, apply scrub_tokens, byte-compare the configured slots.
 *   Drift in `fail_on_drift_in_slots` → exit 1 (HARD BLOCK).
 *   Drift in `warn_on_drift_in_slots` → reported, exit unchanged.
 *
 * Replaces the volatile /tmp/loom-matrix-poc-v5-* PoC referenced in
 * workspaces/multi-cli-coc/todos/active/00-migration-plan.md (E6c).
 *
 * Usage:
 *   node tools/cli-drift-audit.mjs                # human report, JSON at default path
 *   node tools/cli-drift-audit.mjs --json out.json
 *   node tools/cli-drift-audit.mjs --fixtures DIR # audit a fixture tree instead of .claude/rules/
 *   node tools/cli-drift-audit.mjs --quiet        # only emit on drift
 *
 * Exit codes:
 *   0 — no drift in fail_on_drift_in_slots (warn-slot drift permitted)
 *   1 — drift in any fail_on_drift_in_slots; sync would HARD BLOCK
 *   2 — usage / config error
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { composeRule } from "../.claude/bin/emit.mjs";
import { parseSlotsV5 } from "../.claude/bin/lib/slot-parser.mjs";

// Rule-name validation grammar — matches the upstream guard in
// emit.mjs::composeRule. Re-stated here so fixture-mode callers
// (which bypass composeRule) get the same defense.
const RULE_NAME_RE = /^[a-z][a-z0-9-]*\.md$/;

// Symlink-safe write — mirrors emit.mjs::safeWriteFileSync. O_NOFOLLOW
// refuses to open if the target is a symlink, closing the TOCTOU window
// where an attacker plants a symlink between path argument parsing and
// the write call. Re-implemented locally rather than exported from
// emit.mjs to avoid widening that module's public surface.
function safeWriteFileSync(filePath, data) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), "..");
const MANIFEST_PATH = path.join(REPO, ".claude", "sync-manifest.yaml");

const CLIS = ["cc", "codex", "gemini"];

// ────────────────────────────────────────────────────────────────
// CLI argument parsing — strict, no positional args.
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { json: null, fixtures: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = argv[++i];
      if (!out.json) throw new Error("--json requires a path argument");
    } else if (a === "--fixtures") {
      out.fixtures = argv[++i];
      if (!out.fixtures) throw new Error("--fixtures requires a directory argument");
    } else if (a === "--quiet") {
      out.quiet = true;
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Manifest config loader — narrow regex on the cross_cli_drift_audit
// block. Avoids a YAML dependency. emit.mjs::loadPerRuleBudgets uses
// a similar narrow-regex pattern for its per-rule budget block, but
// with a named-next-sibling terminator (`per_rule_budget_tolerance:`
// or any column-0 letter) — our block has no fixed next-sibling, so
// we terminate on the first line indented ≤2 spaces with a non-
// whitespace token (matches YAML block-end at the parent indent
// level).
// ────────────────────────────────────────────────────────────────
export function loadDriftConfig(manifestPath = MANIFEST_PATH) {
  const src = fs.readFileSync(manifestPath, "utf8");
  // Terminate the block at the first line indented ≤2 spaces with a
  // non-whitespace token, OR at EOF. The previous `(?=\n\S|\n*$)`
  // terminator only fired on column-0 keys, so sibling YAML blocks at
  // any non-zero indent (e.g., another `parity_enforcement.*` entry)
  // would be slurped into our block and override our config. Today
  // the only sibling at column 0 is `tiers:`, so the parse happens to
  // work — but the contract was wrong and a future manifest edit
  // would silently corrupt audit behavior.
  const block = src.match(
    /cross_cli_drift_audit:\s*\n([\s\S]*?)(?=\n {0,2}\S|\n*$)/,
  );
  if (!block) {
    throw new Error(
      `cross_cli_drift_audit block not found in ${manifestPath} ` +
        `— sync-manifest.yaml::parity_enforcement.cross_cli_drift_audit is the source of truth`,
    );
  }
  const body = block[1];

  // enabled: <bool>
  const enabledM = body.match(/^\s+enabled:\s*(true|false)/m);
  const enabled = enabledM ? enabledM[1] === "true" : true;

  const extractList = (key) => {
    // Inline-array form: `key: ["a", "b", "c"]`
    const inlineM = body.match(
      new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "m"),
    );
    if (inlineM) {
      return [...inlineM[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map(
        (m) => m[1] || m[2],
      );
    }
    // Block-list form:
    //   key:
    //     - "a"
    //     - "b"
    const blockM = body.match(
      new RegExp(`^\\s+${key}:\\s*\\n((?:\\s+-\\s+[^\\n]+\\n?)+)`, "m"),
    );
    if (!blockM) return [];
    return [...blockM[1].matchAll(/^\s+-\s+"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1]);
  };

  return {
    enabled,
    compare_slots: extractList("compare_slots"),
    scrub_tokens: extractList("scrub_tokens"),
    fail_on_drift_in_slots: extractList("fail_on_drift_in_slots"),
    warn_on_drift_in_slots: extractList("warn_on_drift_in_slots"),
  };
}

// ────────────────────────────────────────────────────────────────
// Frontmatter extraction — `priority:` and `scope:` lines only.
// We do NOT compare other frontmatter fields here; the contract per
// rules/cross-cli-parity.md MUST-2 is byte-identity on priority+scope.
// ────────────────────────────────────────────────────────────────
export function extractFrontmatterFields(composedBody) {
  const fmMatch = composedBody.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { priority: null, scope: null };
  const fm = fmMatch[1];
  const prio = fm.match(/^priority:\s*(\d+)\s*$/m);
  const scope = fm.match(/^scope:\s*([a-z-]+)\s*$/m);
  return {
    priority: prio ? prio[1] : null,
    scope: scope ? scope[1] : null,
  };
}

// ────────────────────────────────────────────────────────────────
// scrubAndNormalize — apply scrub_tokens + whitespace normalization
// to a slot body. The contract per rules/cross-cli-parity.md MUST-1
// is byte-identity "modulo whitespace normalization".
//
// scrub_tokens are syntactic-delegation markers (Agent(, codex_agent(,
// @specialist, subagent_type, run_in_background) — every appearance is
// erased so a CC `Agent(subagent_type="...")` and a Codex
// `codex_agent(agent="...")` collapse to the same string after scrub.
// ────────────────────────────────────────────────────────────────
export function scrubAndNormalize(body, scrubTokens) {
  let out = body;
  // Reject zero-length / whitespace-only scrub tokens — they would
  // either explode the string into a per-character array (empty token)
  // or globally erase semantic whitespace (single-space token), in
  // either case corrupting the comparison surface. Manifest is
  // repo-controlled so this is defense-in-depth.
  const valid = scrubTokens.filter((tok) => tok.length >= 2 && tok.trim().length > 0);
  // Sort longest-first to avoid prefix-eating (e.g., "Agent(" before "Agent").
  const sorted = [...valid].sort((a, b) => b.length - a.length);
  for (const tok of sorted) {
    out = out.split(tok).join("");
  }
  // Whitespace normalization: collapse runs of whitespace to single
  // space, strip leading/trailing whitespace per line, drop blank lines.
  return out
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

// ────────────────────────────────────────────────────────────────
// auditRule — single-rule three-way comparison.
// Returns { rule, findings: [{ slot, severity, evidence }] }.
// ────────────────────────────────────────────────────────────────
export function auditRule(ruleName, config, composeFn = composeRule) {
  const findings = [];
  const composed = {};
  const slots = {};
  const frontmatter = {};

  for (const cli of CLIS) {
    let body;
    try {
      const r = composeFn(ruleName, cli, null);
      body = r.composed;
    } catch (e) {
      findings.push({
        slot: "(composition)",
        severity: "CRITICAL",
        evidence: `composeRule failed for ${ruleName} cli=${cli}: ${e.message}`,
      });
      return { rule: ruleName, findings };
    }
    composed[cli] = body;
    try {
      slots[cli] = parseSlotsV5(body);
    } catch (e) {
      // parseSlotsV5 throws on unclosed / nested / mismatched slot
      // markers. Without this guard the audit would crash the whole
      // run; instead convert into a CRITICAL finding on the offending
      // rule and move on.
      findings.push({
        slot: "(parse)",
        severity: "CRITICAL",
        evidence: `parseSlotsV5 failed for ${ruleName} cli=${cli}: ${e.message}`,
      });
      return { rule: ruleName, findings };
    }
    frontmatter[cli] = extractFrontmatterFields(body);
  }

  // Frontmatter parity (priority + scope).
  for (const field of ["priority", "scope"]) {
    const values = CLIS.map((c) => frontmatter[c][field]);
    const distinct = new Set(values);
    if (distinct.size > 1) {
      const slotKey = `frontmatter.${field}`;
      const sev = config.fail_on_drift_in_slots.includes(slotKey)
        ? "CRITICAL"
        : config.warn_on_drift_in_slots.includes(slotKey)
          ? "WARN"
          : "NOTE";
      findings.push({
        slot: slotKey,
        severity: sev,
        evidence: CLIS.map((c, i) => `${c}=${JSON.stringify(values[i])}`).join(" "),
      });
    }
  }

  // Slot parity — for each configured slot, compose, scrub, byte-compare.
  for (const slot of config.compare_slots) {
    if (slot.startsWith("frontmatter.")) continue; // handled above
    const bodies = CLIS.map((c) => slots[c].get(slot) || "");
    const normalized = bodies.map((b) => scrubAndNormalize(b, config.scrub_tokens));
    const distinct = new Set(normalized);
    if (distinct.size > 1) {
      const sev = config.fail_on_drift_in_slots.includes(slot)
        ? "CRITICAL"
        : config.warn_on_drift_in_slots.includes(slot)
          ? "WARN"
          : "NOTE";
      // Evidence: byte counts per CLI + first divergence offset (max 80 chars).
      const ev = CLIS.map((c, i) => `${c}=${normalized[i].length}B`).join(" ");
      const firstDiff = firstDivergenceOffset(normalized);
      const sample =
        firstDiff >= 0
          ? ` @byte=${firstDiff} (${CLIS.map(
              (c, i) =>
                `${c}:${JSON.stringify(normalized[i].slice(Math.max(0, firstDiff - 5), firstDiff + 25))}`,
            ).join(" / ")})`
          : "";
      findings.push({ slot, severity: sev, evidence: ev + sample });
    }
  }

  // Also check warn-only slots that aren't in compare_slots
  // (the spec lists examples as warn-only; it's not in compare_slots
  //  but we still want a soft signal).
  for (const slot of config.warn_on_drift_in_slots) {
    if (slot.startsWith("frontmatter.")) continue;
    if (config.compare_slots.includes(slot)) continue;
    const bodies = CLIS.map((c) => slots[c].get(slot) || "");
    const normalized = bodies.map((b) => scrubAndNormalize(b, config.scrub_tokens));
    const distinct = new Set(normalized);
    if (distinct.size > 1) {
      const ev = CLIS.map((c, i) => `${c}=${normalized[i].length}B`).join(" ");
      findings.push({ slot, severity: "WARN", evidence: ev });
    }
  }

  return { rule: ruleName, findings };
}

function firstDivergenceOffset(strs) {
  const minLen = Math.min(...strs.map((s) => s.length));
  for (let i = 0; i < minLen; i++) {
    const c = strs[0][i];
    if (strs.some((s) => s[i] !== c)) return i;
  }
  // Equal up to min length; if lengths differ, divergence is at minLen.
  return strs.some((s) => s.length !== minLen) ? minLen : -1;
}

// ────────────────────────────────────────────────────────────────
// listCritRulesDefault — read .claude/rules/, filter on priority:0.
// Replicates emit.mjs::getCritBaseline without circular import.
// ────────────────────────────────────────────────────────────────
function listCritRulesDefault(rulesDir = path.join(REPO, ".claude", "rules")) {
  return fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => {
      const src = fs.readFileSync(path.join(rulesDir, f), "utf8");
      const fm = src.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) return false;
      const prio = fm[1].match(/^priority:\s*(\d+)/m);
      return prio && parseInt(prio[1], 10) === 0;
    })
    .sort();
}

// ────────────────────────────────────────────────────────────────
// fixtureCompose — replaces composeRule when --fixtures is in use.
// Fixture layout:
//   <fixtures>/
//     <rule-name>.md           ← global / cc emission
//     <rule-name>.codex.md     ← codex emission (overrides global for cli=codex)
//     <rule-name>.gemini.md    ← gemini emission (same shape)
// Missing per-CLI file means that CLI inherits the global file.
// ────────────────────────────────────────────────────────────────
function fixtureComposeFactory(fixturesDir) {
  return function fixtureCompose(ruleName, cli) {
    // Re-validate the rule name on every call. fixtureListRules already
    // filters by this grammar, but auditRule is exported and a library
    // caller could pass an unsanitized name straight in. Defense-in-depth
    // matching emit.mjs::composeRule line 243.
    if (!RULE_NAME_RE.test(ruleName)) {
      throw new Error(
        `invalid rule name '${ruleName}' — must match ${RULE_NAME_RE}`,
      );
    }
    // Per-CLI filename uses a fixed grammar (one of cc/codex/gemini).
    if (!["cc", "codex", "gemini"].includes(cli)) {
      throw new Error(`invalid cli '${cli}' — must be one of cc / codex / gemini`);
    }
    const base = path.join(fixturesDir, ruleName);
    const cliFile = path.join(
      fixturesDir,
      ruleName.replace(/\.md$/, `.${cli}.md`),
    );
    const target = fs.existsSync(cliFile) ? cliFile : base;
    if (!fs.existsSync(target)) {
      throw new Error(`fixture not found: ${target}`);
    }
    return { composed: fs.readFileSync(target, "utf8"), warnings: [] };
  };
}

function fixtureListRules(fixturesDir) {
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => /^[a-z][a-z0-9-]*\.md$/.test(f))
    .sort();
}

// ────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`cli-drift-audit: ${e.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(
      "Usage: node tools/cli-drift-audit.mjs [--json PATH] [--fixtures DIR] [--quiet]\n",
    );
    process.exit(0);
  }

  let config;
  try {
    config = loadDriftConfig();
  } catch (e) {
    process.stderr.write(`cli-drift-audit: ${e.message}\n`);
    process.exit(2);
  }
  if (!config.enabled) {
    process.stderr.write("cli-drift-audit: cross_cli_drift_audit.enabled=false in manifest — skipping\n");
    process.exit(0);
  }

  const composeFn = args.fixtures
    ? fixtureComposeFactory(args.fixtures)
    : composeRule;
  const rules = args.fixtures
    ? fixtureListRules(args.fixtures)
    : listCritRulesDefault();

  const report = {
    mode: args.fixtures ? "fixtures" : "rules",
    source: args.fixtures || ".claude/rules",
    config: {
      compare_slots: config.compare_slots,
      scrub_tokens: config.scrub_tokens,
      fail_on_drift_in_slots: config.fail_on_drift_in_slots,
      warn_on_drift_in_slots: config.warn_on_drift_in_slots,
    },
    timestamp: new Date().toISOString(),
    rules: [],
    summary: { rules_audited: 0, critical: 0, warn: 0, note: 0 },
  };

  for (const rule of rules) {
    const r = auditRule(rule, config, composeFn);
    report.rules.push(r);
    report.summary.rules_audited += 1;
    for (const f of r.findings) {
      if (f.severity === "CRITICAL") report.summary.critical += 1;
      else if (f.severity === "WARN") report.summary.warn += 1;
      else report.summary.note += 1;
    }
  }

  // Human report.
  if (!args.quiet || report.summary.critical + report.summary.warn > 0) {
    process.stdout.write(
      `cli-drift-audit: ${report.summary.rules_audited} rules, ` +
        `${report.summary.critical} CRITICAL, ${report.summary.warn} WARN, ` +
        `${report.summary.note} NOTE\n`,
    );
    for (const r of report.rules) {
      if (r.findings.length === 0) continue;
      process.stdout.write(`\n[${r.rule}]\n`);
      for (const f of r.findings) {
        process.stdout.write(`  ${f.severity} ${f.slot}: ${f.evidence}\n`);
      }
    }
  }

  if (args.json) {
    try {
      safeWriteFileSync(args.json, JSON.stringify(report, null, 2));
    } catch (e) {
      process.stderr.write(
        `cli-drift-audit: cannot write JSON to ${args.json}: ${e.message}\n`,
      );
      process.exit(2);
    }
  }

  process.exit(report.summary.critical > 0 ? 1 : 0);
}

// Run main when executed directly (not when imported as a module for testing).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };
