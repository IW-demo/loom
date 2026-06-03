#!/usr/bin/env node
/**
 * detect-violations — POC hook for the trust-posture system.
 *
 * Wired to multiple events; reads tool_event from stdin payload's hookEventName field.
 *   PostToolUse(Bash)         → repo-scope-bash, commit-claim
 *   PostToolUse(Edit|Write)   → worktree-drift
 *   Stop                      → pre-existing-no-SHA, sweep-substitution, self-confession
 *   UserPromptSubmit          → regression signal from user prompt
 *
 * Mitigates cc-artifacts.md Rule 7 (timeout fallback).
 */

const TIMEOUT_MS = 5000;
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const path = require("path");
const { emit } = require(
  path.join(__dirname, "..", "lib", "instruct-and-wait.js"),
);
const { appendViolation } = require(
  path.join(__dirname, "..", "lib", "state-io.js"),
);
const P = require(path.join(__dirname, "..", "lib", "violation-patterns.js"));

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function logAndEmit(payload, event, finding, what_happened) {
  appendViolation(payload.cwd, {
    rule_id: finding.rule_id,
    severity: finding.severity,
    evidence: finding.evidence,
    posture_at_time: process.env.CLAUDE_CURRENT_POSTURE || "unknown",
    addressed_by: null,
  });

  clearTimeout(fallback);
  emit({
    hookEvent: event,
    severity: finding.severity,
    what_happened,
    why: finding.rule_id,
    agent_must_report: [
      "Quote the exact text/command that triggered the detection",
      "State which rule was violated and its origin evidence date",
      "Propose remediation in this turn (do not file a follow-up issue)",
    ],
    agent_must_wait:
      "Do not retry or proceed with related work until the user instructs.",
    user_summary: `${finding.rule_id} — ${what_happened.slice(0, 60)}`,
  });
}

(async () => {
  const payload = await readStdin();
  const event = payload.hook_event_name || payload.hookEventName || "Unknown";

  if (event === "PostToolUse") {
    const tool = payload.tool_name;
    const input = payload.tool_input || {};

    if (tool === "Bash") {
      const cmd = input.command || "";
      let f =
        P.detectRepoScopeDriftBash(cmd, payload.cwd) ||
        P.detectCommitClaim(cmd);
      if (f)
        return logAndEmit(
          payload,
          event,
          f,
          `Bash command flagged: ${cmd.slice(0, 80)}`,
        );
    } else if (tool === "Edit" || tool === "Write") {
      const fp = input.file_path || "";
      const f = P.detectWorktreeDrift(fp);
      if (f)
        return logAndEmit(
          payload,
          event,
          f,
          `Edit/Write to ${fp.slice(0, 80)}`,
        );
    }
    return passthrough();
  }

  if (event === "Stop") {
    const finalText = payload.transcript_path
      ? "" // POC: would read transcript; for now expect inlined text
      : payload.last_assistant_text || "";

    const findings = [
      P.detectPreExistingNoSha(finalText),
      P.detectSweepSubstitution(finalText),
      P.detectSelfConfession(finalText),
      P.detectRepoScopeDriftText(finalText),
    ].filter(Boolean);

    if (findings.length === 0) return passthrough();

    // Stop hooks emit systemMessage (CRIT-1). Multiple findings → concatenate.
    for (const f of findings) {
      appendViolation(payload.cwd, {
        rule_id: f.rule_id,
        severity: f.severity === "block" ? "halt-and-report" : f.severity, // Stop can't truly block
        evidence: f.evidence,
        posture_at_time: process.env.CLAUDE_CURRENT_POSTURE || "unknown",
        type: "post-mortem",
      });
    }

    clearTimeout(fallback);
    emit({
      hookEvent: "Stop",
      severity: "post-mortem",
      what_happened: `${findings.length} violation pattern(s) detected in final report`,
      why: findings.map((f) => f.rule_id).join(", "),
      agent_must_report: findings.map(
        (f) => `${f.rule_id}: ${f.evidence.slice(0, 100)}`,
      ),
      agent_must_wait: "Forensic record only — surfaced at next SessionStart.",
      user_summary: `${findings.length} post-mortem violation(s) recorded`,
    });
    return;
  }

  if (event === "UserPromptSubmit") {
    const prompt = payload.prompt || "";
    if (/\bwhy.*(broken|regress|still failing)/i.test(prompt)) {
      // Inject regression-signal context — does NOT log a violation, just primes the agent
      clearTimeout(fallback);
      process.stdout.write(
        JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              "USER REGRESSION SIGNAL DETECTED — before re-running, audit which test tiers actually ran in the last invocation and enumerate them explicitly in your response.",
          },
        }) + "\n",
      );
      process.exit(0);
    }
    return passthrough();
  }

  return passthrough();
})();
