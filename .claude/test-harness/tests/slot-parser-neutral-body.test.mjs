#!/usr/bin/env node
/*
 * Regression test — slot:neutral-body whole-body replacement on a
 * global with zero slot markers (loom issue #290).
 *
 * Defect: `applyOverlay` (.claude/bin/lib/slot-parser.mjs) treated EVERY
 * overlay slot absent from the global as a v6 §3 violation — warn + skip,
 * emit the generic global. A variant authored in the RECOMMENDED slot-only
 * form (`slot:neutral-body`, per variant-authoring.md MUST-1) against a
 * global with NO slot markers (security.md / patterns.md) therefore had its
 * body SILENTLY DROPPED; the generic global shipped to every downstream
 * Rust consumer. The legacy full-file overlay form (emit.mjs:291
 * `composed = overlay`) worked — so the recommended form was the broken one.
 *
 * Root-cause invariant pinned here: `neutral-body` is the slot-only spelling
 * of full-body replacement. When the global has zero slot markers, its whole
 * body IS the implicit neutral-body, so the overlay's neutral-body MUST
 * replace it outright — equivalent to the full-file path. The fix is
 * narrowly scoped: ONLY the canonical `neutral-body` slot AND ONLY when
 * globalSlots.size === 0; every other overlay-slot-not-in-global case still
 * warns (test 2), and the normal slot-replacement path is untouched (test 3).
 *
 * Run: node --test .claude/test-harness/tests/slot-parser-neutral-body.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverlay } from "../../bin/lib/slot-parser.mjs";

// A global rule body with NO slot markers at all (the #290 scope:
// security.md / patterns.md were never slot-partitioned).
const GLOBAL_NO_SLOTS = `# Security Rules

Generic guidance that applies to every language.

- Use parameterized queries.
- Never hardcode secrets.
`;

// The rs variant, authored in the recommended slot-only form.
const VARIANT_NEUTRAL_BODY = `<!-- slot:neutral-body -->
# Security Rules (Rust)

Rust-specific guidance for the rs USE template.

- Use sqlx compile-time-checked queries.
- Secrets via the \`secrecy\` crate, never \`String\`.
<!-- /slot:neutral-body -->
`;

const RS_BODY_CONTENT = `# Security Rules (Rust)

Rust-specific guidance for the rs USE template.

- Use sqlx compile-time-checked queries.
- Secrets via the \`secrecy\` crate, never \`String\`.`;

test("#290: slot:neutral-body replaces a no-marker global outright", () => {
  const { composed, warnings } = applyOverlay(
    GLOBAL_NO_SLOTS,
    VARIANT_NEUTRAL_BODY,
  );
  // The variant body is emitted — NOT the generic global.
  assert.equal(composed, RS_BODY_CONTENT);
  assert.ok(
    !composed.includes("Generic guidance that applies to every language"),
    "generic global must not survive the overlay",
  );
  // The variant was applied, so this is NOT a v6 §3 violation — no warning.
  assert.deepEqual(warnings, []);
  // Slot markers are composition directives, not content — they must not
  // leak into the emitted body.
  assert.ok(!composed.includes("<!-- slot:"), "no slot markers in output");
});

test("#290 fix is narrowly scoped: a non-neutral-body slot absent from a no-marker global still warns", () => {
  const overlayOtherSlot = `<!-- slot:examples -->
some rust examples
<!-- /slot:examples -->
`;
  const { composed, warnings } = applyOverlay(
    GLOBAL_NO_SLOTS,
    overlayOtherSlot,
  );
  // Unchanged behavior: a non-canonical slot not in the global is still a
  // v6 §3 violation — warn + skip, generic global preserved.
  assert.equal(composed, GLOBAL_NO_SLOTS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overlay introduces slot 'examples' not in global/);
});

test("no regression: normal slot-replacement path (global HAS the slot) is untouched", () => {
  const globalWithSlot = `# Rule

intro

<!-- slot:neutral-body -->
ORIGINAL neutral body
<!-- /slot:neutral-body -->

outro
`;
  const overlay = `<!-- slot:neutral-body -->
REPLACED neutral body
<!-- /slot:neutral-body -->
`;
  const { composed, warnings } = applyOverlay(globalWithSlot, overlay);
  assert.ok(composed.includes("REPLACED neutral body"));
  assert.ok(!composed.includes("ORIGINAL neutral body"));
  // Surrounding global content outside the slot is preserved.
  assert.ok(composed.includes("intro"));
  assert.ok(composed.includes("outro"));
  assert.deepEqual(warnings, []);
});

test("equivalence invariant: slot-only form ≡ full-file form for a no-marker global", () => {
  // Full-file overlay path (emit.mjs:291) makes the variant body win.
  // Slot-only form MUST converge to the same effective body content.
  const { composed: slotForm } = applyOverlay(
    GLOBAL_NO_SLOTS,
    VARIANT_NEUTRAL_BODY,
  );
  const fullFileForm = RS_BODY_CONTENT; // what `composed = overlay` yields, frontmatter-stripped
  assert.equal(slotForm, fullFileForm);
});
