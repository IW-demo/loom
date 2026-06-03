<!-- slot:examples -->

## Examples

### Rule 7 — Agent Delegation Includes Relevant Spec Files

Codex lacks a native specialist-by-name primitive. OpenAI deprecated custom prompts 2026-05-28 (issue #385); repo-local `.codex/prompts/` is no longer loaded by Codex CLI 0.128+ (openai/codex#9848). loom still ships `.codex/prompts/specialist-<name>.md` as on-disk operating-spec content; invoke by inline-cat injection paired with the COC dispatcher OR by natural-language subagent spawn referencing the file path (interactive only).

```
# DO — worker subagent loaded with specialist spec; spec content inlined in task
Delegate to a worker subagent. Operating spec:
"$(cat .codex/prompts/specialist-dataflow.md)"
Task: Build user schema.

From specs/data-model.md:
[content]

From specs/tenant-isolation.md:
[content]

# DO NOT — delegate without specs context
Delegate to a worker subagent. Operating spec:
"$(cat .codex/prompts/specialist-dataflow.md)"
Task: Build user schema.
```

<!-- /slot:examples -->
