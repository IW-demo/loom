# Kailash CO Artifact Management Platform

Single source of truth for all CO/COC artifacts. Uses a **variant overlay system** to manage shared (global) and language-specific (py/rs/rb) artifacts, distributing via `/sync`.

No coding happens here. This repo manages institutional knowledge infrastructure.

## Architecture

```
issue ──routed by TYPE──┬─ COC-artifact → USE-template (kailash-coc-*) → /codify
                        └─ bug/code     → BUILD repo → cross-SDK-FIRST → /codify
                              │
                              ▼
                        proposal [scrubbed on intake]
                              │
                              ▼
        loom/.claude/  ← SPLITTER (Gate-1 human classify; does NOT originate)
          agents/, commands/, rules/...     ← Global artifacts (CC + CO + COC)
          variants/py|rs|rb/                ← Language-specific overlays
          sync-manifest.yaml                ← Tier membership + variant declarations
              │
              ├── /sync-to-build ──→ kailash-py / kailash-rs (BUILD; canonical pushed back)
              └── /sync py|rs|rb ──→ kailash-coc-claude-{py,rs,rb}/ ──→ downstream USE/project repos pull (own /sync)
                                                          │
                                                          └──→ cycle repeats
```

**Flow**: issues route by change TYPE — COC-artifact improvements to the USE-template repo, SDK bugs/features to the BUILD repo (cross-SDK-first). Each originates a proposal via `/codify`; both intake streams inherit the disclosure scrub on Gate-1 ingest. loom is the central splitter (Gate-1 human classify: global vs variant) and does NOT originate. It distributes via `/sync-to-build` (BUILD canonical) and `/sync` (USE templates → downstream pull). USE-template `/codify` proposal origination is the authoritative target flow per `guides/co-setup/09-proposal-protocol.md` Step 7b.

See `guides/co-setup/05-variant-architecture.md` and `guides/co-setup/06-artifact-lifecycle.md`.

## Absolute Directives

### 0. Artifact Management Only

No code. Work here: create/edit/review artifacts, `/sync` to targets, `/inspect` across repos, `/settings` for Claude Code config.

### 1. LLM-First Agent Reasoning

The LLM does ALL reasoning. Tools are dumb data endpoints. See `rules/agent-reasoning.md`.

### 2. Zero Tolerance

Pre-existing failures, warnings, and notices MUST be fixed. Stubs BLOCKED. See `rules/zero-tolerance.md`.

### 3. Recommended Reviews

Intermediate review after changes. Security review before commits. Gold-standards for terminology consistency, content quality, and cross-reference integrity.

## Commands

| Command          | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `/sync`          | Review BUILD repo changes (Gate 1) + distribute to templates (Gate 2) |
| `/sync-to-build` | Push artifacts with variant overlays to BUILD repos (kailash-py/rs)   |
| `/repos`         | List repositories, show status overview                               |
| `/inspect`       | Cross-repo inspection, drift detection, COC freshness                 |
| `/settings`      | Claude Code settings globally or per-project                          |
| `/ws`            | Workspace status dashboard                                            |
| `/wrapup`        | Session notes before ending                                           |
| `/journal`       | View, create, or search journal entries                               |

COC phase commands (`/analyze`, `/todos`, `/implement`, `/redteam`, `/codify`, `/release`) and utility commands (`/sdk`, `/db`, `/api`, `/ai`, `/test`, `/design`, `/validate`, `/deploy`, `/start`, `/learn`, `/i-audit`, `/i-polish`, `/i-harden`) are maintained here for sync to target repos.

## Rules Index

| Concern                                                                                                                                                                                                    | Rule File                       | Category |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------- |
| **Autonomous execution**                                                                                                                                                                                   | `rules/autonomous-execution.md` | CO       |
| **LLM-first agent reasoning**                                                                                                                                                                              | `rules/agent-reasoning.md`      | CO       |
| **Artifact flow control**                                                                                                                                                                                  | `rules/artifact-flow.md`        | CO       |
| Zero tolerance                                                                                                                                                                                             | `rules/zero-tolerance.md`       | CO       |
| CC artifact quality                                                                                                                                                                                        | `rules/cc-artifacts.md`         | CO       |
| **Rule authoring (Loud/Linguistic/Layered)**                                                                                                                                                               | `rules/rule-authoring.md`       | CO       |
| **Specs authority (domain truth)**                                                                                                                                                                         | `rules/specs-authority.md`      | CO       |
| **Spec accuracy (no phantom citations / no Phase-1/2 framings)**                                                                                                                                           | `rules/spec-accuracy.md`        | CO       |
| Journal, naming, git, branch protection, security, communication, cross-SDK                                                                                                                                | `rules/{name}.md`               | CO       |
| Agent orchestration, no-stubs, deployment, e2e, env-models, patterns, testing, infrastructure-sql, pact, trust-plane, eatp, dataflow-pool, connection-pool, documentation, observability, schema-migration | `rules/{name}.md`               | COC      |

CO rules apply in this repo. COC rules are maintained here for sync.

## Agents (38 total)

### Management (`agents/management/`) — loom-only, excluded from sync (7)

- **coc-sync** — Gate 2: distribute with variant overlays
- **sync-reviewer** — Gate 1: review + classify BUILD repo changes
- **repo-ops** — Cross-repo inspection, drift detection, bulk git ops
- **settings-manager** — Claude Code settings across global/project
- **posture-auditor** — trust-posture state audit
- **todo-manager**, **gh-manager**

### Root (`agents/`) — CC + multi-CLI + strategy (6)

- **cc-architect** — CC artifact quality auditing
- **cli-orchestrator** — multi-CLI parity/drift dispatch
- **codex-architect**, **gemini-architect** — per-CLI artifact architects
- **value-auditor** — enterprise-demo value/narrative QA
- **open-source-strategist** — loom-only (Foundation open-core strategy, NOT synced; obsoleted downstream per `sync-manifest.yaml`)

### COC Specialists (synced to subscribing targets)

- **Analysis** (`agents/analysis/`): **analyst** (failure points, requirements, ADRs)
- **Frameworks** (`agents/frameworks/`, 8): dataflow, nexus, kaizen, mcp, mcp-platform, pact, ml, align specialists
- **Generic** (`agents/generic/`, 3): ai-specialist, api-specialist, db-specialist (stack-agnostic; read STACK.md)
- **Implementation** (`agents/implementation/`): pattern-expert, tdd-implementer, build-fix
- **Frontend** (`agents/frontend/`): react-specialist, flutter-specialist, uiux-designer
- **Quality** (`agents/quality/`): **reviewer** (code review, doc validation), gold-standards-validator, security-reviewer
- **Release** (`agents/release/`): **release-specialist** (CI/CD, PyPI, deployment)
- **Testing** (`agents/testing/`): testing-specialist
- **Onboarding** (`agents/onboarding/`, 2): idiom-advisor, stack-detector

Count excludes `agents/_README.md` (not an agent).

## Skills

`01-core-sdk/` through `05-kailash-mcp/` (SDK frameworks), `06-cheatsheets/` through `09-workflow-patterns/` (references), `10-deployment-git/` through `18-security-patterns/` (operations/quality), `19-flutter-patterns/` through `25-ai-interaction-patterns/` (frontend/UX), `26-eatp-reference/` through `31-error-troubleshooting/` (standards/CC/troubleshooting), `34-kailash-ml/` and `35-kailash-align/` (ML lifecycle), `co-reference/` (CO methodology).

## Guides

- `guides/deterministic-quality/` — **Rule authoring (Loud/Linguistic/Layered), session architecture, enforcement ladder, SDK primitives** (8 files + README, validated by subprocess A/B tests)
- `guides/claude-code/` — Claude Code user guide (17 files)
- `guides/co-setup/` — CO architecture, variant system, artifact lifecycle
- `guides/model-optimization/` — Opus vs Sonnet research

## CO Methodology

For deep reference: `skills/co-reference/` (CARE/EATP/CO/COC specs), `guides/co-setup/`. CO provides principles and 5-layer architecture. COC populates each layer with codegen content.

## Kailash Platform

| Framework | Purpose                                | Install                           |
| --------- | -------------------------------------- | --------------------------------- |
| Core SDK  | Workflow orchestration, 140+ nodes     | `pip install kailash`             |
| DataFlow  | Zero-config database operations        | `pip install kailash-dataflow`    |
| Nexus     | Multi-channel deployment (API+CLI+MCP) | `pip install kailash-nexus`       |
| Kaizen    | AI agent framework                     | `pip install kailash-kaizen`      |
| Trust     | EATP + trust-plane governance          | Included in `pip install kailash` |
| PACT      | Organizational governance (D/T/R)      | `pip install kailash-pact`        |
| ML        | Classical + deep learning lifecycle    | `pip install kailash-ml`          |
| Align     | LLM fine-tuning/alignment + serving    | `pip install kailash-align`       |

`pip install kailash` includes all standard dependencies (trust, server, HTTP, database, monitoring, data). Sub-packages add framework-specific functionality. Only vendor-specific secret backends (Vault, AWS, Azure, LDAP) remain as optional extras.
