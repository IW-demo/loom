#!/usr/bin/env node
/*
 * Tier-2 regression test for the hook_delivery lane-declaration contract
 * (#408 AC#6 / journal/0241 / validate-emit `hook-delivery` check). Hooks have
 * no frontmatter and are not emitted (coc-sync copies them), so before this
 * contract a CC hook with no Codex/Gemini equivalent was SILENTLY absent on the
 * non-CC lanes. AC#6 mirrors AC#5-a (Validator 18) for hooks: every
 * .claude/hooks/*.js MUST resolve to exactly ONE declared lane in the
 * sync-manifest `hook_delivery` block (mcp-guard | provenance | cc-only).
 *
 * Two layers (per rules/probe-driven-verification.md MUST-3 — structural):
 *   (1) Unit — parseHookDelivery on synthetic manifest text.
 *   (2) Integration — checkHookDelivery against the LIVE corpus (PASS + every
 *       hook accounted) AND against synthetic temp roots that inject each
 *       failure mode (undeclared/orphan/duplicate/invalid-lane/absent-block) so
 *       the check is proven NON-VACUOUS.
 *
 * Run: node .claude/test-harness/tests/hook-delivery-contract.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

const { parseHookDelivery, checkHookDelivery, deriveMirroredHookSet, STATUS } =
  await import(path.join(REPO, ".claude", "bin", "validate-emit.mjs"));

// ── helpers ──────────────────────────────────────────────────────
function laneCounts(map) {
  const c = { "mcp-guard": 0, provenance: 0, "cc-only": 0, other: 0 };
  for (const [, v] of map) c[v.lane] != null ? c[v.lane]++ : c.other++;
  return c;
}

// Build a synthetic temp root with .claude/hooks/<names>.js + a manifest whose
// hook_delivery declarations are exactly `decls` (array of "<hook>|<lane>|r").
function makeRoot(hookNames, decls, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac6-"));
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const h of hookNames) fs.writeFileSync(path.join(hooksDir, h), "// stub\n");
  const items = decls.map((d) => `      - "${d}"`).join("\n");
  const manifest = `parity_enforcement:\n  hook_delivery:\n    enabled: ${enabled}\n    declarations:\n${items}\n\ntiers:\n  cc: []\n`;
  fs.writeFileSync(path.join(root, ".claude", "sync-manifest.yaml"), manifest);
  return root;
}
function fails(results) {
  return results.filter((r) => r.status === STATUS.FAIL);
}

// ── (1) Unit: parseHookDelivery ──────────────────────────────────
test("parseHookDelivery: parses declarations + lanes", () => {
  const txt = `  hook_delivery:\n    enabled: true\n    declarations:\n      - "a.js|cc-only|reason one"\n      - "b.js|mcp-guard|reason two"\n`;
  const out = parseHookDelivery(txt);
  assert.equal(out.present, true);
  assert.equal(out.enabled, true);
  assert.equal(out.map.get("a.js").lane, "cc-only");
  assert.equal(out.map.get("b.js").lane, "mcp-guard");
  assert.equal(out.map.get("a.js").reason, "reason one");
});

test("parseHookDelivery: detects duplicate declarations", () => {
  const txt = `  hook_delivery:\n    declarations:\n      - "a.js|cc-only|x"\n      - "a.js|mcp-guard|y"\n`;
  const out = parseHookDelivery(txt);
  assert.deepEqual(out.duplicates, ["a.js"]);
  // first-wins on the map
  assert.equal(out.map.get("a.js").lane, "cc-only");
});

test("parseHookDelivery: a col-0 sibling key terminates the block", () => {
  const txt = `  hook_delivery:\n    declarations:\n      - "a.js|cc-only|x"\ntiers:\n  cc: []\n`;
  const out = parseHookDelivery(txt);
  assert.equal(out.map.size, 1);
  assert.ok(out.map.has("a.js"));
});

test("parseHookDelivery: returns null on null input", () => {
  assert.equal(parseHookDelivery(null), null);
});

// ── (2) Integration: LIVE corpus ─────────────────────────────────
test("LIVE: every .claude/hooks/*.js is declared (no silent drop) + check PASSes", () => {
  const { results } = checkHookDelivery(REPO);
  const f = fails(results);
  assert.deepEqual(f, [], `hook-delivery FAILs: ${JSON.stringify(f, null, 2)}`);
  // every disk hook produced a PASS row
  const diskHooks = fs
    .readdirSync(path.join(REPO, ".claude", "hooks"))
    .filter((x) => x.endsWith(".js"));
  const passHooks = results.filter((r) => r.status === STATUS.PASS).length;
  assert.equal(passHooks, diskHooks.length, "every hook accounted with a PASS row");
});

test("LIVE: lane distribution is 5 mcp-guard / 2 provenance / 23 cc-only = 30", () => {
  const block = parseHookDelivery(
    fs.readFileSync(path.join(REPO, ".claude", "sync-manifest.yaml"), "utf8"),
  );
  const c = laneCounts(block.map);
  assert.equal(c.other, 0, "no unknown lanes");
  assert.equal(c["mcp-guard"], 5);
  assert.equal(c.provenance, 2);
  assert.equal(c["cc-only"], 23);
  assert.equal(block.map.size, 30);
});

// ── (2b) Cross-validation against the authoritative fresh extraction ──────
test("LIVE: deriveMirroredHookSet returns exactly the 5 fresh-extraction hooks", () => {
  const mirrored = deriveMirroredHookSet(REPO);
  assert.ok(mirrored, "extractor reachable from the loom checkout");
  assert.deepEqual(
    [...mirrored].sort(),
    [
      "genesis-anchor-guard.js",
      "operator-gate.js",
      "posture-gate.js",
      "signing-mutation-guard.js",
      "validate-bash-command.js",
    ],
  );
});

test("LIVE: every mcp-guard label IS mirrored; every cc-only label is NOT (cross-check holds)", () => {
  const block = parseHookDelivery(
    fs.readFileSync(path.join(REPO, ".claude", "sync-manifest.yaml"), "utf8"),
  );
  const mirrored = deriveMirroredHookSet(REPO);
  for (const [h, d] of block.map) {
    if (d.lane === "mcp-guard") assert.ok(mirrored.has(h), `${h} declared mcp-guard but not mirrored`);
    if (d.lane === "cc-only") assert.ok(!mirrored.has(h), `${h} declared cc-only but IS mirrored`);
  }
});

test("NEGATIVE (non-vacuous cross-check): a mislabeled lane FAILs against the live extraction", () => {
  // Build a temp root with the REAL hooks + codex-mcp-guard + settings (so the
  // canonical extractor runs) but a manifest that deliberately mis-labels a
  // mirrored hook as cc-only. The cross-check must catch it.
  // realpathSync resolves the macOS /tmp → /private/tmp symlink so the canonical
  // extractor's isMain guard (process.argv[1] vs import.meta.url) matches and it
  // actually emits — otherwise deriveMirroredHookSet returns null and the
  // cross-check is (correctly) skipped, which would mask this negative.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac6-xcheck-")));
  const cl = path.join(root, ".claude");
  fs.mkdirSync(cl, { recursive: true });
  for (const d of ["hooks", "codex-mcp-guard"]) {
    fs.cpSync(path.join(REPO, ".claude", d), path.join(cl, d), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO, ".claude", "settings.json"), path.join(cl, "settings.json"));
  // Synthetic manifest: declare EVERY disk hook cc-only — so all 5 mirrored
  // hooks (genesis/operator/posture/signing/validate-bash) are mislabeled, and
  // the cross-check must flag each. We assert on genesis-anchor-guard as the
  // representative.
  const diskHooks = fs.readdirSync(path.join(cl, "hooks")).filter((f) => f.endsWith(".js"));
  const decls = diskHooks.map((h) => `      - "${h}|cc-only|x"`).join("\n");
  const manifest = `parity_enforcement:\n  hook_delivery:\n    enabled: true\n    declarations:\n${decls}\n\ntiers:\n  cc: []\n`;
  fs.writeFileSync(path.join(cl, "sync-manifest.yaml"), manifest);
  const f = fails(checkHookDelivery(root).results);
  // genesis/operator/posture/signing/validate-bash are all mirrored but declared
  // cc-only here → each is a cross-check FAIL.
  assert.ok(
    f.some((r) => /genesis-anchor-guard/.test(r.artifact) && /PRESENT in the fresh/.test(r.detail)),
    "cross-check FLAGS a mirrored hook mislabeled cc-only",
  );
});

// ── (3) Non-vacuous: each failure mode is caught ─────────────────
test("NEGATIVE: an undeclared hook on disk is a silent-drop FAIL", () => {
  const root = makeRoot(["a.js", "rogue.js"], ["a.js|cc-only|declared"]);
  const f = fails(checkHookDelivery(root).results);
  assert.equal(f.length, 1);
  assert.match(f[0].artifact, /rogue\.js/);
  assert.match(f[0].detail, /UNDECLARED|SILENT DROP/);
});

test("NEGATIVE: a declaration with no hook on disk is an orphan FAIL", () => {
  const root = makeRoot(["a.js"], ["a.js|cc-only|ok", "ghost.js|cc-only|orphan"]);
  const f = fails(checkHookDelivery(root).results);
  assert.ok(f.some((r) => /ghost\.js/.test(r.artifact) && /orphan/.test(r.detail)));
});

test("NEGATIVE: a duplicate declaration FAILs", () => {
  const root = makeRoot(["a.js"], ["a.js|cc-only|x", "a.js|mcp-guard|y"]);
  const f = fails(checkHookDelivery(root).results);
  assert.ok(f.some((r) => /a\.js/.test(r.artifact) && /more than once/.test(r.detail)));
});

test("NEGATIVE: an invalid lane FAILs", () => {
  const root = makeRoot(["a.js"], ["a.js|bogus-lane|x"]);
  const f = fails(checkHookDelivery(root).results);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /invalid lane/);
});

test("NEGATIVE: absent hook_delivery block FAILs (everything is a silent drop)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac6-noblk-"));
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "hooks", "a.js"), "//\n");
  fs.writeFileSync(path.join(root, ".claude", "sync-manifest.yaml"), "tiers:\n  cc: []\n");
  const f = fails(checkHookDelivery(root).results);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /hook_delivery block ABSENT/);
});

test("SKIP: absent .claude/hooks dir (consumer emitted tree) skips, never fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac6-nohooks-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const { results } = checkHookDelivery(root);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, STATUS.SKIP);
});

test("SKIP: hook_delivery.enabled:false disables the check (idiom parity)", () => {
  const root = makeRoot(["a.js"], ["a.js|cc-only|x"], false);
  const { results } = checkHookDelivery(root);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, STATUS.SKIP);
  assert.match(results[0].detail, /enabled:false/);
});
