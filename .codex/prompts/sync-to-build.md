---
name: sync-to-build
description: "Merge artifacts with variant overlays from loom/ into BUILD repos (kailash-py, kailash-rs)"
---

Merge CC+CO+COC artifacts from loom/ (source of truth) into BUILD repos, applying variant overlays. This is a **merge**, not a copy — BUILD repos have legitimate local content that must be preserved and understood.

**Usage**: `/sync-to-build [target]`

- `target`: `py`, `rs`, or `all`. If omitted, ask.

## Critical: This Is Not rsync

BUILD repos contain three kinds of content:

| Kind                 | Examples                                                 | Action                                          |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| **Shared**           | Global agents, rules, commands, guides, hooks            | Update from source (with variant overlay)       |
| **BUILD-specific**   | Internal crate docs, binding agents, BUILD-only commands | **Preserve** — never overwrite, never delete    |
| **Stale duplicates** | Old-numbered skills superseded by globals                | Flag for human review (may need manual cleanup) |

Before writing ANY file, you MUST read the target's existing content to understand what's there.

## Process

### 1. Resolve BUILD repo

Read `sync-manifest.yaml` → `repos.{target}.build` to get the BUILD repo name.

**Early-exit on `build: null` (MUST).** When `repos.<target>.build` is `null`, `/sync-to-build` MUST exit immediately, before any inventory or merge planning, with the following message:

```
ERROR: /sync-to-build {target} is not applicable.
sync-manifest.yaml declares repos.{target}.build: null — this variant has no BUILD source.
Use `/sync {target}` for USE-template distribution instead.
```

The `base` variant (v2.21.0+, language-agnostic non-Kailash) is the canonical case: there is no `kailash-base` BUILD repo because the variant ships USE-template artifacts only (cc + co tier methodology + onboarding tier stack-detection skills) — there is no Kailash framework code to push to a BUILD source. `/codify` proposals from base-variant USE consumers route directly to loom (loom owns COC variant distribution including the base axis); they do NOT route through a BUILD repo because none exists.

**BLOCKED rationalizations:** "I'll synthesize a fake BUILD path so the rest of the command works" / "Treat `null` as the empty string and continue" / "Resolve to a sibling repo and push there as a no-op" / "/sync-to-build base is harmless if there's nothing to push — let it run". A `null` build is a structural signal that `/sync-to-build` is the wrong command for this variant; running it anyway either silently no-ops (hiding the operator's mistake) or writes to a wrong target (data corruption).

Otherwise resolve to absolute path and proceed to step 2.

### 2. Inventory the BUILD repo (READ FIRST)

Before computing what to push, read what the BUILD repo already has:

1. List ALL directories under BUILD `.claude/skills/` — note any that use different numbering than loom/ source
2. List ALL agents, commands, rules — note BUILD-specific files
3. If skill numbering diverges from source, **STOP and report** — do not blindly push canonical-numbered skills on top of a differently-numbered tree

### 3. Compute expected state

For each file in loom/.claude/ that's in a tier (cc/co/coc), NOT in `exclude:`, AND NOT in `build_exclude:`:

- If a variant exists for this target → use variant version
- Otherwise → use global

**`build_exclude:` is BUILD-specific.** It lists files that are USE-only (e.g., `commands/deploy.md`, `rules/deploy-hygiene.md`, `skills/10-deployment-git/application-deployment.md`). These exist for downstream apps that deploy running code; BUILD repos release packages via `/release` and have no use for them. /sync-to-build MUST skip every file in `build_exclude:`. /sync (Gate 2 to USE templates) ignores `build_exclude:` — those files DO sync to USE templates.

**`use_exclude:` is the symmetric counterpart — BUILD-only files.** It lists files that are MAINTAINER-only (e.g., `rules/cross-sdk-inspection.md`, `skills/30-claude-code-patterns/sdk-upstream-donation.md`, `guides/co-setup/**`, `guides/deterministic-quality/**`). These describe SDK-maintainer workflows (cross-SDK parity, sibling-SDK awareness, loom→BUILD→USE artifact-flow internals). USE consumers don't author SDK rules and don't run cross-SDK parity. /sync-to-build MUST include every file in `use_exclude:` (they are BUILD-bound). /sync (Gate 2 to USE templates) MUST skip every file in `use_exclude:`.

**`use_obsoleted:` is the active-purge complement of `use_exclude:`.** Where `use_exclude:` says "stop emitting this path to USE templates," `use_obsoleted:` says "AND actively purge any pre-existing copy in the USE target on next sync, AND propagate the purge contract to downstream consumers via `.coc-obsoleted`." /sync-to-build MUST IGNORE `use_obsoleted:` — those paths are BUILD-internal artifacts BUILD repos legitimately own and MUST NOT be purged from BUILD targets. Only the universal `obsoleted:` list applies to /sync-to-build.

### 4. Per-file merge decisions

For each file, compare source against BUILD repo and decide:

**UNCHANGED**: source and BUILD have identical content → skip

**NEW (safe)**: file exists in source but not in BUILD → add it. No risk.

**MODIFIED — shared artifact**: file exists in both, content differs, file IS in loom/ source (global or variant):

- Read BOTH versions before deciding
- If BUILD version is the global/variant content with minor drift → safe to update
- If BUILD version has BUILD-specific adaptations (internal paths, crate references, SDK internals) that the source doesn't have → **flag for human review**. The BUILD may have legitimately diverged.

**BUILD-ONLY**: file exists in BUILD but not in source:

- **Never touch**. These are BUILD-repo artifacts (internal agents, crate docs, binding skills, etc.)
- List them for awareness but take no action.

**NUMBERING CONFLICT**: BUILD has a skill at the same number but different name/topic:

- **STOP**. Do not overwrite. Report the conflict. This requires human decision:
  - Rename the BUILD skill to avoid the conflict?
  - Add the global under a different local path?
  - Skip this skill for now?

### 5. Present merge plan

Group by decision type. For MODIFIED files, show what would change:

```
## Merge Plan: loom/ → kailash-rs/

### Safe updates (shared artifacts, no BUILD-specific content)
- rules/agents.md (+3 -1)
- rules/security.md (unchanged — verify, was already current)
- guides/claude-code/07-the-hook-system.md (+28 -1)
... (N files)

### Flagged for review (BUILD may have diverged)
- skills/02-dataflow/dataflow-express.md
  Source: 48 lines (py variant condensed)
  BUILD:  366 lines (rs-specific expanded content)
  → [K]eep BUILD  [U]pdate from source  [D]iff?

### BUILD-only (preserved, no action)
- agents/rust-architect.md
- agents/bindings/python-binding.md
... (N files)

### Numbering conflicts (requires human decision)
- skills/09-: source=workflow-patterns, BUILD=coc-reference
  → [R]ename BUILD  [S]kip source  [D]iff?

### Hooks (`.claude/hooks/`, always updated — these are CC infrastructure)
- session-start.js (+15 -8)
- user-prompt-rules-reminder.js (+3 -1)

→ Proceed with safe updates? [Y/N]
→ Review flagged files individually? [Y/N]
```

### 6. Apply approved changes

Apply ONLY what the human approved. Hooks under `.claude/hooks/` are always updated (they're CC infrastructure, not content). Before applying, run the obsoleted-paths purge: read `.claude/sync-manifest.yaml::obsoleted` and recursively delete every match in the BUILD repo (per `coc-sync.md` Step 4.5). Also emit `<BUILD>/.claude/.coc-obsoleted` so any consumer that pulls from this BUILD repo via /sync inherits the same purge contract.

### 7. Update VERSION

If `.claude/VERSION` exists, update `upstream.build_version`. If it doesn't exist, create it per the spec in `guides/co-setup/08-versioning.md`.

## Exclusions (never synced)

- `sync-manifest.yaml`, `variants/` — source-only
- `learning/` — per-repo data
- `.proposals/`, `settings.local.json` — per-repo
- `CLAUDE.md` — repo-specific (never overwritten)

## Delegate

Delegate to **coc-sync** agent for overlay computation. The merge decisions and flagging require reading BUILD content — do NOT delegate file writing without the merge review.
