<!-- slot:examples -->

## Examples

### Rule 7 — Agent Delegation Includes Relevant Spec Files

```
# DO — include spec content in delegation prompt
@dataflow-specialist
prompt: |
  Build user schema.

  From specs/data-model.md:
  [content]

  From specs/tenant-isolation.md:
  [content]

# DO NOT — delegate without specs context
@dataflow-specialist
prompt: "Build user schema."
```

<!-- /slot:examples -->
