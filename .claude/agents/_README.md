# Agents Directory

26 agents across 7 subdirectories. See `CLAUDE.md` for the full index.

```
agents/
  analysis/         analyst (failure points, requirements, ADRs)
  frameworks/       dataflow, nexus, kaizen, mcp, pact specialists
  frontend/         react-specialist, flutter-specialist, uiux-designer
  implementation/   pattern-expert, tdd-implementer, build-fix
  management/       coc-sync, sync-reviewer, repo-ops, settings-manager, todo-manager, gh-manager
  quality/          reviewer, gold-standards-validator, security-reviewer
  release/          release-specialist
  testing/          testing-specialist
  (root)            cc-architect, open-source-strategist, value-auditor
```

## Consolidations (v1.4.0)

| Old Agent(s)                                              | New Agent            |
| --------------------------------------------------------- | -------------------- |
| deep-analyst + requirements-analyst                       | analyst              |
| intermediate-reviewer + doc-validator                     | reviewer             |
| deployment-specialist + git-release                       | release-specialist   |
| code-inspector + repo-admin                               | repo-ops             |
| frontend-developer (merged into)                          | react-specialist     |
| ai-ux-designer (merged into)                              | uiux-designer        |
| e2e-runner (merged into)                                  | testing-specialist   |
| care/co/coc/eatp-expert, sdk-navigator, framework-advisor | skills/co-reference/ |
