"use strict";
/**
 * F88 — regression lock for the paired-landing hook's F86-touch detector.
 *
 * Pre-F88 the helper-side detector grepped the bare symbol `performMigration`,
 * so EVERY maintenance edit to performMigration (including the F88 seq/prev_hash
 * chain-continuation fix) false-positive-halted when fold-rule-9c.js was absent
 * from the commit. F88 narrowed the trigger to the DISPATCH-CONTRACT surface —
 * the discriminator + org-admin capture shape that genuinely couples the helper
 * to the fold predicate. These probes lock that distinction (journal/0172).
 *
 * Requiring the hook module skips main() (require.main !== module) and exposes
 * the pure detection helpers + symbol sets.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const hook = require(
  path.join(
    REPO_ROOT,
    ".claude",
    "hooks",
    "fold-amendment-paired-with-helper.js",
  ),
);

test("F88: dispatch-contract change in the helper triggers F86 pairing", () => {
  const diff = [
    "@@ -1280,3 +1280,3 @@",
    "     co_signers: [],",
    "+    co_sign_anchor_kind: CO_SIGN_ANCHOR_KIND_ORG_ADMIN,",
    "+    gh_api_org_membership_capture: orgMembershipCapture,",
  ].join("\n");
  assert.equal(hook.anySymbolMatches(diff, hook.HELPER_F86_SYMBOLS), true);
});

test("F88: seq/chain-stamping change in the helper does NOT trigger pairing", () => {
  const diff = [
    "@@ -1315,2 +1315,6 @@",
    "+  const recordSeq = chainHead ? chainHead.lastSeq + 1 : 0;",
    "+  const recordPrevHash = chainHead ? chainHead.lastContentHash : null;",
    "-    seq: 0,",
    "-    prev_hash: null,",
    "+    seq: recordSeq,",
    "+    prev_hash: recordPrevHash,",
    "+  const readChainHead = o.readChainHead || _defaultReadChainHead;",
  ].join("\n");
  assert.equal(hook.anySymbolMatches(diff, hook.HELPER_F86_SYMBOLS), false);
});

test("F88: a bare `performMigration` mention no longer triggers pairing (over-broad trigger removed)", () => {
  const diff = [
    "@@ -813,1 +813,1 @@",
    "-function performMigration(opts) {",
    "+function performMigration(opts /* F88 doc tweak */) {",
  ].join("\n");
  assert.equal(hook.anySymbolMatches(diff, hook.HELPER_F86_SYMBOLS), false);
});

test("F88: fold-side dispatch-contract change still detected (symmetry preserved)", () => {
  const diff = [
    "@@ -226,2 +226,2 @@",
    "+  const isN1OrgAdminPath =",
    "+    c.co_sign_anchor_kind === CO_SIGN_ANCHOR_KIND_ORG_ADMIN;",
  ].join("\n");
  assert.equal(hook.anySymbolMatches(diff, hook.FOLD_F86_SYMBOLS), true);
});

test("F88 R2: a re-anchor-capture-shape change in the helper triggers pairing (reviewer LOW-1)", () => {
  const diff = [
    "@@ -1287,2 +1287,2 @@",
    "-    content.pre_correction_root_commit = preCorrectionRootCommit;",
    "+    content.pre_correction_root_commit = preCorrectionRootCommit;",
    "+    content.gh_api_root_commit_capture = rootCommitCapture;",
  ].join("\n");
  assert.equal(hook.anySymbolMatches(diff, hook.HELPER_F86_SYMBOLS), true);
});

test("F88 R2: a fold-side re-anchor-capture validation change triggers pairing (symmetry)", () => {
  const diff = [
    "@@ -613,2 +613,2 @@",
    "+  const reanchorCapture = c.gh_api_root_commit_capture;",
    "+  if (typeof c.pre_correction_root_commit !== 'string') { ... }",
  ].join("\n");
  assert.equal(hook.anySymbolMatches(diff, hook.FOLD_F86_SYMBOLS), true);
});

test("F88: context-line (unprefixed) symbol mentions are ignored — only +/- count", () => {
  const diff = [
    "@@ -1,3 +1,3 @@",
    "   co_sign_anchor_kind: CO_SIGN_ANCHOR_KIND_ORG_ADMIN,  // context only",
    "+  // a comment with no contract symbol",
  ].join("\n");
  assert.equal(
    hook.diffContainsAddedOrRemovedSymbol(diff, "co_sign_anchor_kind"),
    false,
  );
});
