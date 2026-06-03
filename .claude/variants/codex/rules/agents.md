<!-- slot:examples -->

## Examples (Codex-native delegation syntax)

The MUST clauses below reference numbered examples here. Codex has no native specialist-by-name primitive. OpenAI deprecated custom prompts 2026-05-28 (issue #385); repo-local `.codex/prompts/` is no longer loaded by Codex CLI 0.128+ (openai/codex#9848). loom still ships `.codex/prompts/specialist-<name>.md` per `.claude/agents/**/<name>.md` as on-disk operating-spec content; invoke by inline-cat injection via `bin/coc <phase> "$(cat .codex/prompts/specialist-<name>.md)\n\nTask: ..."` or by natural-language subagent spawn referencing the file path (interactive only).

### Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

```
# DO — interactive Codex: spawn 3 parallel worker subagents, one per claim cluster
# (each worker loads specialist-... as its operating spec before starting)
Delegate to a worker subagent. Operating spec: specialist-analyst.
  Verify brief claim #1: 'ExperimentTracker creates _kml_model_versions'.
  Re-grep the source tree; cite file:line. Report TRUE / FALSE / UNCLEAR.

Delegate to a second worker subagent (in parallel). Operating spec:
  specialist-analyst.
  Verify brief claim #2: 'InferenceServer at engines/inference_server.py'.
  Re-grep + re-read the cited path. Report TRUE / FALSE / UNCLEAR.

Delegate to a third worker subagent (in parallel). Operating spec:
  specialist-analyst.
  Verify brief claim #3: '1.1.x kwargs silently dropped in 1.5.x'.
  Re-read the 1.5.x signature; check raise vs silent-drop. Report.

# Wait for all three; reconcile findings; record corrections in journal +
# architecture plan BEFORE /todos.

# DO NOT — single-agent analysis on a ≥3-issue brief
specialist-analyst
Analyze the brief and produce the architecture plan.
# (the analyst inherits whatever framing the brief asserts; brief inaccuracies
# propagate into the plan, the plan into /todos, and three sessions later
# the workstream is solving the wrong problem.)
```

### Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Interactive: parallel background workers loaded with reviewer + security-reviewer specs.
Delegate to a background worker subagent. Operating spec:
  specialist-reviewer.
  Review all changes since last gate...

Delegate to another background worker subagent (parallel). Operating spec:
  specialist-security-reviewer.
  Security audit all changes...
```

### Example 3 — Mechanical Sweep in Reviewer Prompt

```
# DO — worker subagent loaded with reviewer spec, enumerated mechanical sweeps
Delegate to a worker subagent. Operating spec: specialist-reviewer.
Task:
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep (`grep -c`) on critical call-site patterns
2. `pytest --collect-only -q` exit 0 across all test dirs
3. Every public symbol in __all__ added by this PR has an eager import

# DO NOT — reviewer prompt only includes diff context
Delegate to a worker subagent. Operating spec: specialist-reviewer.
Task: Review the diff between main and feat/X.
```

### Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```
# DO — pact specialist (or general-purpose) for Round-2+ closure-parity verification
Delegate to a worker subagent. Operating spec: specialist-pact.
Task: Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep,
pytest --collect-only, ast.parse() for __all__ enumeration. Convert
FORWARDED rows to VERIFIED with command output.

# DO NOT — analyst (Read/Grep/Glob only) — cannot run gh / pytest / ast.parse()
Delegate to a worker subagent. Operating spec: specialist-analyst.
Task: Verify W5→W6 closure parity...
```

### Example 5 — Delegation-Time Closure-Parity Scan

```
# DO — orchestrator detects closure-parity markers in draft task, picks Bash+Read specialist
draft_task = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
# scan: contains "closure parity" + "gh pr view" + "ast.parse(" → MUST use Bash+Read
Delegate to a worker subagent. Operating spec: specialist-pact.
Task: <draft_task>

# DO NOT — orchestrator drafts a closure-parity task and delegates to read-only analyst
Delegate to a worker subagent. Operating spec: specialist-analyst.
Task: <draft_task>
# (analyst lacks Bash; will FORWARD the gh-pr-view rows; round burned)
```

### Example 6 — Worktree Isolation (compiling agents)

```
# DO — independent target/ dirs, compile in parallel via interactive worker subagents
Delegate to a worker subagent with isolation=worktree. Operating spec:
  specialist-ml.
  Task: implement feature X...

# DO NOT — multiple agents sharing same target/ (serializes on lock)
Delegate to a worker subagent (no isolation). Task: implement feature X...
```

### Example 7 — Worktree Relative Paths (NEVER absolute)

```
# DO — relative paths resolve to the worktree's cwd
Delegate to a worker subagent with isolation=worktree. Operating spec:
  specialist-ml.
  Task: Edit packages/kailash-ml/src/kailash_ml/trainable.py...

# DO NOT — absolute paths bypass worktree isolation
Delegate to a worker subagent with isolation=worktree. Operating spec:
  specialist-ml.
  Task: Edit /absolute/path/to/main-checkout/packages/...
```

### Example 8 — Worktree Commit Discipline

```
Delegate to a worker subagent with isolation=worktree. Operating spec:
  specialist-ml.
  Task:
  ...
  **Commit discipline (MUST):**
  - After each file: `git add <file> && git commit -m "wip(shard-X): <what>"`
  - Exit-without-commit auto-cleans the worktree and ALL work is lost.
```

### Example 9 — Parallel-Worktree Version-Owner Coordination

```
# Owner shard (version bumper)
Delegate to a worker subagent with isolation=worktree. Operating spec:
  specialist-release.
  Task: bump package to 0.13.0, CHANGELOG, __version__

# Sibling shard (feature work, MUST NOT bump version)
Delegate to a worker subagent (parallel) with isolation=worktree.
Operating spec: specialist-ml.
Task: ...feature work...
COORDINATION NOTE: a parallel worker is bumping; MUST NOT edit
pyproject.toml / __version__ / CHANGELOG.
```

<!-- /slot:examples -->
