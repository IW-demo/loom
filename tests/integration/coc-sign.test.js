/**
 * Tier-2 integration tests for .claude/hooks/lib/coc-sign.js (shard A0a).
 *
 * Per rules/testing.md 3-Tier: NO mocking. Real ssh-keygen / gpg via
 * ephemeral keys generated under mktemp -d, cleaned up after each suite.
 *
 * The 4 invariants under test (workspaces/multi-operator-coc/todos/A0a):
 *   1. canonicalSerialize — deterministic; rejects NaN/Infinity/BOMs/non-printable
 *   2. sign — via SSH key (default) OR GPG; never silent-fallback unsigned
 *   3. verify — against a named public key (caller-supplied)
 *   4. refuse to sign if no key configured — explicit error object
 *
 * Run: node tests/integration/coc-sign.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js");

// ---- minimal test harness (no external deps) ----------------------------------
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
function assertThrows(fn, matcher, msg) {
  try {
    fn();
  } catch (e) {
    if (matcher && !matcher.test(e.message || String(e))) {
      throw new Error(
        `${msg || "wrong error"}: expected match ${matcher}, got '${e.message}'`,
      );
    }
    return;
  }
  throw new Error(`${msg || "did not throw"}`);
}

// ---- ephemeral key fixtures ---------------------------------------------------
function mkEphemeralSshKey() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-ssh-"));
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", [
    "-t",
    "ed25519",
    "-N",
    "",
    "-q",
    "-f",
    keyPath,
    "-C",
    "coc-sign-test",
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  return { dir, keyPath, pubKey: pub };
}
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // intentional cleanup-best-effort; rules/zero-tolerance.md Rule 3 exception
  }
}
function gpgAvailable() {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---- load the library ---------------------------------------------------------
if (!fs.existsSync(LIB)) {
  console.error(`coc-sign.js not found at ${LIB}`);
  process.exit(1);
}
const sign = require(LIB);

// ============================================================================
// canonicalSerialize tests (invariant 1)
// ============================================================================

console.log("=== canonicalSerialize ===");

test("canonical_serialize_sorts_keys", () => {
  const a = sign.canonicalSerialize({ b: 1, a: 2, c: { y: 3, x: 4 } });
  const b = sign.canonicalSerialize({ c: { x: 4, y: 3 }, a: 2, b: 1 });
  assert(Buffer.isBuffer(a), "output must be Buffer");
  assert(
    a.equals(b),
    `not key-order-invariant: ${a.toString()} vs ${b.toString()}`,
  );
  assertEqual(a.toString("utf8"), '{"a":2,"b":1,"c":{"x":4,"y":3}}');
});

test("canonical_serialize_rejects_nan", () => {
  assertThrows(
    () => sign.canonicalSerialize({ x: NaN }),
    /NaN|non-finite|not finite/i,
    "must reject NaN",
  );
});

test("canonical_serialize_rejects_infinity", () => {
  assertThrows(
    () => sign.canonicalSerialize({ x: Infinity }),
    /Infinity|non-finite|not finite/i,
    "must reject +Infinity",
  );
  assertThrows(
    () => sign.canonicalSerialize({ x: -Infinity }),
    /Infinity|non-finite|not finite/i,
    "must reject -Infinity",
  );
});

test("canonical_serialize_rejects_undefined_value", () => {
  // undefined keys/values silently disappear under JSON.stringify; we reject.
  assertThrows(
    () => sign.canonicalSerialize({ x: undefined }),
    /undefined/i,
    "must reject undefined property values",
  );
});

test("canonical_serialize_rejects_bom_in_strings", () => {
  // BOM = U+FEFF; rejecting it prevents canonical-form drift across editors.
  assertThrows(
    () => sign.canonicalSerialize({ x: "hello﻿world" }),
    /BOM|non-printable|U\+FEFF/i,
    "must reject BOM in string values",
  );
});

test("canonical_serialize_rejects_non_printable_control_chars", () => {
  // raw control chars (e.g. \x00, \x07) are non-printable; reject.
  assertThrows(
    () => sign.canonicalSerialize({ x: "ok\x00bad" }),
    /non-printable|control/i,
    "must reject NUL byte in string values",
  );
});

test("canonical_serialize_deterministic_across_runs", () => {
  // Determinism is the core invariant: same input → byte-identical output.
  const payload = {
    operator: "alice",
    seq: 42,
    nested: { tags: ["x", "y"], roles: { owner: true, ci: false } },
    ts: "2026-05-20T00:00:00Z",
  };
  const a = sign.canonicalSerialize(payload);
  const b = sign.canonicalSerialize(payload);
  assert(a.equals(b), "non-deterministic output across two runs");
});

test("canonical_serialize_handles_arrays_unordered_preserved", () => {
  // Arrays preserve order (semantic ordering); only object keys are sorted.
  const out = sign.canonicalSerialize({ x: [3, 1, 2] });
  assertEqual(out.toString("utf8"), '{"x":[3,1,2]}');
});

test("canonical_serialize_handles_safe_primitives", () => {
  // bool, number (finite), null, string (printable) all pass through.
  const out = sign.canonicalSerialize({
    a: true,
    b: false,
    c: null,
    d: 0,
    e: -1.5,
    f: "ok",
  });
  assertEqual(
    out.toString("utf8"),
    '{"a":true,"b":false,"c":null,"d":0,"e":-1.5,"f":"ok"}',
  );
});

test("canonical_serialize_utf8_output", () => {
  // Spec: output is bytes (UTF-8).
  const out = sign.canonicalSerialize({ greet: "héllo" });
  assert(Buffer.isBuffer(out));
  // Round-trip through utf-8 must match.
  assertEqual(JSON.parse(out.toString("utf8")), { greet: "héllo" });
});

// ============================================================================
// sign / verify SSH (invariants 2, 3)
// ============================================================================

console.log("=== sign / verify (SSH ed25519) ===");

let sshFx = null;
try {
  sshFx = mkEphemeralSshKey();
} catch (err) {
  console.log(`  SETUP-SKIP  ssh-keygen unavailable: ${err.message}`);
}

test("sign_ssh_returns_signature", () => {
  if (!sshFx) return "skip";
  const content = sign.canonicalSerialize({ msg: "hello", seq: 1 });
  const r = sign.sign(content, { keyType: "ssh", keyPath: sshFx.keyPath });
  assert(r && r.ok === true, `expected ok:true, got ${JSON.stringify(r)}`);
  assert(
    typeof r.sig === "string" && r.sig.length > 0,
    "sig must be non-empty string",
  );
  assert(r.sig.includes("SSH SIGNATURE"), "ssh signature armor missing");
});

test("verify_accepts_valid_signature", () => {
  if (!sshFx) return "skip";
  const content = sign.canonicalSerialize({ msg: "hello", seq: 1 });
  const signed = sign.sign(content, { keyType: "ssh", keyPath: sshFx.keyPath });
  assert(signed.ok, "sign failed");
  const v = sign.verify(content, signed.sig, sshFx.pubKey, { keyType: "ssh" });
  assert(
    v.ok && v.valid === true,
    `expected ok+valid:true, got ${JSON.stringify(v)}`,
  );
});

test("verify_rejects_tampered_content", () => {
  if (!sshFx) return "skip";
  const content = sign.canonicalSerialize({ msg: "hello", seq: 1 });
  const signed = sign.sign(content, { keyType: "ssh", keyPath: sshFx.keyPath });
  const tampered = sign.canonicalSerialize({ msg: "evil", seq: 1 });
  const v = sign.verify(tampered, signed.sig, sshFx.pubKey, { keyType: "ssh" });
  assert(v.ok, "verify should return ok:true with valid:false on bad sig");
  assert(
    v.valid === false,
    `expected valid:false on tamper, got ${JSON.stringify(v)}`,
  );
});

test("verify_rejects_wrong_pubkey", () => {
  if (!sshFx) return "skip";
  const content = sign.canonicalSerialize({ msg: "hello", seq: 1 });
  const signed = sign.sign(content, { keyType: "ssh", keyPath: sshFx.keyPath });
  // Make a SECOND ephemeral key and try to verify with its pubkey.
  const otherFx = mkEphemeralSshKey();
  try {
    const v = sign.verify(content, signed.sig, otherFx.pubKey, {
      keyType: "ssh",
    });
    assert(v.ok, "verify should not throw on wrong pubkey, return valid:false");
    assert(
      v.valid === false,
      `expected valid:false on wrong pubkey, got ${JSON.stringify(v)}`,
    );
  } finally {
    cleanup(otherFx.dir);
  }
});

// ============================================================================
// no-key-configured (invariant 4 — no silent fallback)
// ============================================================================

console.log("=== no signing key configured (invariant 4) ===");

test("sign_ssh_refuses_without_key", () => {
  // Honor invariant 4: explicit error object, never throw, never silent-unsigned.
  const content = sign.canonicalSerialize({ msg: "x" });
  const r = sign.sign(content, {
    keyType: "ssh",
    keyPath: "/nonexistent/path/id_ed25519",
  });
  assert(r && r.ok === false, `expected ok:false, got ${JSON.stringify(r)}`);
  assert(
    typeof r.error === "string" && r.error.length > 0,
    "error field required",
  );
  assert(
    r.error === "no signing key",
    `error must be 'no signing key', got '${r.error}'`,
  );
  assert(
    typeof r.reason === "string" && r.reason.length > 0,
    "reason field required",
  );
});

test("sign_explicit_error_no_silent_fallback", () => {
  // Stress the no-silent-fallback invariant: even with empty opts, must error.
  const content = sign.canonicalSerialize({ msg: "x" });
  const r = sign.sign(content, { keyType: "ssh", keyPath: "" });
  assert(
    r && r.ok === false,
    `expected ok:false on empty keyPath, got ${JSON.stringify(r)}`,
  );
  assert(r.sig === undefined || r.sig === null, "MUST NOT return sig on error");
});

test("sign_unknown_keyType_returns_error", () => {
  const content = sign.canonicalSerialize({ msg: "x" });
  const r = sign.sign(content, {
    keyType: "rsa-pkcs8",
    keyPath: "/tmp/whatever",
  });
  assert(
    r && r.ok === false,
    "unknown keyType must surface as error, not throw",
  );
  assert(
    /keyType|unsupported|unknown/i.test(r.reason || ""),
    "reason must explain",
  );
});

// ============================================================================
// sign / verify GPG (invariant 2 — second key type)
// ============================================================================

console.log("=== sign / verify (GPG, if available) ===");

test("sign_gpg_returns_signature_if_gpg_available", () => {
  if (!gpgAvailable()) return "skip";
  // Build an ephemeral GPG home and a test key.
  const gpgHome = fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-gpg-"));
  try {
    const batch = path.join(gpgHome, "batch");
    fs.writeFileSync(
      batch,
      [
        "%no-protection",
        "Key-Type: EDDSA",
        "Key-Curve: ed25519",
        "Name-Real: coc-sign test",
        "Name-Email: cocsign@example.invalid",
        "Expire-Date: 0",
        "%commit",
      ].join("\n"),
    );
    execFileSync("gpg", ["--homedir", gpgHome, "--batch", "--gen-key", batch], {
      stdio: "ignore",
    });
    const content = sign.canonicalSerialize({ msg: "gpg-hello" });
    const r = sign.sign(content, {
      keyType: "gpg",
      keyPath: "cocsign@example.invalid",
      gpgHome,
    });
    assert(r && r.ok === true, `expected ok:true, got ${JSON.stringify(r)}`);
    assert(
      typeof r.sig === "string" && r.sig.length > 0,
      "GPG sig must be non-empty",
    );
  } finally {
    // gpg-agent leaves background sockets; rmSync handles them best-effort.
    try {
      execFileSync("gpgconf", ["--homedir", gpgHome, "--kill", "all"], {
        stdio: "ignore",
      });
    } catch {
      // best-effort: gpgconf may be absent; the rmSync below still proceeds.
    }
    cleanup(gpgHome);
  }
});

// ---- summary + cleanup --------------------------------------------------------
if (sshFx) cleanup(sshFx.dir);

console.log("");
console.log(`=== Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ===`);
for (const f of FAILS) console.log(`  - ${f}`);
process.exit(FAIL === 0 ? 0 : 1);
