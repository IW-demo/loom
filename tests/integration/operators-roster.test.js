/**
 * Tests for the operators roster schema + `/whoami --register` flow (shard A0b-1).
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — `person_id`/`verified_id`/`display_id`
 *   §2.3 — signing substrate, roster JSON layout, `repo_owner_kind`/
 *           `host_role`/`genesis_generation`
 *   §11   — shard A0b-1 boilerplate-class, ~3 invariants
 *
 * The 3 invariants under test (todos § A0b-1):
 *   1. Roster JSON schema with the documented shape (genesis + persons).
 *   2. `/whoami --register` appends a person_id proposal on a feature
 *      branch (never direct-write to main; branch-protection enforces).
 *   3. `host_role: ci` is a valid value, recorded but never advisory-
 *      eligible (R5-S-04 enforcement is A0b-2c, not this shard).
 *
 * Tier-1 tests (no external infra) use a hand-rolled JSON-Schema-subset
 * validator at .claude/hooks/lib/roster-schema-validate.js — we vendor
 * the validator under .claude/hooks/lib to match sibling-module style
 * and avoid an external dep (rules/dependencies.md "Own the Stack" +
 * rules/python-environment.md doesn't apply — this repo is no-package-
 * manager Node).
 *
 * Tier-2 tests gate on `gh auth status` exit code: if `gh` is not
 * authenticated, they SKIP with explicit reason (rules/testing.md
 * § "test-skip triage"); they NEVER fall back to regex over command
 * output (rules/probe-driven-verification.md MUST-3 — structural probe
 * only).
 *
 * Run: node tests/integration/operators-roster.test.js
 * Exit: 0 = all PASS or SKIP; 1 = at least one FAIL.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  ".claude",
  "operators.roster.schema.json",
);
const TEMPLATE_PATH = path.join(REPO_ROOT, ".claude", "operators.roster.json");
const VALIDATOR_PATH = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "roster-schema-validate.js",
);

// ---- minimal test harness (no external deps, sibling style) ------------------
let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const FAILS = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result === "skip") {
      SKIP += 1;
      console.log(`  SKIP  ${name}`);
      return;
    }
    PASS += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    FAIL += 1;
    FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
    console.log(`  FAIL  ${name}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: ${a} !== ${e}`);
}

// ---- helpers -----------------------------------------------------------------

function loadValidator() {
  if (!fs.existsSync(VALIDATOR_PATH)) {
    throw new Error(
      `validator missing at ${VALIDATOR_PATH} — implement first (shard A0b-1)`,
    );
  }
  // Clear require cache so tests see latest changes.
  delete require.cache[VALIDATOR_PATH];
  return require(VALIDATOR_PATH);
}

function minimalValidRoster() {
  return {
    genesis: {
      repo_owner: "alice",
      repo_owner_kind: "user",
      root_commit: "abc1234567890abc1234567890abc1234567890a",
      genesis_generation: 0,
    },
    persons: {
      "pid-alice-001": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [
          {
            type: "ssh",
            fingerprint: "SHA256:abcdef0123456789",
            pubkey:
              "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample alice@example",
          },
        ],
      },
    },
  };
}

// ===== Tier-1: schema validation =============================================
console.log("\n=== operators-roster — Tier-1 schema validation ===");

test("validator exports a validate() function returning {valid, errors}", () => {
  const v = loadValidator();
  assert(typeof v.validate === "function", "validate() not exported");
  const r = v.validate(minimalValidRoster());
  assert(
    typeof r === "object" && r !== null,
    "validate() did not return object",
  );
  assert(typeof r.valid === "boolean", "result.valid must be boolean");
  assert(Array.isArray(r.errors), "result.errors must be an array");
});

test("roster_schema_accepts_minimal_valid_genesis", () => {
  const v = loadValidator();
  const r = v.validate(minimalValidRoster());
  assert(r.valid, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
});

test("roster_schema_rejects_missing_repo_owner", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  delete roster.genesis.repo_owner;
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid when genesis.repo_owner is missing");
  assert(
    r.errors.some((e) => /repo_owner/.test(e)),
    `expected error mentioning repo_owner; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_missing_root_commit", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  delete roster.genesis.root_commit;
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid when genesis.root_commit is missing");
  assert(
    r.errors.some((e) => /root_commit/.test(e)),
    `expected error mentioning root_commit; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_missing_genesis_generation", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  delete roster.genesis.genesis_generation;
  const r = v.validate(roster);
  assert(
    !r.valid,
    "expected invalid when genesis.genesis_generation is missing",
  );
  assert(
    r.errors.some((e) => /genesis_generation/.test(e)),
    `expected error mentioning genesis_generation; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_repo_owner_kind_outside_enum", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.genesis.repo_owner_kind = "team"; // not in {user, org}
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid for repo_owner_kind outside enum");
  assert(
    r.errors.some((e) => /repo_owner_kind/.test(e)),
    `expected error mentioning repo_owner_kind; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_accepts_owner_with_ssh_key", () => {
  const v = loadValidator();
  const r = v.validate(minimalValidRoster());
  assert(
    r.valid,
    `expected valid SSH-keyed owner; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_accepts_owner_with_gpg_key", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567",
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(
    r.valid,
    `expected valid GPG-keyed owner; got ${JSON.stringify(r.errors)}`,
  );
});

// ---- #372: GPG fingerprint uppercase-40-hex enforcement --------------------

test("roster_schema_rejects_lowercase_gpg_fingerprint", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      // lowercase 40-hex — gpg never emits this; a hand-authored entry that
      // would silently fall to L2_SUPERVISED at resolution (#372).
      fingerprint: "0123456789abcdef0123456789abcdef01234567",
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(!r.valid, "expected lowercase GPG fingerprint to be rejected");
  assert(
    r.errors.some((e) => /GPG fingerprint must be uppercase 40-hex/.test(e)),
    `expected GPG-fingerprint error; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_non_40hex_gpg_fingerprint", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      fingerprint: "0123456789ABCDEF", // 16 hex, not 40
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(!r.valid, "expected non-40-hex GPG fingerprint to be rejected");
  assert(
    r.errors.some((e) => /GPG fingerprint must be uppercase 40-hex/.test(e)),
    `expected GPG-fingerprint error; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_accepts_uppercase_40hex_gpg_fingerprint", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567",
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(
    r.valid,
    `expected uppercase 40-hex GPG fingerprint to be valid; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_gpg_check_does_not_touch_ssh_fingerprints", () => {
  // GPG-only scoping: an SSH key whose fingerprint is NOT uppercase-40-hex
  // (the SHA256:base64 shape contains lowercase + ':' + '/') MUST still be
  // accepted — the #372 assert keys on type==gpg, never the value shape.
  // SSH fingerprints are case-sensitive (operator-id.js _findPersonByFingerprint).
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "ssh",
      fingerprint: "SHA256:abcdef0123456789ABCDEF/+lowerAndUpper", // lowercase present
      pubkey: "ssh-ed25519 AAAAExampleKey alice@example",
    },
  ];
  const r = v.validate(roster);
  assert(
    r.valid,
    `expected SSH fingerprint (any case) to be accepted; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_mixed_case_gpg_fingerprint", () => {
  // Regex-boundary: a mix of upper + lower hex must be rejected (locks the
  // ^[0-9A-F]{40}$ anchor against a future "relax to case-insensitive" edit).
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      fingerprint: "0123456789abcdefABCDEF0123456789ABCDEF01", // 40 hex, mixed case
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(!r.valid, "expected mixed-case GPG fingerprint to be rejected");
  assert(
    r.errors.some((e) => /GPG fingerprint must be uppercase 40-hex/.test(e)),
    `expected GPG-fingerprint error; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_41_hex_gpg_fingerprint", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      fingerprint: "0123456789ABCDEF0123456789ABCDEF012345678", // 41 hex
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(!r.valid, "expected 41-hex GPG fingerprint to be rejected");
  assert(
    r.errors.some((e) => /GPG fingerprint must be uppercase 40-hex/.test(e)),
    `expected GPG-fingerprint error; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_trailing_newline_gpg_fingerprint", () => {
  // JS `$` matches before a trailing \n; assert the 40-hex+\n form is still
  // rejected (it is 41 chars, so {40}$ cannot match) — locks the anchor.
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567\n",
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(!r.valid, "expected trailing-newline GPG fingerprint to be rejected");
  assert(
    r.errors.some((e) => /GPG fingerprint must be uppercase 40-hex/.test(e)),
    `expected GPG-fingerprint error; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_gpg_missing_fingerprint_defers_to_validate_no_duplicate", () => {
  // Contract lock: when a gpg key is missing `fingerprint`, _validate flags
  // the missing-required-property; _validateGpgFingerprints MUST defer (no
  // duplicate / no GPG-specific error on a value that isn't present).
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [
    {
      type: "gpg",
      // fingerprint intentionally absent
      pubkey:
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEY...placeholder...\n-----END PGP PUBLIC KEY BLOCK-----\n",
    },
  ];
  const r = v.validate(roster);
  assert(!r.valid, "expected missing fingerprint to be rejected");
  assert(
    r.errors.some((e) => /missing required property 'fingerprint'/.test(e)),
    `expected _validate missing-property error; got ${JSON.stringify(r.errors)}`,
  );
  assert(
    !r.errors.some((e) => /GPG fingerprint must be uppercase 40-hex/.test(e)),
    `GPG assert must defer to _validate (no duplicate); got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_accepts_host_role_ci", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-ci-bot"] = {
    display_id: "ci-bot",
    role: "contributor",
    github_login: "ci-bot",
    host_role: "ci",
    keys: [
      {
        type: "ssh",
        fingerprint: "SHA256:ciBotKeyFingerprintExample",
        pubkey: "ssh-ed25519 AAAACITestKey ci-bot@runner",
      },
    ],
  };
  const r = v.validate(roster);
  assert(
    r.valid,
    `expected valid host_role:ci; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_host_role_outside_enum", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].host_role = "robot"; // not in {human, ci}
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid host_role outside enum");
  assert(
    r.errors.some((e) => /host_role/.test(e)),
    `expected error mentioning host_role; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_role_outside_enum", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].role = "admin"; // not in {owner, senior, contributor}
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid role outside enum");
  assert(
    r.errors.some((e) => /role/.test(e)),
    `expected error mentioning role; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_unknown_top_level_keys", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.evil_extra = { backdoor: true };
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid for unknown top-level key");
  assert(
    r.errors.some((e) => /evil_extra/.test(e) || /unknown/.test(e)),
    `expected error mentioning unknown key; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_unknown_person_key", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].secret_role = "shadow";
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid for unknown person key");
  assert(
    r.errors.some((e) => /secret_role/.test(e) || /unknown/.test(e)),
    `expected error mentioning unknown person key; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_empty_keys_array", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys = [];
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid for empty keys array");
});

test("roster_schema_rejects_missing_pubkey_in_key_entry", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  delete roster.persons["pid-alice-001"].keys[0].pubkey;
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid for missing pubkey");
  assert(
    r.errors.some((e) => /pubkey/.test(e)),
    `expected error mentioning pubkey; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_rejects_key_type_outside_enum", () => {
  const v = loadValidator();
  const roster = minimalValidRoster();
  roster.persons["pid-alice-001"].keys[0].type = "x509";
  const r = v.validate(roster);
  assert(!r.valid, "expected invalid for key.type outside {ssh,gpg}");
  assert(
    r.errors.some((e) => /type/.test(e)),
    `expected error mentioning key.type; got ${JSON.stringify(r.errors)}`,
  );
});

test("roster_schema_validates_real_template_file", () => {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `template missing at ${TEMPLATE_PATH} — implement template (shard A0b-1)`,
    );
  }
  const v = loadValidator();
  const content = fs.readFileSync(TEMPLATE_PATH, "utf8");
  let roster;
  try {
    roster = JSON.parse(content);
  } catch (err) {
    throw new Error(`template is not valid JSON: ${err.message}`);
  }
  const r = v.validate(roster);
  assert(
    r.valid,
    `template at ${TEMPLATE_PATH} fails its own schema: ${JSON.stringify(r.errors)}`,
  );
});

test("schema_file_is_valid_json_with_documented_shape", () => {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`schema missing at ${SCHEMA_PATH}`);
  }
  const content = fs.readFileSync(SCHEMA_PATH, "utf8");
  let schema;
  try {
    schema = JSON.parse(content);
  } catch (err) {
    throw new Error(`schema is not valid JSON: ${err.message}`);
  }
  assert(schema.$schema, "schema should declare its $schema dialect");
  assert(
    schema.title && /operators/i.test(schema.title),
    "schema should have a title naming operators roster",
  );
  // Sanity check: schema's documented shape mentions the fields the
  // validator enforces. This is a STRUCTURAL probe per
  // probe-driven-verification.md MUST-3 (file-content schema check, not
  // a semantic NLP claim).
  assert(
    schema.properties && schema.properties.genesis && schema.properties.persons,
    "schema must declare top-level genesis and persons properties",
  );
  const g = schema.properties.genesis.properties || {};
  for (const k of [
    "repo_owner",
    "repo_owner_kind",
    "root_commit",
    "genesis_generation",
  ]) {
    assert(g[k], `schema.properties.genesis.properties.${k} missing`);
  }
});

// ===== Tier-2: PR-flow round-trip (gated on `gh auth status`) =================
console.log("\n=== operators-roster — Tier-2 PR-flow (gated on `gh`) ===");

function ghAuthOk() {
  try {
    const r = spawnSync("gh", ["auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

const GH_AVAILABLE = ghAuthOk();

test("whoami_register_writes_branch_not_main", () => {
  if (!GH_AVAILABLE) {
    return "skip"; // probe-driven-verification MUST-3: explicit skip
  }
  // This shard ships the WRITER side (subcommand body). Structural
  // probe: verify the command body documents the branch-via-PR flow
  // and never writes directly to .claude/operators.roster.json on
  // main. The actual gh invocation tests live downstream once A0b-2a
  // provides the enrollment ceremony to seed a real owner key.
  const commandPath = path.join(REPO_ROOT, ".claude", "commands", "whoami.md");
  assert(fs.existsSync(commandPath), `command missing at ${commandPath}`);
  const body = fs.readFileSync(commandPath, "utf8");
  // Structural assertions over the documented contract (not semantic
  // NLP — these are file-content existence checks per
  // probe-driven-verification.md MUST-3).
  assert(
    /codify\/[^\s`]+/.test(body),
    "command body should document the codify/<id>-<date> branch convention",
  );
  assert(
    /gh pr create/.test(body),
    "command body should document the `gh pr create` step",
  );
  assert(
    /branch[- ]protection|PR[- ]only|never write directly to main|never directly/i.test(
      body,
    ),
    "command body should state the branch-protection / PR-only contract",
  );
});

test("whoami_register_proposed_edit_validates_against_schema", () => {
  if (!GH_AVAILABLE) {
    return "skip";
  }
  // Structural probe: simulate the edit the command body would write.
  // We build the proposed roster in-memory, validate it, and confirm
  // it round-trips through JSON.stringify/parse (file-shape round-trip).
  const v = loadValidator();
  const roster = minimalValidRoster();
  // The /whoami --register flow appends a new person entry.
  roster.persons["pid-bob-002"] = {
    display_id: "bob",
    role: "contributor",
    github_login: "bob",
    host_role: "human",
    keys: [
      {
        type: "ssh",
        fingerprint: "SHA256:bobKeyFingerprintExample",
        pubkey: "ssh-ed25519 AAAACIBobExampleKey bob@example",
      },
    ],
  };
  const r = v.validate(roster);
  assert(r.valid, `proposed edit failed schema: ${JSON.stringify(r.errors)}`);
  // Round-trip the file shape — a tempfile-based check.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roster-rt-"));
  const tmpFile = path.join(tmp, "operators.roster.json");
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(roster, null, 2));
    const readBack = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    const r2 = v.validate(readBack);
    assert(
      r2.valid,
      `round-tripped roster failed schema: ${JSON.stringify(r2.errors)}`,
    );
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }
});

// ===== M0 security review regression tests (LOW-4 + LOW-5) ===================
console.log("\n=== M0 security review regression tests ===");

test("roster_schema_rejects_proto_as_person_id_key", () => {
  const v = loadValidator();
  // Build the roster via JSON.parse so `__proto__` becomes an OWN
  // enumerable property (this is the real-world threat surface — a
  // malicious operators.roster.json on disk parses into a persons map
  // with `__proto__` as a key).
  const rosterJson = JSON.stringify(minimalValidRoster()).replace(
    /"persons":\{"pid-alice-001"/,
    '"persons":{"__proto__":{"display_id":"evil","role":"contributor","github_login":"evil","host_role":"human","keys":[{"type":"ssh","fingerprint":"SHA256:abcdef","pubkey":"ssh-ed25519 AAA"}]},"pid-alice-001"',
  );
  const roster = JSON.parse(rosterJson);
  assert(
    Object.keys(roster.persons).includes("__proto__"),
    "fixture invariant: __proto__ must be an own key of persons",
  );
  const r = v.validate(roster);
  assert(
    !r.valid,
    "LOW-5: __proto__ as person_id key MUST be rejected by propertyNames",
  );
  assert(
    r.errors.some((e) => /propertyNames|__proto__|pattern/i.test(e)),
    `expected propertyNames error; got: ${JSON.stringify(r.errors)}`,
  );
});

test("is_unenrolled_predicate_recognizes_placeholder_prefix", () => {
  const v = loadValidator();
  assert(
    typeof v.isUnenrolled === "function",
    "LOW-4: isUnenrolled MUST be exported",
  );
  assert(
    v.isUnenrolled("PLACEHOLDER-owner") === true,
    "PLACEHOLDER- prefix MUST be recognized",
  );
  assert(
    v.isUnenrolled("pid-real-001") === false,
    "non-PLACEHOLDER person_id MUST be false",
  );
  // Defensive on non-string inputs
  assert(v.isUnenrolled(null) === false, "null MUST be false");
  assert(v.isUnenrolled(undefined) === false, "undefined MUST be false");
  assert(v.isUnenrolled(42) === false, "non-string MUST be false");
});

// ---- summary ------------------------------------------------------------------
console.log("\n=== summary ===");
console.log(`  PASS:${PASS}  FAIL:${FAIL}  SKIP:${SKIP}`);
if (FAIL > 0) {
  console.log("\nFailures:");
  for (const f of FAILS) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
