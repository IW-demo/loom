<!-- slot:examples -->

## Examples

Codex lacks a native `codex_agent(...)` primitive. OpenAI deprecated custom prompts 2026-05-28 (issue #385); repo-local `.codex/prompts/` is no longer loaded by Codex CLI 0.128+ (openai/codex#9848). loom still ships `.codex/prompts/specialist-<name>.md` per `.claude/agents/**/<name>.md` as on-disk operating-spec content; worktree-isolated delegations invoke by inline-cat injection via `bin/coc <phase> "$(cat .codex/prompts/specialist-<name>.md)\n\nTask: ..."` or by natural-language subagent spawn referencing the file path (interactive only). Paths in this variant target the Rust BUILD repo (`kailash-rs`).

**Rule-mapping + scope (F113a).** These examples illustrate Codex-native delegation syntax for the global rules whose example references a CLI delegation primitive: global **Rule 1** (pin path) + **Rule 3** (verify deliverables), plus the **§ MUST NOT** parent-checkout-path corollary and the cross-rule commit discipline. Global **Rule 4 — Parallel-Launch Concurrency Is Throttle-Aware Adaptive — is CC-runtime-specific** and intentionally carries NO Codex example: its back-off signal originates at the Anthropic server boundary and the cold-start cap governs CC `Agent`/Workflow concurrency; Codex's orchestration primitives differ fundamentally (per journal/0194 BC-9 / the F111 deferral). Global **Rule 2** (cwd self-check) and **Rule 5** (pre-flight merge-base) carry no Codex-divergent delegation primitive (agent-file / `git` shapes already shown by the Rule 1 example); **Rule 6** (branch-name match) follows the same pinned-path delegation shape as Rule 1. Realigned per journal/0196 § F113a.

### Rule 1 — Orchestrator Prompts Pin The Worktree Path

```
# DO — explicit path + verification instruction inlined in the delegation task
worktree=/Users/<user>/repos/myproject/.codex/worktrees/agent-feature-abc123

Delegate to a worker subagent (isolation=worktree, branch=feat/<name>).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task:
  Working directory: $worktree

  STEP 0 — verify isolation before touching any file:
    git -C $worktree status
  If the output shows "not a git repository" OR the branch does not
  match the worktree's expected branch, STOP and report "worktree
  isolation broken" — do NOT fall back to the main checkout.

  All file paths you write MUST be absolute and begin with $worktree/.

# DO NOT — isolation flag without pinned path
Delegate to a worker subagent (isolation=worktree).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task: Implement feature X — use the framework-specialist patterns.
# Agent starts in the main checkout's cwd, edits main's tree, reports success.
# Worktree is empty; main has half-done code.
```

### Rule 3 — Parent Verifies Deliverables After Agent Exit

```
# DO — verify after the worker subagent returns
[parent emits delegation; waits for completion]
ls "$worktree/src/feature.rs"  # parent checks; raises if missing → retry

# DO NOT — trust "done" and proceed
# Parent commits based on the completion message without a file-read check.
```

### Rule 1 corollary (§ MUST NOT) — Absolute Paths Anchor To The Worktree, Not The Parent Checkout

```
# DO — relative paths, resolve to worktree cwd
Delegate to a worker subagent (isolation=worktree).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task: Edit packages/kailash-ml/src/trainable.rs at line 370...

# DO — absolute paths anchored to the PINNED worktree path (Rule 1 style)
worktree=/Users/<user>/repos/myproject/.codex/worktrees/agent-feature-abc123

Delegate to a worker subagent (isolation=worktree).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task: Edit $worktree/packages/kailash-ml/src/trainable.rs at line 370...

# DO NOT — absolute paths pointing to the PARENT checkout
Delegate to a worker subagent (isolation=worktree).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task: Edit /Users/<user>/repos/myproject/packages/kailash-ml/src/trainable.rs at line 370...
# ↑ writes land in the MAIN checkout; the worktree stays empty; auto-cleanup
#   deletes the empty worktree; the work is either silently on main OR lost.
```

### Commit Discipline — pairs with `agents.md` § Worktree Agents Commit Incremental Progress

```
# DO — task includes incremental commit discipline
Delegate to a worker subagent (isolation=worktree).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task:
  ...
  **Commit discipline (MUST):**
  - After each file is complete, run `git add <file> && git commit -m "wip(shard-X): <what>"`.
  - Do NOT hold all work in the worktree's index until the final report.
  - If you exit without committing (budget exhaustion / crash / interruption),
    the worktree is auto-cleaned and ALL work is lost.

# DO NOT — trust that the agent commits at completion
Delegate to a worker subagent (isolation=worktree).
Operating spec: "$(cat .codex/prompts/specialist-ml.md)"
Task: Implement feature X. Report when done.
# ↑ agent writes 4 files, hits budget on file 5, emits truncated message,
#   never reaches `git commit`, worktree auto-cleaned — all 5 files lost.
```

<!-- /slot:examples -->
