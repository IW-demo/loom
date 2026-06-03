# loom

**loom** is a Code Orchestration (CO/COC) artifact framework for agentic coding tools. It is the single source of truth for a set of **portable agent-governance artifacts** — rules, skills, agents, commands, and hooks — and the tooling that emits them to multiple coding-agent CLIs from one canonical definition.

The goal: encode hard-won engineering discipline (testing rigor, security hygiene, zero-tolerance for stubs, architectural review gates, knowledge capture) as **deterministic, loadable artifacts** that an AI coding agent picks up automatically — so quality is a property of the environment, not of remembering to ask for it.

## What's in here

| Directory | What it holds |
| --- | --- |
| `.claude/rules/` | The rule corpus — `MUST`/`MUST NOT` discipline (zero-tolerance, security, git, testing, agent orchestration, trust posture, …). Path-scoped or baseline. |
| `.claude/skills/` | Distilled reference skills (SDK patterns, testing strategies, security, CC architecture, …) loaded on demand. |
| `.claude/agents/` | Specialist sub-agent definitions (analysts, reviewers, framework specialists, CC/multi-CLI architects). |
| `.claude/commands/` | Slash-command workflows (`/analyze`, `/todos`, `/implement`, `/redteam`, `/codify`, `/sync`, …). |
| `.claude/hooks/` | Deterministic enforcement hooks (PreToolUse / PostToolUse / SessionStart) — the structural tripwire layer. |
| `.claude/bin/`, `tools/`, `scripts/` | Emission, validation, and parity tooling. |
| `.claude/variants/` | Language (py/rs) and CLI (codex/gemini) overlays composed over the global artifacts at emit time. |
| `.codex/`, `.gemini/`, `AGENTS.md`, `GEMINI.md` | Emitted artifact surfaces for Codex and Gemini, plus the always-on baseline docs. |

## The variant overlay system

A single artifact is authored once (the *neutral body*) and emitted to three CLI targets — Claude Code, Codex, and Gemini — with per-CLI and per-language *slot overlays* supplying only the parts that diverge (e.g. delegation syntax). A cross-CLI drift audit enforces that the semantic content stays identical across all three; only surface syntax may differ.

## Trust posture

Agent autonomy is bounded by a graduated, per-repo **trust posture** (L1–L5). Postures tighten automatically on detected violations and loosen only through an explicit human gate. The hooks + the rule corpus are the structural enforcement of that posture.

## Status

This is a public release of the framework. Internal development history is maintained separately and is not part of this repository.

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Terrene Foundation.
