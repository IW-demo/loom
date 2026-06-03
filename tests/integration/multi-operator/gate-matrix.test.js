/**
 * Tier-1+2 hybrid tests for shard C2 (workspaces/multi-operator-coc,
 * design v11 §6.4 + §4.3) — the gate-matrix module.
 *
 * Tests at: tests/integration/multi-operator/gate-matrix.test.js
 *
 * Per the shard contract (workspaces/multi-operator-coc/todos/active/
 * 00-todos.md § C2):
 *
 *   (2) gate matrix per §6.4 (the 10-row table) — owner/senior/contributor
 *       rows + degenerate variants for derived-genuine-N=1.
 *
 * This file holds the structural matrix tests (Tier 1) AND the per-row
 * evaluator tests (Tier 1+2 hybrid, since each row consults real predicates
 * from lib/eligibility.js and lib/r9s02-fence.js).
 *
 * Run: node --test tests/integration/multi-operator/gate-matrix.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const GATE_MATRIX = path.join(LIB_DIR, "gate-matrix.js");
const ELIGIBILITY = path.join(LIB_DIR, "eligibility.js");

const {
  GATE_MATRIX_ROWS,
  evaluateGate,
  findRow,
} = require(GATE_MATRIX);
const eligibilityModule = require(ELIGIBILITY);

// ---- structural matrix invariants -------------------------------------------

test("gate_matrix_has_all_section_6_4_rows", () => {
  // §6.4 specifies 11 enumerated gate rows; compaction-checkpoint and
  // generation-rotation share the same §6.4 textual row (both consume
  // r9s02-fence with identical logic) but are split into separate matrix
  // entries because the operator-gate.js trigger detection routes to them
  // via different command surfaces. The structural test asserts the
  // matrix covers all 11 distinct evaluator paths.
  // The 12 distinct evaluator paths correspond to §6.4's enumerated rows
  // (compaction-checkpoint and generation-rotation share the same §6.4
  // textual row but have separate evaluator entries because operator-gate.js
  // routes them via different command surfaces).
  assert.equal(
    GATE_MATRIX_ROWS.length,
    12,
    `§6.4 covers 12 distinct evaluator paths; got ${GATE_MATRIX_ROWS.length}`,
  );
});

test("gate_matrix_every_row_has_required_fields", () => {
  for (const row of GATE_MATRIX_ROWS) {
    assert.equal(typeof row.gate, "string", `gate name missing: ${JSON.stringify(row)}`);
    assert.equal(typeof row.self_approvable, "string", `self_approvable verdict missing on row '${row.gate}'`);
    assert.ok(
      ["yes", "no", "never", "degenerate", "owner-departure-recovery"].includes(row.self_approvable),
      `unknown self_approvable verdict '${row.self_approvable}' on row '${row.gate}'`,
    );
    assert.equal(typeof row.required_signers, "string", `required_signers missing on row '${row.gate}'`);
    assert.equal(typeof row.signing_context, "string", `signing_context missing on row '${row.gate}'`);
  }
});

test("gate_matrix_signing_contexts_match_eligibility_known_contexts", () => {
  // Every row's signing_context MUST be one of the contexts isEligibleSigner
  // recognizes; otherwise the eligibility check would always fail.
  const known = new Set(eligibilityModule.CI_FOREVER_INELIGIBLE_CONTEXTS);
  for (const row of GATE_MATRIX_ROWS) {
    if (row.signing_context === "n/a") continue; // row needs no co-signer
    assert.ok(
      known.has(row.signing_context),
      `row '${row.gate}' signing_context '${row.signing_context}' not recognized by isEligibleSigner`,
    );
  }
});

test("eligibility_predicate_shared_with_b3b_reap_ceremony", () => {
  // The contract-identity assertion: gate-matrix MUST consume the SAME
  // isEligibleSigner function reference that B3b's reap ceremony uses.
  // We assert function-reference identity via direct re-import.
  const gateMatrixModule = require(GATE_MATRIX);
  assert.strictEqual(
    gateMatrixModule._sharedEligibility,
    eligibilityModule.isEligibleSigner,
    "gate-matrix MUST consume lib/eligibility.js::isEligibleSigner — function-reference identity check failed",
  );
});

// ---- per-row evaluator tests (10 rows × at least one scenario each) ---------

function _genuineGenesisFoldedState() {
  return {
    derived_N: 1,
    records: [
      // Genuine genesis: ONE genesis-anchor, NO attestation history.
      { type: "genesis-anchor", verified_id: "vid:owner-genesis-001", seq: 1 },
    ],
  };
}

function _revocationInducedN1FoldedState() {
  return {
    derived_N: 1,
    records: [
      { type: "genesis-anchor", verified_id: "vid:owner-alpha", seq: 1 },
      // Historical attestation = owner-add occurred → N=1 is revocation-induced
      { type: "collaborator-distinctness-attestation", verified_id: "vid:owner-alpha", seq: 2 },
      { type: "collaborator-distinctness-revocation", verified_id: "vid:owner-alpha", seq: 3 },
    ],
  };
}

function _twoOwnerRoster() {
  return {
    persons: {
      "person:owner-alpha": { role: "owner", host_role: "human", gh_login: "alice" },
      "person:owner-bravo": { role: "owner", host_role: "human", gh_login: "bob" },
    },
  };
}

function _twoOwnerFoldedState() {
  return {
    derived_N: 2,
    records: [{ type: "genesis-anchor", verified_id: "vid:owner-alpha", seq: 1 }],
  };
}

test("row_todos_plan_single_operator_workstream_self_approvable", () => {
  const row = findRow("todos-plan-single-operator");
  assert.ok(row, "row 'todos-plan-single-operator' missing");
  const result = evaluateGate({
    gate: "todos-plan-single-operator",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
    touchesAnothersLease: false,
  });
  assert.equal(result.allowed, true, `expected allow, got: ${JSON.stringify(result)}`);
  assert.equal(result.audit_marker, null);
});

test("row_todos_plan_touches_anothers_lease_requires_cosigner", () => {
  const result = evaluateGate({
    gate: "todos-plan-touches-anothers-lease",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" }, // SELF
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
    touchesAnothersLease: true,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /4-eyes|distinct|self/i);
});

test("row_posture_upgrade_rejects_self_approval", () => {
  const result = evaluateGate({
    gate: "posture-upgrade",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /self|distinct|4-eyes/i);
});

test("row_posture_override_requires_distinct_owner_or_senior", () => {
  const result = evaluateGate({
    gate: "posture-override",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-bravo", gh_login: "bob" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "bob" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, true, `expected allow, got: ${JSON.stringify(result)}`);
});

test("row_repo_floor_restore_requires_distinct_owner", () => {
  // Owner-only — senior insufficient.
  const seniorRoster = {
    persons: {
      "person:owner-alpha": { role: "owner", host_role: "human", gh_login: "alice" },
      "person:senior-bravo": { role: "senior", host_role: "human", gh_login: "bob" },
    },
  };
  const result = evaluateGate({
    gate: "repo-floor-restore",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:senior-bravo", gh_login: "bob" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "senior", host_role: "human", gh_login: "bob" },
    roster: seniorRoster,
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /owner|insufficient|role/i);
});

test("row_release_never_self_approvable", () => {
  const result = evaluateGate({
    gate: "release",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /self|distinct|4-eyes/i);
});

test("row_release_degenerate_in_genuine_genesis_N1_allowed_with_marker", () => {
  const oneOwnerRoster = {
    persons: {
      "person:owner-genesis-001": { role: "owner", host_role: "human", gh_login: "alice" },
    },
  };
  const result = evaluateGate({
    gate: "release",
    requester: { person_id: "person:owner-genesis-001", gh_login: "alice" },
    approver: { person_id: "person:owner-genesis-001", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: oneOwnerRoster,
    foldedState: _genuineGenesisFoldedState(),
  });
  assert.equal(result.allowed, true, `expected allow, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.audit_marker && /degenerate|genesis/i.test(result.audit_marker),
    `expected degenerate-genesis audit marker, got: ${JSON.stringify(result.audit_marker)}`,
  );
});

test("row_roster_edit_compaction_checkpoint_under_r9s02_blocked", () => {
  // Revocation-induced N=1 → checkpoint NOT self-signable.
  const oneOwnerRoster = {
    persons: {
      "person:owner-alpha": { role: "owner", host_role: "human", gh_login: "alice" },
    },
  };
  const result = evaluateGate({
    gate: "compaction-checkpoint",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: oneOwnerRoster,
    foldedState: _revocationInducedN1FoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /r9s02|revocation|checkpoint/i);
});

test("row_generation_rotation_under_r9s02_blocked", () => {
  const oneOwnerRoster = {
    persons: {
      "person:owner-alpha": { role: "owner", host_role: "human", gh_login: "alice" },
    },
  };
  const result = evaluateGate({
    gate: "generation-rotation",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: oneOwnerRoster,
    foldedState: _revocationInducedN1FoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /r9s02|revocation|rotation/i);
});

test("row_genesis_migration_no_degenerate_self_sign_R6S04", () => {
  // Even at genuine-genesis N=1, genesis-migration MUST NOT self-sign.
  const oneOwnerRoster = {
    persons: {
      "person:owner-genesis-001": { role: "owner", host_role: "human", gh_login: "alice" },
    },
  };
  const result = evaluateGate({
    gate: "genesis-migration",
    requester: { person_id: "person:owner-genesis-001", gh_login: "alice" },
    approver: { person_id: "person:owner-genesis-001", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: oneOwnerRoster,
    foldedState: _genuineGenesisFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /migration|R6-S-04|degenerate|fresh/i);
});

test("row_owner_departure_removal_only_self_approvable", () => {
  // Settled gh-api-bound revocation drops derived-live-N below attested-N.
  // R7-A-03 recovery: removal-only roster edit self-approvable (audit-marked).
  const oneOwnerRoster = {
    persons: {
      "person:owner-alpha": { role: "owner", host_role: "human", gh_login: "alice" },
    },
  };
  const result = evaluateGate({
    gate: "owner-departure-roster-removal",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: oneOwnerRoster,
    foldedState: _revocationInducedN1FoldedState(),
    rosterEditKind: "removal", // only removal — owner-add MUST NOT take this path
    revocationSettled: true,
  });
  assert.equal(result.allowed, true, `expected allow, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.audit_marker && /owner-departure|removal/i.test(result.audit_marker),
  );
});

test("row_roster_edit_adding_new_contributor_one_owner_approver", () => {
  const result = evaluateGate({
    gate: "roster-edit-add-contributor",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-bravo", gh_login: "bob" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "bob" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, true, `expected allow, got: ${JSON.stringify(result)}`);
});

test("row_new_rule_codify_requires_second_person_id_signed_ack", () => {
  const result = evaluateGate({
    gate: "new-rule-codify",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-alpha", gh_login: "alice" }, // self
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /self|second|distinct|ack/i);
});

// ---- structural cross-cutting invariants ------------------------------------

test("host_role_ci_never_eligible_via_isEligibleSigner", () => {
  // host_role:ci approver MUST be rejected for any signing context.
  const result = evaluateGate({
    gate: "release",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:ci-runner-001", gh_login: "ci-bot" },
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "ci", gh_login: "ci-bot" },
    roster: _twoOwnerRoster(),
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /ci|host_role|R5-S-04/i);
});

test("same_collaborator_login_rejected_on_owner_senior_gates", () => {
  // R5-S-07: even with distinct person_id, same bound GitHub login → reject.
  const result = evaluateGate({
    gate: "posture-upgrade",
    requester: { person_id: "person:owner-alpha", gh_login: "alice" },
    approver: { person_id: "person:owner-bravo", gh_login: "alice" }, // same login
    requesterPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    approverPerson: { role: "owner", host_role: "human", gh_login: "alice" },
    roster: {
      persons: {
        "person:owner-alpha": { role: "owner", host_role: "human", gh_login: "alice" },
        "person:owner-bravo": { role: "owner", host_role: "human", gh_login: "alice" },
      },
    },
    foldedState: _twoOwnerFoldedState(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /collaborator|login|R5-S-07/i);
});
