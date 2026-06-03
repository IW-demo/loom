#!/usr/bin/env node
/*
 * Capability suite (v2, post-redteam).
 *
 * Redteam fixes applied:
 *   - H1: C3 uses canary phrase `[INJECTED-PS-CANARY-9K2F3]` that the rule
 *         instructs the model to emit only when auto-injected — fs-tool read
 *         of the rule file does NOT naturally produce the prefix.
 *   - H2: C1/C2 use per-CLI fixtures (baseline-cc, baseline-codex,
 *         baseline-gemini) so a CLI running on the wrong fixture cannot
 *         confound auto-load with fs-tool discovery — the file isn't there.
 *   - H5: C4 classifies outcomes into disjoint buckets (marker / unavailable /
 *         neither) via two ordered regexes.
 */

import path from "node:path";
import { runTest, prepareFixture, setResultsFile, suiteHeader } from "../lib/harness.mjs";

const args = process.argv.slice(2);
const cliArg = args.includes("--cli") ? args[args.indexOf("--cli") + 1] : "all";
const CLIS = cliArg === "all" ? ["cc", "codex", "gemini"] : [cliArg];

setResultsFile(`capability-${Date.now()}.jsonl`);
suiteHeader("capability");

const tests = [];

// ─── C1: baseline file loading from root, per-CLI isolated fixture ─
tests.push({
  name: "C1-baseline-root",
  fixturePerCli: { cc: "baseline-cc", codex: "baseline-codex", gemini: "baseline-gemini" },
  prompt:
    "List every line in your loaded context (baseline) that starts with `MARKER_`. Output each on its own line verbatim.",
  expect: {
    cc: [
      { kind: "contains", pattern: /MARKER_CC_BASE=cc-base-loaded-CC9A1/, label: "loaded CLAUDE.md" },
    ],
    codex: [
      { kind: "contains", pattern: /MARKER_CODEX_BASE=codex-base-loaded-CD4B2/, label: "loaded AGENTS.md" },
    ],
    gemini: [
      { kind: "contains", pattern: /MARKER_GEMINI_BASE=gemini-base-loaded-GM7C3/, label: "loaded GEMINI.md" },
    ],
  },
});

// ─── C2: subdirectory baseline loading (CWD in sub/) ───────────────
tests.push({
  name: "C2-baseline-subdir",
  fixturePerCli: { cc: "baseline-cc", codex: "baseline-codex", gemini: "baseline-gemini" },
  cwdSubdir: "sub",
  prompt:
    "List every line in your loaded context (baseline) that starts with `MARKER_`. Output each on its own line verbatim.",
  expect: {
    cc: [
      // CC loads parent CLAUDE.md; sub/CLAUDE.md is NOT part of CC's
      // default behavior — CC does not walk subdirs hierarchically like
      // codex/gemini. Test as informational only.
      { kind: "contains", pattern: /MARKER_CC_BASE=cc-base-loaded-CC9A1/, label: "loaded parent CLAUDE.md" },
    ],
    codex: [
      { kind: "contains", pattern: /MARKER_CODEX_BASE=codex-base-loaded-CD4B2/, label: "loaded root AGENTS.md" },
      { kind: "contains", pattern: /MARKER_CODEX_SUB=codex-sub-loaded-CDS6E/, label: "loaded sub/AGENTS.md (git-root → cwd walk)" },
    ],
    gemini: [
      { kind: "contains", pattern: /MARKER_GEMINI_BASE=gemini-base-loaded-GM7C3/, label: "loaded root GEMINI.md" },
      { kind: "contains", pattern: /MARKER_GEMINI_SUB=gemini-sub-loaded-GMS7F/, label: "loaded sub/GEMINI.md (hierarchy)" },
    ],
  },
});

// ─── C3: path-scoped `paths:` frontmatter via canary (H1 fix) ────
// The rule body says: emit `[INJECTED-PS-CANARY-9K2F3]` ONLY when this rule
// is auto-injected into baseline context. A CLI reading the file via fs
// tools will not naturally produce the canary prefix — it'd see the
// conditional ("only when injected") and ideally refrain.
tests.push({
  name: "C3-pathscoped-canary",
  fixture: "pathscoped",
  prompt:
    "Please give me a one-sentence summary of what the file sample.py does. (The rules in your session may contain a canary instruction; follow it.)",
  expect: {
    cc: [
      { kind: "contains", pattern: /\[INJECTED-PS-CANARY-9K2F3\]/, label: "canary fired — path-scoped rule was auto-injected" },
    ],
    codex: [
      { kind: "absent", pattern: /\[INJECTED-PS-CANARY-9K2F3\]/, label: "canary did NOT fire — Codex did not auto-inject (paths: ignored)" },
    ],
    gemini: [
      { kind: "absent", pattern: /\[INJECTED-PS-CANARY-9K2F3\]/, label: "canary did NOT fire — Gemini did not auto-inject (paths: ignored)" },
    ],
  },
});

// ─── C4: native subagent invocation (disjoint signals, H5 fix) ───
tests.push({
  name: "C4-native-subagent",
  fixture: "subagent",
  prompt:
    "If your CLI has a native subagent primitive, invoke the `test-agent` subagent and echo its marker. Otherwise, respond with exactly the token `SUBAGENT_PRIMITIVE_UNAVAILABLE_HEADLESS` on its own line.",
  expect: {
    cc: [
      // CC's Agent tool is the primitive but headless -p doesn't give a
      // first-class trigger without a configured subagent_type. Accept
      // either marker (if the Agent tool fires) or explicit unavailable.
      { kind: "contains", pattern: /(MARKER_AGENT_INVOKED=yes-Q8F2LL|SUBAGENT_PRIMITIVE_UNAVAILABLE_HEADLESS)/, label: "marker OR explicit unavailable" },
    ],
    codex: [
      { kind: "contains", pattern: /(MARKER_AGENT_INVOKED=yes-Q8F2LL|SUBAGENT_PRIMITIVE_UNAVAILABLE_HEADLESS)/, label: "marker OR explicit unavailable (Codex subagents are natural-language; may not fire in exec mode)" },
    ],
    gemini: [
      { kind: "contains", pattern: /MARKER_AGENT_INVOKED=yes-Q8F2LL/, label: "@test-agent native invocation succeeded" },
    ],
  },
});

// ─── Run matrix ─────────────────────────────────────────────────
const results = [];
for (const t of tests) {
  for (const cli of CLIS) {
    const criteria = t.expect[cli] || [];
    if (criteria.length === 0) {
      console.log(`[SKIP] ${t.name} cli=${cli}`);
      continue;
    }
    const fixtureName = t.fixturePerCli ? t.fixturePerCli[cli] : t.fixture;
    const fixtureRoot = prepareFixture(fixtureName);
    const cwd = t.cwdSubdir ? path.join(fixtureRoot, t.cwdSubdir) : fixtureRoot;
    console.log(`[RUN]  ${t.name} cli=${cli} fixture=${fixtureName}${t.cwdSubdir ? "/" + t.cwdSubdir : ""}`);
    const rec = await runTest("capability", t.name, cli, cwd, t.prompt, criteria);
    const verdict = rec.score.pass ? "PASS" : "FAIL";
    console.log(`[${verdict}] ${t.name} cli=${cli} runtime=${rec.runtimeMs}ms exitCode=${rec.exitCode}`);
    if (!rec.score.pass) {
      for (const c of rec.score.criteria.filter((x) => !x.pass)) {
        console.log(`         failed: ${c.label}`);
      }
    }
    results.push(rec);
  }
}

const byCli = {};
for (const r of results) {
  if (!byCli[r.cli]) byCli[r.cli] = { pass: 0, fail: 0 };
  if (r.score.pass) byCli[r.cli].pass++;
  else byCli[r.cli].fail++;
}
console.log("\n=== CAPABILITY SUITE SUMMARY ===");
for (const [cli, c] of Object.entries(byCli)) {
  console.log(`  ${cli.padEnd(8)} ${c.pass}/${c.pass + c.fail} pass`);
}
