#!/usr/bin/env node
/*
 * Unit test for .claude/bin/emit.mjs::detectBindingTokenViolations (#423 AC#4).
 *
 * Tier 1 (deterministic, no LLM, no network). The rb→rs collapse moved all
 * Ruby-binding examples into the on-demand 28-ruby-bindings skill; the
 * always-on baseline MUST carry ZERO Ruby code fences. This guard is the
 * mechanical regression assertion: a ```ruby / ```rb fence surviving into the
 * abridged baseline emission is a BLOCK. Python is the baseline default
 * example language, so Python/Rust fences MUST NOT flag.
 *
 * Run: node .claude/test-harness/tests/binding-token-guard.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBindingTokenViolations } from "../../bin/emit.mjs";

test("clean baseline (no binding fence) → zero violations", () => {
  const emission = "# Security Rules\n\nAll input MUST be validated.\n\n---\n";
  assert.deepEqual(detectBindingTokenViolations(emission, "codex", "rs"), []);
});

test("ruby fence in baseline → one violation with line + token + cli/lang", () => {
  const emission = "# Rule\n\n```ruby\n# DO\nputs 1\n```\n\n---\n";
  const v = detectBindingTokenViolations(emission, "codex", "rs");
  assert.equal(v.length, 1);
  assert.equal(v[0].token, "ruby");
  assert.equal(v[0].line, 3); // 1-indexed line of the ```ruby fence
  assert.equal(v[0].cli, "codex");
  assert.equal(v[0].lang, "rs");
  assert.match(v[0].message, /28-ruby-bindings skill/);
});

test("rb fence (gemini py) also flags", () => {
  const emission = "# Rule\n\n```rb\nputs 1\n```\n";
  const v = detectBindingTokenViolations(emission, "gemini", "py");
  assert.equal(v.length, 1);
  assert.equal(v[0].token, "rb");
  assert.equal(v[0].cli, "gemini");
  assert.equal(v[0].lang, "py");
});

test("python fence does NOT flag (Python is the baseline default language)", () => {
  const emission = "# Rule\n\n```python\nx = 1\n```\n";
  assert.deepEqual(detectBindingTokenViolations(emission, "codex", "py"), []);
});

test("rust fence does NOT flag (rust is baseline prose; only Ruby is folded)", () => {
  const emission = "# Rule\n\n```rust\nlet x = 1;\n```\n";
  assert.deepEqual(detectBindingTokenViolations(emission, "codex", "rs"), []);
});

test("uppercase ```RUBY flags (case-insensitive — C1-LOW-1)", () => {
  const v = detectBindingTokenViolations("# R\n\n```RUBY\nputs 1\n```\n", "codex", "rs");
  assert.equal(v.length, 1);
});

test("tilde ~~~ruby fence flags (C1-LOW-1)", () => {
  const v = detectBindingTokenViolations("# R\n\n~~~ruby\nputs 1\n~~~\n", "codex", "rs");
  assert.equal(v.length, 1);
});

test("indented ```ruby fence flags (survives abridge as a plain line — C1-LOW-1)", () => {
  const v = detectBindingTokenViolations("# R\n\n  ```ruby\n  puts 1\n  ```\n", "codex", "rs");
  assert.equal(v.length, 1);
});

test("a ```rbenv-like token does NOT false-flag (word boundary after rb)", () => {
  // ```rbs / ```rbenv must not match the rb/ruby fence (\\b after the token).
  const emission = "# Rule\n\n```rbs\ndef f: () -> void\n```\n";
  assert.deepEqual(detectBindingTokenViolations(emission, "codex", "rs"), []);
});

test("lang defaults to null when omitted", () => {
  const v = detectBindingTokenViolations("```ruby\nx\n```\n", "codex");
  assert.equal(v.length, 1);
  assert.equal(v[0].lang, null);
});
