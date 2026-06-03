<!-- slot:examples -->

## Examples (Gemini-native delegation syntax)

The MUST clauses in the neutral-body section reference numbered examples here. This Gemini variant replaces the CC `Agent(subagent_type=...)` syntax with direct `@<agent-name>` invocations per the gemini-architect anti-pattern table (`.claude/agents/gemini-architect.md` line 132: "`@<agent-name>` is a real native call — the agent file at `.gemini/agents/<name>.md` is invoked directly"). The delegation primitive `@specialist` is also declared in loom's parity-audit `scrub_tokens` list at `.claude/sync-manifest.yaml::parity_enforcement.cross_cli_drift_audit.scrub_tokens`.

### Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

```
# DO — parallel deep-dive verification for ≥3-issue brief
# (one agent per claim cluster, run concurrently)
@general-purpose background: true
prompt: |
  Verify brief claim #1: 'ExperimentTracker creates _kml_model_versions'.
  Re-grep the source tree; cite file:line. Report TRUE / FALSE / UNCLEAR.

@general-purpose background: true
prompt: |
  Verify brief claim #2: 'InferenceServer at engines/inference_server.py'.
  Re-grep + re-read the cited path. Report TRUE / FALSE / UNCLEAR.

@general-purpose background: true
prompt: |
  Verify brief claim #3: '1.1.x kwargs silently dropped in 1.5.x'.
  Re-read the 1.5.x signature; check raise vs silent-drop. Report.

# Wait for all three; reconcile findings; record corrections in journal +
# architecture plan BEFORE /todos.

# DO NOT — single-agent analysis on a ≥3-issue brief
@analyst
prompt: "Analyze the brief and produce architecture plan."
# (the analyst inherits whatever framing the brief asserts; brief inaccuracies
# propagate into the plan, the plan into /todos, and three sessions later
# the workstream is solving the wrong problem.)
```

### Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Background agent pattern for MUST gates — review costs near-zero parent context
@reviewer background: true
prompt: "Review all changes since last gate..."

@security-reviewer background: true
prompt: "Security audit all changes..."
```

### Example 3 — Mechanical Sweep in Reviewer Prompt

```
# DO — reviewer prompt enumerates mechanical sweeps
@reviewer
prompt: |
  Mechanical sweeps (run BEFORE LLM judgment):
  1. Parity grep (`grep -c`) on critical call-site patterns
  2. `pytest --collect-only -q` exit 0 across all test dirs
  3. Every public symbol in __all__ added by this PR has an eager import

# DO NOT — reviewer prompt only includes diff context
@reviewer
prompt: "Review the diff between main and feat/X."
```

### Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```
# DO — pact-specialist or general-purpose for Round-2+ closure-parity verification
@pact-specialist
prompt: |
  Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep, pytest --collect-only,
  ast.parse() for __all__ enumeration. Convert FORWARDED rows to VERIFIED with command output.

# DO NOT — analyst (Read/Grep/Glob only) — cannot run gh / pytest / ast.parse()
@analyst
prompt: "Verify W5→W6 closure parity..."
```

### Example 5 — Delegation-Time Closure-Parity Scan

```
# DO — orchestrator detects closure-parity markers in draft prompt, picks Bash+Read specialist
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
# scan: contains "closure parity" + "gh pr view" + "ast.parse(" → MUST use Bash+Read
@pact-specialist
prompt: draft_prompt

# DO NOT — orchestrator drafts a closure-parity prompt and delegates to read-only analyst
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
@analyst
prompt: draft_prompt
# (analyst lacks Bash; will FORWARD the gh-pr-view rows; round burned)
```

### Example 6 — Worktree Isolation (compiling agents)

```
# DO — independent target/ dirs, compile in parallel
@general-purpose isolation: worktree
prompt: "implement feature X..."

# DO NOT — multiple agents sharing same target/ (serializes on lock)
@general-purpose
prompt: "implement feature X..."
```

### Example 7 — Worktree Relative Paths (NEVER absolute)

```
# DO — relative paths resolve to the worktree's cwd
@general-purpose isolation: worktree
prompt: "Edit packages/kailash-ml/src/kailash_ml/trainable.py..."

# DO NOT — absolute paths bypass worktree isolation
@general-purpose isolation: worktree
prompt: "Edit /absolute/path/to/main-checkout/packages/..."
```

### Example 8 — Worktree Commit Discipline

```
@general-purpose isolation: worktree
prompt: |
  ...
  **Commit discipline (MUST):**
  - After each file: `git add <file> && git commit -m "wip(shard-X): <what>"`
  - Exit-without-commit auto-cleans the worktree and ALL work is lost.
```

### Example 9 — Parallel-Worktree Version-Owner Coordination

```
@general-purpose isolation: worktree
prompt: "bump package to 0.13.0, CHANGELOG, __version__"  # owner

@general-purpose isolation: worktree
prompt: |
  ...feature work...
  COORDINATION NOTE: parallel agent is bumping; MUST NOT edit pyproject.toml / __version__ / CHANGELOG.
```

<!-- /slot:examples -->
