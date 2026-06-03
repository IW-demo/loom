# Codex Template Source Tree

Source templates for Codex-specific content that flows into Codex-aware USE template repos. Peer to `.claude/gemini-templates/`. Authored here; emitted by coc-sync into each USE template's `.codex/` directory at Gate 2.

## Layout

```
.claude/codex-templates/
├── README.md           # this file
├── bin/                # unified COC phase dispatcher (canonical Codex invocation
│                       # path; replaces deprecated /prompts:<name> upstream)
│   └── coc             # bin/coc <phase> "<prompt>"  → codex exec --json …
├── config.toml         # base ~/.codex/config.toml or repo-local .codex/config.toml
├── hooks.json          # base .codex/hooks.json (Bash-only tool enforcement)
├── prompts/            # on-disk operating-spec content for inline-cat injection
│                       # (historical /prompts:<name> invocation deprecated upstream;
│                       # repo-local .codex/prompts/ is no longer loaded by Codex
│                       # CLI 0.128+ per openai/codex#9848)
│   ├── README.md
│   └── *.md.example
├── skills/             # SKILL.md progressive-disclosure (mirror .claude/skills/)
└── docs/               # reference material
```

## Emission targets

Codex-aware USE templates listed in `.claude/sync-manifest.yaml → repos.{target}.templates[]` where `clis` includes `codex`:

- `kailash-coc-py` (Phase H1)
- `kailash-coc-rs` (Phase H1)

CC-only and non-Codex USE templates do NOT receive `.codex/`.

## Key Codex-specific differences from Gemini/CC

- **Hooks fire on Bash only**: `apply_patch` / Write / MCP tool calls do NOT emit PreToolUse/PostToolUse. Non-Bash enforcement stays with `.claude/codex-mcp-guard/server.js` (MCP layer). Both are emitted; together they cover the tool surface.
- **COC phase invocation**: `bin/coc <phase> "<prompt>"` is the canonical Codex invocation path; it forwards to `codex exec --json --output-schema=<phase>.schema.json`. The historical `/prompts:<name>` form is deprecated upstream (OpenAI Codex CLI 0.128+ no longer loads repo-local `.codex/prompts/` per openai/codex#9848 + issue #385); `.codex/prompts/specialist-<name>.md` remains on disk as operating-spec content for inline-cat injection (`bin/coc <phase> "$(cat .codex/prompts/specialist-<name>.md)\n\nTask: ..."`).
- **Slash commands are Markdown** (NOT TOML — Gemini diverges here).
- **`AGENTS.md` default cap**: 32,768 bytes. Wrapper override `-c project_doc_max_bytes=65536` is mandatory in all `bin/coc-*` wrappers per `.claude/rules/agents.md` (see codex-architect.md).
- **`paths:` frontmatter not honored**: Use `.github/instructions/*.instructions.md` with `applyTo:` glob for path-scoped overlays.

## Source of truth

| Emitted file                       | Source                                | Generation                                                        |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `.codex/config.toml`               | `.claude/codex-templates/config.toml` | Copy + merge MCP server blocks                                    |
| `.codex/hooks.json`                | `.claude/codex-templates/hooks.json`  | Copy + merge per-repo hook additions                              |
| `.codex/prompts/<name>.md`         | `.claude/commands/<name>.md`          | Copy with Codex-native adaptations (e.g. `codex review` override) |
| `.codex/skills/<nn-name>/SKILL.md` | `.claude/skills/<nn-name>/SKILL.md`   | Copy (contract shared with CC)                                    |

## Relationship with `.claude/codex-mcp-guard/`

The `.codex-mcp-guard/` directory (at `.claude/codex-mcp-guard/`) is a SEPARATE first-class owner: the MCP guard server itself. This template tree is the Codex-CLI-native config (hooks, prompts, skills). Both emit to the same USE template, at:

- `<USE>/.codex-mcp-guard/` — MCP guard server (from `.claude/codex-mcp-guard/`)
- `<USE>/.codex/` — Codex CLI config tree (from this directory)
- `<USE>/AGENTS.md` — baseline context (from `emit.mjs`)

## Full documentation

See `.claude/agents/codex-architect.md` for the Codex ownership matrix + verified capability envelope.
