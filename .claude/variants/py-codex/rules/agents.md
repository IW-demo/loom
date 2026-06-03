<!-- slot:examples -->

## Examples

Codex lacks a native `codex_agent(...)` primitive. OpenAI deprecated custom prompts 2026-05-28 (issue #385); repo-local `.codex/prompts/` is no longer loaded by Codex CLI 0.128+ (openai/codex#9848). loom still ships `.codex/prompts/specialist-<name>.md` per `.claude/agents/**/<name>.md` as on-disk operating-spec content; invoke by inline-cat injection via `bin/coc <phase> "$(cat .codex/prompts/specialist-<name>.md)\n\nTask: ..."` or by natural-language subagent spawn referencing the file path (interactive only).

### Quality Gates — Background Agent Pattern

```
# Parallel background workers, one per quality gate
Delegate to a background worker subagent. Operating spec:
"$(cat .codex/prompts/specialist-reviewer.md)"
Task: Review all changes since last gate...

Delegate to another background worker subagent (parallel).
Operating spec: "$(cat .codex/prompts/specialist-security-reviewer.md)"
Task: Security audit all changes...
```

### Reviewer Mechanical Sweeps

```
# DO — reviewer task enumerates mechanical sweeps
Delegate to a worker subagent. Operating spec:
"$(cat .codex/prompts/specialist-reviewer.md)"
Task:
... diff context ...
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep — every `return TrainingResult(...)` call site must pass `device=...`
2. `pytest --collect-only -q` exit 0 across all test dirs
3. `pip check` — no new conflicts vs main
4. For every public symbol in __all__ added by this PR — verify eager import

# DO NOT — reviewer task only includes diff context
Delegate to a worker subagent. Operating spec:
"$(cat .codex/prompts/specialist-reviewer.md)"
Task: Review the diff between main and feat/X.
```

### Worktree Isolation for Compiling Agents

```
# DO — independent target/ dirs, compile in parallel via worker subagents with isolation
Delegate to a worker subagent (isolation=worktree). Operating spec:
"$(cat .codex/prompts/specialist-ml.md)"
Task: implement feature X...

# DO NOT — multiple workers sharing target/ (serializes on lock)
Delegate to a worker subagent. Operating spec:
"$(cat .codex/prompts/specialist-ml.md)"
Task: implement feature X...
```

### Worktree Prompts Use Relative Paths Only

```
# DO — relative paths, resolve to worktree cwd
Delegate to a worker subagent (isolation=worktree). Operating spec:
"$(cat .codex/prompts/specialist-ml.md)"
Task: Edit packages/kailash-ml/src/kailash_ml/trainable.py...

# DO NOT — absolute path rooted in parent checkout
# (writes land in MAIN; worktree empty; auto-cleanup loses the work)
Delegate to a worker subagent (isolation=worktree). Operating spec:
"$(cat .codex/prompts/specialist-ml.md)"
Task: Edit /Users/me/repos/myproject/packages/kailash-ml/src/kailash_ml/trainable.py...
```

### Verify Agent Deliverables Exist After Exit

```
# DO — verify after the worker subagent returns
[parent emits delegation; waits for completion]
ls "/abs/path/src/feature.py"  # raises if missing → retry

# DO NOT — trust completion message
# Parent acts on the completion claim without file-read check.
```

<!-- /slot:examples -->
