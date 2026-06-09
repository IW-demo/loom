<!-- slot:examples -->

## Examples

**Rule-mapping + scope (F113a).** These examples illustrate Gemini-native (`@<agent>`) delegation syntax for the global rules whose example references a CLI delegation primitive: global **Rule 1** (pin path) + **Rule 3** (verify deliverables), plus the **§ MUST NOT** parent-checkout-path corollary and the cross-rule commit discipline. Global **Rule 4 — Parallel-Launch Concurrency Is Throttle-Aware Adaptive — is CC-runtime-specific** and intentionally carries NO Gemini example: its back-off signal originates at the Anthropic server boundary and the cold-start cap governs CC `Agent`/Workflow concurrency; Gemini's orchestration primitives differ fundamentally (per journal/0194 BC-9 / the F111 deferral). Global **Rule 2** (cwd self-check) and **Rule 5** (pre-flight merge-base) carry no Gemini-divergent delegation primitive (agent-file / `git` shapes already shown by the Rule 1 example); **Rule 6** (branch-name match) follows the same pinned-path delegation shape as Rule 1. Realigned per journal/0196 § F113a.

### Rule 1 — Orchestrator Prompts Pin The Worktree Path

```python
# DO — explicit path + verification instruction
worktree = "/Users/<user>/repos/myproject/.gemini/worktrees/agent-feature-abc123"

@ml-specialist
isolation: worktree
prompt: |
  Working directory: {worktree}

  STEP 0 — verify isolation before touching any file:
    git -C {worktree} status
  If the output shows "not a git repository" OR the branch does not
  match the worktree's expected branch, STOP and report "worktree
  isolation broken" — do NOT fall back to the main checkout.

  All file paths you write MUST be absolute and begin with {worktree}/.

# DO NOT — isolation flag without pinned path
@ml-specialist
isolation: worktree
prompt: "Implement feature X — use the framework-specialist patterns."
# Agent starts in the main checkout's cwd, edits main's tree,
# reports success. Worktree is empty; main has half-done code.
```

### Rule 3 — Parent Verifies Deliverables After Agent Exit

```python
# DO — verify after agent returns
@ml-specialist
isolation: worktree
prompt: "Write {worktree}/src/feature.py..."
# (parent then checks: assert_file_exists(f"{worktree}/src/feature.py"))

# DO NOT — trust "done" and proceed
@ml-specialist
isolation: worktree
prompt: "..."
# Parent commits based on result.completion_message without file-read check
```

### Rule 1 corollary (§ MUST NOT) — Absolute Paths Anchor To The Worktree, Not The Parent Checkout

```python
# DO — relative paths, resolve to worktree cwd
@ml-specialist
isolation: worktree
prompt: "Edit packages/kailash-ml/src/kailash_ml/trainable.py at line 370..."

# DO — absolute paths anchored to the PINNED worktree path (Rule 1 style)
worktree = "/Users/<user>/repos/myproject/.gemini/worktrees/agent-feature-abc123"

@ml-specialist
isolation: worktree
prompt: "Edit {worktree}/packages/kailash-ml/src/kailash_ml/trainable.py at line 370..."

# DO NOT — absolute paths pointing to the PARENT checkout
@ml-specialist
isolation: worktree
prompt: "Edit /Users/<user>/repos/myproject/packages/kailash-ml/src/kailash_ml/trainable.py at line 370..."
# ↑ writes land in the MAIN checkout; the worktree stays empty; auto-cleanup
#   deletes the empty worktree; agent's work is either silently on main OR lost.
```

### Commit Discipline — pairs with `agents.md` § Worktree Agents Commit Incremental Progress

```python
# DO — prompt includes incremental commit discipline
@ml-specialist
isolation: worktree
prompt: |
  ...
  **Commit discipline (MUST):**
  - After each file is complete, run `git add <file> && git commit -m "wip(shard-X): <what>"`.
  - Do NOT hold all work in the worktree's index until the final report.
  - If you exit without committing (budget exhaustion / crash / interruption),
    the worktree is auto-cleaned and ALL work is lost.

# DO NOT — trust that the agent commits at completion
@ml-specialist
isolation: worktree
prompt: "Implement feature X. Report when done."
# ↑ agent writes 4 files, hits budget on file 5, emits truncated message,
#   never reaches `git commit`, worktree auto-cleaned — all 5 files lost.
```

<!-- /slot:examples -->
