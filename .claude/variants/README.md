# Variant Overlays

This directory contains language-specific artifact overrides and additions.

## Structure

```
variants/
  py/           Python SDK (kailash-py) specific
    agents/     Agent replacements and additions
    commands/   Command replacements
    rules/      Rule replacements
    skills/     Skill replacements and additions
    scripts/    Script replacements and additions
  rs/           Rust SDK (kailash-rs) specific
    (same structure)
```

## How Variants Work

During `/sync`, each file in the target is resolved as:

1. If a **variant replacement** exists → variant file is used (replaces global)
2. If a **variant-only** file exists → added to target (no global equivalent)
3. Otherwise → global file is used as-is

All variant mappings are declared in `sync-manifest.yaml`.

## When to Add a Variant

A file needs a variant when the same concept requires different content due to the implementation language:

- Code examples (Python vs Rust/Ruby syntax)
- Framework-specific patterns (Python DataFlow enterprise vs Rust equivalents)
- SDK-specific rules (Python async patterns vs Rust concurrency)

A file should stay **global** when the concept is language-agnostic:

- Methodology (CO principles, COC phases)
- Process rules (git workflow, zero-tolerance)
- Design principles (UI/UX, architecture decisions)

## Adding a New Variant

1. Create the file in `variants/{lang}/{type}/{file}.md`
2. Add the mapping to `sync-manifest.yaml`:
   - If replacing a global file → add to `variants:` section
   - If a new file with no global equivalent → add to `variant_only.{lang}:` section
3. Run `/sync {lang}` to distribute
