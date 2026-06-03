# Codex bin/ — Emitted Dispatcher Tree

This directory holds executable dispatchers that flow to every Codex-aware
USE template repo at `<USE>/bin/`. Emitted by `/sync` per
`.claude/agents/management/coc-sync.md` Step 6.6.

## Files

| Source                              | Emitted to               | Mode | Purpose                                                                                            |
| ----------------------------------- | ------------------------ | ---- | -------------------------------------------------------------------------------------------------- |
| `.claude/codex-templates/bin/coc`   | `<USE>/bin/coc`          | 0755 | Unified Codex dispatcher — resolves phase → schema → `codex exec --json --output-schema=…`         |

## Why a dispatcher, not slash-commands

OpenAI Codex CLI 0.128+ deprecated **custom prompts** ("Custom prompts are
deprecated. Use skills for reusable instructions...") and only loads
prompts from `~/.codex/prompts/` (user-global) — repo-local `.codex/prompts/`
is **not discovered**. The repo-local discovery proposal was filed and
rejected upstream (openai/codex#9848).

Net effect: `/prompts:analyze`, `/prompts:todos`, etc. return "Unrecognized
command" in any synced consumer. The `bin/coc` dispatcher is the canonical
replacement: external CLI invocation routed through `codex exec --json` with
the per-phase JSON output schema, which Codex still supports natively.

## Phase suffix shims (`bin/coc-<phase>`)

Two equivalent invocation shapes:

- `bin/coc <phase> "<prompt>"` — argv[1] selects the phase
- `bin/coc-<phase> "<prompt>"` — basename suffix selects the phase

The second form is a thin shim — a symlink or one-line wrapper pointing at
`bin/coc`. The dispatcher reads its own `basename` to recover the phase
when invoked as `coc-<phase>`. coc-sync Step 6.6 creates the symlinks for
every phase in `.claude/wrappers/schemas/*.schema.json`.

## Runtime contract

### Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | `codex exec` was invoked successfully (the result propagates from it)  |
| 2    | Usage error / empty prompt / phase-name validation failure             |
| 3    | Schema file not found at `.claude/wrappers/schemas/<phase>.schema.json` |

Exit codes ≠ 0/2/3 are propagated from `codex exec` itself (typically
auth, schema validation, API quota, etc.).

### Prompt resolution precedence

The dispatcher resolves the prompt in this order (argv-first, stdin-fallback):

1. **Positional args** (`bin/coc <phase> "<prompt>"`) — wins whenever present.
2. **Stdin** (`bin/coc <phase> < file.txt` OR `cmd | bin/coc <phase>`) — used
   only when no positional args.
3. **Neither** → exit 2 with `ERROR: no prompt provided`.

Argv-first precedence is REQUIRED for non-TTY contexts (CI/cron,
agent subshells, `Bash(...)` tool calls): in those contexts `! -t 0`
is true even when argv carries the prompt, so a stdin-first check
would consume empty/unrelated stdin and falsely report
"prompt is empty". Compare `.claude/wrappers/ai.sh.template` for the
sibling pattern.

### Phase-name validation

Phase names MUST match `^[a-z][a-z0-9-]*$`. Names with path-separators
(`../../etc/passwd`), shell-meta, uppercase, or starting digits are
rejected at exit 2 BEFORE any path construction. This is a hard guard
against traversal — the schema-path is `${PROJECT_ROOT}/.claude/wrappers/schemas/${PHASE}.schema.json`;
a malformed phase would otherwise resolve outside the schemas directory.

### Integration

- **stdout** carries `codex exec --json` output (the structured JSON stream
  from Codex). Wrap with `jq` for downstream parsing.
- **stderr** carries dispatcher errors (usage, phase invalid, schema missing).
- **PATH** must include `codex` (the OpenAI Codex CLI binary); the
  dispatcher invokes `codex exec` via `PATH` lookup, not a hardcoded path.
- **CWD** does not matter — `PROJECT_ROOT` is resolved via
  `git rev-parse --show-toplevel` with `pwd` as fallback.

### Worked examples

```bash
# Argv invocation (recommended)
bin/coc analyze "Review the redteam findings in this PR"

# Stdin pipe (when prompt is large or composed)
echo "Review the redteam findings" | bin/coc analyze

# Phase-suffix shim invocation
bin/coc-analyze "Review the redteam findings"

# Inline-cat operating-spec injection (canonical specialist invocation, F79)
bin/coc analyze "$(cat .codex/prompts/specialist-analyst.md)

Task: identify failure points in src/foo.rs"
```

## Relationship with `.claude/wrappers/*.sh.template`

The per-phase `.sh.template` files under `.claude/wrappers/` are an
**older** wrapper surface that pre-dated this unified dispatcher. They
remain emitted (one per phase) for backward compatibility with operators
who scripted against `coc-<phase>.sh` invocations; the unified `bin/coc`
dispatcher is the **canonical** path going forward, and reduces N wrappers
to one + N symlinks.
