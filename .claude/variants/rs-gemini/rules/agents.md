<!-- slot:examples -->

## Examples

### Quality Gates — Background Agent Pattern

```
@reviewer
run_in_background: true
prompt: "Review all changes since last gate..."

@security-reviewer
run_in_background: true
prompt: "Security audit all changes..."
```

### Reviewer Mechanical Sweeps

```
# DO — reviewer prompt enumerates mechanical sweeps
@reviewer
prompt: |
  ... diff context ...
  Mechanical sweeps (run BEFORE LLM judgment):
  1. Parity grep — every `return TrainingResult(...)` call site must pass `device=...`
  2. `cargo check --workspace` exit 0 across the workspace
  3. `cargo tree -d` — no new dependency conflicts vs main
  4. For every public item added — verify `pub use` re-export in the crate root

# DO NOT — reviewer prompt only includes diff context
@reviewer
prompt: "Review the diff between main and feat/X."
```

### Worktree Isolation for Compiling Agents

```
# DO
@ml-specialist
isolation: worktree
prompt: "implement feature X..."

# DO NOT: two agents sharing target/ serialize on cargo's exclusive lock
```

### Worktree Prompts Use Relative Paths Only

```rust
// DO — relative paths, resolve to worktree cwd
@ml-specialist
isolation: worktree
prompt: "Edit packages/kailash-ml/src/trainable.rs..."

// DO NOT — absolute path rooted in parent checkout
// (writes land in MAIN; worktree empty; auto-cleanup loses the work)
```

### Verify Agent Deliverables Exist After Exit

```rust
// DO — verify after @agent returns
read_file("/abs/path/src/feature.rs")  // raises if missing → retry

// DO NOT — trust completion message
```

<!-- /slot:examples -->
