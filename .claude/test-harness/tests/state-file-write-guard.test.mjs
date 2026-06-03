#!/usr/bin/env node
/*
 * Regression suite for .claude/hooks/lib/state-file-write-guard.js.
 *
 * Per probe-driven-verification.md MUST-3: structural probes (input →
 * expected output) — no LLM judge needed. Tests cover:
 *   - tierClassify: T1/T2/T3/T4 tier matrix + override-first ordering
 *   - emitSignature: deterministic across signature-field round-trip
 *   - verifySignature: constant-time mismatch + missing input
 *   - checkOverride: env-var precedence
 *   - validateHonestYellow: gap enumeration contract
 *
 * Run: node .claude/test-harness/tests/state-file-write-guard.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const libPath = path.join(
  repoRoot,
  ".claude",
  "hooks",
  "lib",
  "state-file-write-guard.js",
);

const require = createRequire(import.meta.url);
const lib = require(libPath);
const {
  TIER,
  tierClassify,
  emitSignature,
  verifySignature,
  checkOverride,
  validateHonestYellow,
} = lib;

// Project-specific config the consumer would supply. Tests use a
// canonical shape: this is what a real consumer's PreToolUse hook
// would pass through to tierClassify.
const cfg = {
  envVarName: "TEST_STATE_GUARD_OVERRIDE",
  verificationStatusField: "verification_status",
  signatureField: "_validator_signature",
  gapListField: "smoke_step_d_actions",
};

const SMOKE = "smoke-report-bytes-v1";
const INTERACTIONS = "interactions-report-bytes-v1";

function buildSignedStateFile(extras = {}) {
  const base = {
    verification_status: "GREEN",
    deploy_id: "abc123",
    ...extras,
  };
  // Compute signature on body-without-signature, then attach.
  const bodyContent = JSON.stringify(base);
  const sig = emitSignature({
    stateFileContent: bodyContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  return JSON.stringify({ ...base, [cfg.signatureField]: sig });
}

// ------------------------------------------------------------------
// emitSignature
// ------------------------------------------------------------------

test("emitSignature is deterministic for identical inputs", () => {
  const state = JSON.stringify({ verification_status: "GREEN", x: 1 });
  const sig1 = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  const sig2 = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  assert.equal(sig1, sig2);
  assert.match(sig1, /^[0-9a-f]{64}$/);
});

test("emitSignature ignores existing signature field (round-trip stable)", () => {
  const base = { verification_status: "GREEN", deploy_id: "abc123" };
  const bodyContent = JSON.stringify(base);
  const sig = emitSignature({
    stateFileContent: bodyContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  // Re-emit signature on the body-WITH-signature; lib must strip the
  // signature field internally and produce the same hash.
  const signedContent = JSON.stringify({
    ...base,
    [cfg.signatureField]: sig,
  });
  const sigRoundTrip = emitSignature({
    stateFileContent: signedContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  assert.equal(sig, sigRoundTrip);
});

test("emitSignature differs when smoke or interactions changes", () => {
  const state = JSON.stringify({ verification_status: "GREEN" });
  const baseSig = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  const altSmoke = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE + "x",
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  const altInter = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS + "x",
    signatureField: cfg.signatureField,
  });
  assert.notEqual(baseSig, altSmoke);
  assert.notEqual(baseSig, altInter);
  assert.notEqual(altSmoke, altInter);
});

test("emitSignature throws on malformed JSON", () => {
  assert.throws(
    () =>
      emitSignature({
        stateFileContent: "{not-json",
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
        signatureField: cfg.signatureField,
      }),
    /must be valid JSON/,
  );
});

test("emitSignature throws on missing required string", () => {
  assert.throws(() =>
    emitSignature({
      stateFileContent: "{}",
      smokeReportContent: "",
      interactionsReportContent: INTERACTIONS,
      signatureField: cfg.signatureField,
    }),
  );
});

// ------------------------------------------------------------------
// verifySignature
// ------------------------------------------------------------------

test("verifySignature returns true on matching signature", () => {
  const state = JSON.stringify({ verification_status: "GREEN" });
  const sig = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  assert.equal(
    verifySignature({
      stateFileContent: state,
      smokeReportContent: SMOKE,
      interactionsReportContent: INTERACTIONS,
      signatureField: cfg.signatureField,
      claimedSignature: sig,
    }),
    true,
  );
});

test("verifySignature returns false on tampered state-file", () => {
  const state = JSON.stringify({ verification_status: "GREEN" });
  const sig = emitSignature({
    stateFileContent: state,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    signatureField: cfg.signatureField,
  });
  const tampered = JSON.stringify({ verification_status: "GREEN", evil: "x" });
  assert.equal(
    verifySignature({
      stateFileContent: tampered,
      smokeReportContent: SMOKE,
      interactionsReportContent: INTERACTIONS,
      signatureField: cfg.signatureField,
      claimedSignature: sig,
    }),
    false,
  );
});

test("verifySignature returns false on missing claimed signature", () => {
  assert.equal(
    verifySignature({
      stateFileContent: "{}",
      smokeReportContent: SMOKE,
      interactionsReportContent: INTERACTIONS,
      signatureField: cfg.signatureField,
      claimedSignature: "",
    }),
    false,
  );
});

// ------------------------------------------------------------------
// checkOverride
// ------------------------------------------------------------------

test("checkOverride respects truthy values", () => {
  const env = "TEST_OVERRIDE_VAR_TRUTHY";
  const orig = process.env[env];
  try {
    process.env[env] = "1";
    assert.equal(checkOverride(env), true);
    process.env[env] = "true";
    assert.equal(checkOverride(env), true);
    process.env[env] = "TRUE";
    assert.equal(checkOverride(env), true);
    process.env[env] = "yes";
    assert.equal(checkOverride(env), true);
  } finally {
    if (orig === undefined) delete process.env[env];
    else process.env[env] = orig;
  }
});

test("checkOverride returns false on unset / empty / falsy values", () => {
  const env = "TEST_OVERRIDE_VAR_FALSY";
  const orig = process.env[env];
  try {
    delete process.env[env];
    assert.equal(checkOverride(env), false);
    process.env[env] = "";
    assert.equal(checkOverride(env), false);
    process.env[env] = "0";
    assert.equal(checkOverride(env), false);
    process.env[env] = "false";
    assert.equal(checkOverride(env), false);
    process.env[env] = "no";
    assert.equal(checkOverride(env), false);
  } finally {
    if (orig === undefined) delete process.env[env];
    else process.env[env] = orig;
  }
});

// ------------------------------------------------------------------
// validateHonestYellow
// ------------------------------------------------------------------

test("validateHonestYellow accepts gap list referencing every gap id", () => {
  const result = validateHonestYellow({
    stateFile: {
      smoke_step_d_actions: [
        "panel-revenue-overview degraded; tracked in #99",
        "panel-cohort-summary partial; tracked in #100",
      ],
    },
    gapListField: cfg.gapListField,
    contractScanResult: {
      gaps: ["panel-revenue-overview", "panel-cohort-summary"],
    },
  });
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
});

test("validateHonestYellow rejects missing gap id in entries", () => {
  const result = validateHonestYellow({
    stateFile: {
      smoke_step_d_actions: ["panel-revenue-overview tracked in #99"],
    },
    gapListField: cfg.gapListField,
    contractScanResult: {
      gaps: ["panel-revenue-overview", "panel-cohort-summary"],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /panel-cohort-summary/);
});

test("validateHonestYellow rejects empty gap list", () => {
  const result = validateHonestYellow({
    stateFile: { smoke_step_d_actions: [] },
    gapListField: cfg.gapListField,
    contractScanResult: { gaps: ["g1"] },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing, not an array, or empty/);
});

// ------------------------------------------------------------------
// tierClassify — full tier matrix
// ------------------------------------------------------------------

test("tierClassify T1 — verified GREEN with valid signature + clean scan", () => {
  const stateFileContent = buildSignedStateFile();
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T1);
  assert.match(verdict.diagnostic, /T1 ALLOW/);
});

test("tierClassify T2 — honest YELLOW with enumerated gaps", () => {
  const stateFileContent = JSON.stringify({
    verification_status: "YELLOW",
    smoke_step_d_actions: [
      "panel-revenue-overview degraded; tracked in #99",
      "panel-cohort-summary partial; tracked in #100",
    ],
  });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: {
      passed: false,
      prohibitedStubsFound: [],
      gaps: ["panel-revenue-overview", "panel-cohort-summary"],
    },
  });
  assert.equal(verdict.tier, TIER.T2);
  assert.match(verdict.diagnostic, /T2 ALLOW/);
});

test("tierClassify T3 — YELLOW without enumerated gaps", () => {
  const stateFileContent = JSON.stringify({
    verification_status: "YELLOW",
    smoke_step_d_actions: ["something is degraded"],
  });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: {
      passed: false,
      prohibitedStubsFound: [],
      gaps: ["panel-revenue-overview"],
    },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /T3 BLOCK/);
});

test("tierClassify T3 — GREEN with missing signature", () => {
  const stateFileContent = JSON.stringify({
    verification_status: "GREEN",
    deploy_id: "abc",
  });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /missing _validator_signature/);
});

test("tierClassify T3 — GREEN with forged signature", () => {
  const stateFileContent = JSON.stringify({
    verification_status: "GREEN",
    [cfg.signatureField]: "deadbeef".repeat(8),
  });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /does not match sha256/);
});

test("tierClassify T3 — GREEN with valid signature but failed contract scan", () => {
  const stateFileContent = buildSignedStateFile();
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: {
      passed: false,
      prohibitedStubsFound: ["Click Generate Overview"],
      gaps: ["panel-revenue-overview"],
    },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /contract scan failed/);
});

test("tierClassify T4 — caller-determined hook bypass attempt", () => {
  const verdict = tierClassify({
    ...cfg,
    shouldT4Block: true,
    stateFileContent: "{}",
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
  });
  assert.equal(verdict.tier, TIER.T4);
  assert.match(verdict.diagnostic, /T4 BLOCK/);
});

test("tierClassify OVERRIDE — env-var checked FIRST, before T4 / T3", () => {
  const env = cfg.envVarName;
  const orig = process.env[env];
  try {
    process.env[env] = "1";
    // Even with shouldT4Block=true AND missing signature, OVERRIDE wins.
    const verdict = tierClassify({
      ...cfg,
      shouldT4Block: true,
      stateFileContent: '{"verification_status":"GREEN"}',
      smokeReportContent: SMOKE,
      interactionsReportContent: INTERACTIONS,
    });
    assert.equal(verdict.tier, TIER.OVERRIDE);
  } finally {
    if (orig === undefined) delete process.env[env];
    else process.env[env] = orig;
  }
});

test("tierClassify T3 — non-GREEN non-YELLOW status", () => {
  const stateFileContent = JSON.stringify({ verification_status: "RED" });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T3);
});

test("tierClassify T3 — malformed JSON state-file", () => {
  const verdict = tierClassify({
    ...cfg,
    stateFileContent: "{not-json",
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /not valid JSON/);
});

test("tierClassify rejects null state-file content (route to mutation helper)", () => {
  assert.throws(
    () =>
      tierClassify({
        ...cfg,
        stateFileContent: null,
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
      }),
    /detectStateFileMutation/,
  );
});

test("tierClassify requires envVarName + field-name config", () => {
  assert.throws(
    () =>
      tierClassify({
        envVarName: "",
        verificationStatusField: cfg.verificationStatusField,
        signatureField: cfg.signatureField,
        gapListField: cfg.gapListField,
        stateFileContent: "{}",
      }),
    /envVarName is required/,
  );
});

// ------------------------------------------------------------------
// Round-2 redteam fixes — added 2026-05-10
// ------------------------------------------------------------------

// MED-1 (reviewer) — OVERRIDE precedence beyond just T4

test("tierClassify OVERRIDE beats T3 from malformed JSON", () => {
  const env = cfg.envVarName;
  const orig = process.env[env];
  try {
    process.env[env] = "1";
    const verdict = tierClassify({
      ...cfg,
      stateFileContent: "{not-json",
      smokeReportContent: SMOKE,
      interactionsReportContent: INTERACTIONS,
    });
    assert.equal(verdict.tier, TIER.OVERRIDE);
  } finally {
    if (orig === undefined) delete process.env[env];
    else process.env[env] = orig;
  }
});

test("tierClassify OVERRIDE beats T3 from forged signature", () => {
  const env = cfg.envVarName;
  const orig = process.env[env];
  try {
    process.env[env] = "1";
    const stateFileContent = JSON.stringify({
      verification_status: "GREEN",
      [cfg.signatureField]: "deadbeef".repeat(8),
    });
    const verdict = tierClassify({
      ...cfg,
      stateFileContent,
      smokeReportContent: SMOKE,
      interactionsReportContent: INTERACTIONS,
      contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
    });
    assert.equal(verdict.tier, TIER.OVERRIDE);
  } finally {
    if (orig === undefined) delete process.env[env];
    else process.env[env] = orig;
  }
});

// MED-S1 (security) — signatureField allowlist + reserved-name reject

test("tierClassify rejects signatureField named __proto__", () => {
  assert.throws(
    () =>
      tierClassify({
        ...cfg,
        signatureField: "__proto__",
        stateFileContent: "{}",
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
      }),
    /reserved name/,
  );
});

test("tierClassify rejects signatureField named constructor", () => {
  assert.throws(
    () =>
      tierClassify({
        ...cfg,
        signatureField: "constructor",
        stateFileContent: "{}",
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
      }),
    /reserved name/,
  );
});

test("tierClassify rejects signatureField with non-identifier characters", () => {
  assert.throws(
    () =>
      tierClassify({
        ...cfg,
        signatureField: "foo.bar",
        stateFileContent: "{}",
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
      }),
    /must match/,
  );
});

test("emitSignature rejects signatureField named prototype", () => {
  assert.throws(
    () =>
      emitSignature({
        stateFileContent: "{}",
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
        signatureField: "prototype",
      }),
    /reserved name/,
  );
});

// MED-S2 (security) — bipartite gap-list assignment

test("validateHonestYellow requires distinct entry per gap (no single-entry-multi-gap)", () => {
  // One entry naming all three gaps — pre-fix this passed; post-fix it must NOT.
  const result = validateHonestYellow({
    stateFile: {
      smoke_step_d_actions: [
        "panel-revenue-overview panel-cohort-summary panel-billing-page degraded",
      ],
    },
    gapListField: cfg.gapListField,
    contractScanResult: {
      gaps: [
        "panel-revenue-overview",
        "panel-cohort-summary",
        "panel-billing-page",
      ],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /distinct entry/);
});

test("validateHonestYellow handles substring-collision via length-sorted matching", () => {
  // Gap "panel-revenue" is a substring of "panel-revenue-overview". Without
  // length-sorted matching, a single entry "panel-revenue-overview tracked"
  // could be consumed by the shorter id ("panel-revenue"), leaving the
  // longer id with no eligible entry. Length-sorted matching consumes the
  // entry for the longer id first, so the shorter id needs its own entry.
  const result = validateHonestYellow({
    stateFile: {
      smoke_step_d_actions: [
        "panel-revenue-overview tracked",
        "panel-revenue tracked",
      ],
    },
    gapListField: cfg.gapListField,
    contractScanResult: {
      gaps: ["panel-revenue", "panel-revenue-overview"],
    },
  });
  assert.equal(result.valid, true);
});

test("validateHonestYellow rejects substring-collision with single entry", () => {
  // Only ONE entry contains both substrings; consumed by the longer id;
  // shorter id has nothing left.
  const result = validateHonestYellow({
    stateFile: {
      smoke_step_d_actions: ["panel-revenue-overview tracked"],
    },
    gapListField: cfg.gapListField,
    contractScanResult: {
      gaps: ["panel-revenue", "panel-revenue-overview"],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /panel-revenue/);
});

// LOW-S1 (security) — state-file length cap

test("tierClassify T3 — state-file exceeds default maxBytes", () => {
  // 2 MiB of valid JSON — over the 1 MiB default cap.
  const huge = JSON.stringify({
    verification_status: "GREEN",
    payload: "x".repeat(2 * 1024 * 1024),
  });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent: huge,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /exceeds maxBytes/);
});

test("tierClassify T3 — caller-supplied maxBytes override applies", () => {
  const small = JSON.stringify({ verification_status: "GREEN", x: "y" });
  const verdict = tierClassify({
    ...cfg,
    stateFileContent: small,
    smokeReportContent: SMOKE,
    interactionsReportContent: INTERACTIONS,
    maxBytes: 10, // way below content size
    contractScanResult: { passed: true, prohibitedStubsFound: [], gaps: [] },
  });
  assert.equal(verdict.tier, TIER.T3);
  assert.match(verdict.diagnostic, /exceeds maxBytes/);
});

// Round-3 redteam — emitSignature maxBytes parity (same DoS class on SIGN path)

test("emitSignature throws RangeError when content exceeds default maxBytes", () => {
  const huge = JSON.stringify({
    verification_status: "GREEN",
    payload: "x".repeat(2 * 1024 * 1024),
  });
  assert.throws(
    () =>
      emitSignature({
        stateFileContent: huge,
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
        signatureField: cfg.signatureField,
      }),
    /exceeds maxBytes/,
  );
});

test("emitSignature respects caller-supplied maxBytes override", () => {
  const small = JSON.stringify({ verification_status: "GREEN", x: "y" });
  assert.throws(
    () =>
      emitSignature({
        stateFileContent: small,
        smokeReportContent: SMOKE,
        interactionsReportContent: INTERACTIONS,
        signatureField: cfg.signatureField,
        maxBytes: 10,
      }),
    /exceeds maxBytes/,
  );
});
