/**
 * Tier-2 integration tests for shard A2b (workspaces/multi-operator-coc,
 * design v11 §3 transport — filesystem variant).
 *
 * Per rules/testing.md 3-Tier: real fs operations, real ssh-keygen, real
 * canonicalSerialize + real coc-sign verify. NO subprocess-mocking of
 * coc-sign. Multi-process atomicity exercised via real child_process.spawn.
 *
 * Two invariants per the shard contract (workspaces/multi-operator-coc/
 * todos/active/00-todos.md § A2b):
 *   (1) state-io.js extension reads/writes the log via abstract Transport
 *       interface (resolveLogPath helper exported).
 *   (2) filesystem transport implements the four Transport methods —
 *       readAllRecords, appendRecord (O_APPEND-atomic with 2KB ceiling),
 *       headHash, peerHighWaterFor.
 *
 * Plus end-to-end integration with the A2a fold engine: signed
 * genesis-anchor + heartbeat written via this transport flow through
 * foldLog and the trust-root settles.
 *
 * Run: node tests/integration/transport-filesystem.test.js
 * Exit: 0 = all passed; 1 = at least one failed.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const TRANSPORT = path.join(LIB_DIR, "transport-filesystem.js");
const STATE_IO = path.join(LIB_DIR, "state-io.js");
const ENGINE = path.join(LIB_DIR, "coordination-log.js");
const COC_SIGN = path.join(LIB_DIR, "coc-sign.js");

// ---- minimal async test harness ---------------------------------------------
let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const FAILS = [];
const QUEUE = [];

function test(name, fn) {
  QUEUE.push({ name, fn });
}

async function run() {
  for (const { name, fn } of QUEUE) {
    try {
      const r = await fn();
      if (r === "skip") {
        SKIP += 1;
        console.log(`  SKIP  ${name}`);
        continue;
      }
      PASS += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      FAIL += 1;
      FAILS.push(`${name} :: ${err && err.message ? err.message : err}`);
      console.log(`  FAIL  ${name}`);
    }
  }
  console.log(`\n${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
  if (FAIL > 0) {
    console.log("\nFailures:");
    for (const f of FAILS) console.log("  - " + f);
    process.exit(1);
  }
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: ${a} !== ${e}`);
}

// ---- ephemeral key + temp-dir fixtures --------------------------------------
function mkEphemeralSshKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coc-tf-${label}-`));
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
    `coc-tf-test-${label}`,
  ]);
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fpOut = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], {
    encoding: "utf8",
  });
  const m = fpOut.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (!m) throw new Error("could not extract fingerprint");
  return { dir, keyPath, pubKey: pub, fingerprint: m[0] };
}

function mkTempRepoDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coc-tf-repo-${label}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---- record helpers ---------------------------------------------------------
function signRecord(core, keyPath) {
  const { canonicalSerialize, sign } = require(COC_SIGN);
  const bytes = canonicalSerialize(core);
  const r = sign(bytes, { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`sign failed: ${r.error}`);
  return { ...core, sig: r.sig };
}

// ============================================================================
// Suite 1 — module shape + state-io extension (invariant 1)
// ============================================================================
console.log("\n--- transport-filesystem module shape + state-io extension ---");

test("transport_filesystem_exports_factory_function", () => {
  const mod = require(TRANSPORT);
  assert(
    typeof mod.createFilesystemTransport === "function",
    "createFilesystemTransport must be exported as a function",
  );
});

test("transport_filesystem_factory_returns_four_method_contract", () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const repoDir = mkTempRepoDir("contract");
  try {
    const t = createFilesystemTransport(repoDir);
    assert(
      typeof t.readAllRecords === "function",
      "readAllRecords is a function",
    );
    assert(typeof t.appendRecord === "function", "appendRecord is a function");
    assert(typeof t.headHash === "function", "headHash is a function");
    assert(
      typeof t.peerHighWaterFor === "function",
      "peerHighWaterFor is a function",
    );
  } finally {
    cleanup(repoDir);
  }
});

test("state_io_resolveLogPath_returns_canonical_log_path", () => {
  const mod = require(STATE_IO);
  assert(
    typeof mod.resolveLogPath === "function",
    "state-io.js MUST export resolveLogPath",
  );
  const repoDir = mkTempRepoDir("resolve");
  try {
    const p = mod.resolveLogPath(repoDir);
    assert(
      typeof p === "string" && p.length > 0,
      "resolveLogPath returns string",
    );
    assert(
      p.endsWith(path.join("coordination-log.jsonl")),
      `log path ends with coordination-log.jsonl; got: ${p}`,
    );
    assert(
      p.includes(".claude") && p.includes("learning"),
      `log path lives under .claude/learning; got: ${p}`,
    );
  } finally {
    cleanup(repoDir);
  }
});

// ============================================================================
// Suite 2 — readAllRecords (invariant 2, read half)
// ============================================================================
console.log("\n--- readAllRecords ---");

test("transport_read_empty_log_returns_empty_array", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const repoDir = mkTempRepoDir("read-empty");
  try {
    const t = createFilesystemTransport(repoDir);
    const records = await t.readAllRecords();
    assert(Array.isArray(records), "returns an array");
    assertEqual(records.length, 0, "empty log → empty array");
  } finally {
    cleanup(repoDir);
  }
});

test("transport_append_then_read_returns_record", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const k = mkEphemeralSshKey("append-read");
  const repoDir = mkTempRepoDir("append-read");
  try {
    const t = createFilesystemTransport(repoDir);
    const core = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { session_id: "s1" },
    };
    const record = signRecord(core, k.keyPath);
    const r = await t.appendRecord(record);
    assertEqual(r.ok, true, "appendRecord returns ok:true");
    const records = await t.readAllRecords();
    assertEqual(records.length, 1, "one record persisted");
    assertEqual(
      records[0].verified_id,
      k.fingerprint,
      "record verified_id round-trips",
    );
    assertEqual(records[0].seq, 0, "record seq round-trips");
    assert(records[0].sig, "record sig present");
  } finally {
    cleanup(k.dir);
    cleanup(repoDir);
  }
});

test("transport_read_handles_malformed_line_gracefully", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const mod = require(STATE_IO);
  const repoDir = mkTempRepoDir("read-malformed");
  try {
    const logPath = mod.resolveLogPath(repoDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Two valid lines flanking one malformed line.
    fs.writeFileSync(
      logPath,
      JSON.stringify({ type: "heartbeat", seq: 0 }) +
        "\n{not valid json}\n" +
        JSON.stringify({ type: "heartbeat", seq: 1 }) +
        "\n",
    );
    const t = createFilesystemTransport(repoDir);
    const records = await t.readAllRecords();
    assertEqual(
      records.length,
      2,
      "malformed line skipped; two valid records returned",
    );
    assertEqual(records[0].seq, 0, "first valid record preserved");
    assertEqual(records[1].seq, 1, "second valid record preserved");
  } finally {
    cleanup(repoDir);
  }
});

// ============================================================================
// Suite 3 — headHash
// ============================================================================
console.log("\n--- headHash ---");

test("transport_head_hash_stable_when_no_writes", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const repoDir = mkTempRepoDir("head-stable");
  try {
    const t = createFilesystemTransport(repoDir);
    const h1 = await t.headHash();
    const h2 = await t.headHash();
    assertEqual(h1, h2, "two reads without writes return identical hash");
    assert(
      typeof h1 === "string" && h1.length === 64,
      `headHash returns 64-hex SHA-256; got: ${h1}`,
    );
  } finally {
    cleanup(repoDir);
  }
});

test("transport_head_hash_changes_when_record_appended", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const k = mkEphemeralSshKey("head-change");
  const repoDir = mkTempRepoDir("head-change");
  try {
    const t = createFilesystemTransport(repoDir);
    const hBefore = await t.headHash();
    const core = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {},
    };
    const r = await t.appendRecord(signRecord(core, k.keyPath));
    assertEqual(r.ok, true, "append ok");
    const hAfter = await t.headHash();
    assert(
      hBefore !== hAfter,
      `headHash MUST change after append; before=${hBefore} after=${hAfter}`,
    );
  } finally {
    cleanup(k.dir);
    cleanup(repoDir);
  }
});

// ============================================================================
// Suite 4 — appendRecord 2KB ceiling
// ============================================================================
console.log("\n--- appendRecord 2KB ceiling ---");

test("transport_rejects_record_exceeding_2kb_line_limit", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const k = mkEphemeralSshKey("over-2kb");
  const repoDir = mkTempRepoDir("over-2kb");
  try {
    const t = createFilesystemTransport(repoDir);
    // Build a record whose canonical JSON line will be >2KB. content carries
    // a large blob; signing it still produces a valid signed record, but
    // the transport MUST reject the append at the 2KB atomicity ceiling.
    const bigBlob = "x".repeat(2500);
    const core = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { blob: bigBlob },
    };
    const record = signRecord(core, k.keyPath);
    const r = await t.appendRecord(record);
    assertEqual(r.ok, false, "over-2KB record MUST be rejected");
    assert(
      typeof r.error === "string" &&
        /2KB|2048|too large|O_APPEND/i.test(r.error),
      `rejection reason names the 2KB / atomicity boundary; got: ${r.error}`,
    );
    const records = await t.readAllRecords();
    assertEqual(records.length, 0, "rejected record MUST NOT land on disk");
  } finally {
    cleanup(k.dir);
    cleanup(repoDir);
  }
});

test("transport_accepts_record_just_under_2kb_line_limit", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const k = mkEphemeralSshKey("under-2kb");
  const repoDir = mkTempRepoDir("under-2kb");
  try {
    const t = createFilesystemTransport(repoDir);
    const core = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-A",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { session_id: "s1" },
    };
    const record = signRecord(core, k.keyPath);
    const lineLen = JSON.stringify(record).length + 1;
    assert(
      lineLen <= 2048,
      `precondition: record line is <=2KB; actual=${lineLen}`,
    );
    const r = await t.appendRecord(record);
    assertEqual(r.ok, true, "under-2KB record accepted");
  } finally {
    cleanup(k.dir);
    cleanup(repoDir);
  }
});

// ============================================================================
// Suite 5 — peerHighWaterFor
// ============================================================================
console.log("\n--- peerHighWaterFor ---");

test("transport_peer_high_water_for_returns_null_when_verified_id_unknown", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const repoDir = mkTempRepoDir("phw-null");
  try {
    const t = createFilesystemTransport(repoDir);
    const hw = await t.peerHighWaterFor("SHA256:does-not-exist");
    assertEqual(hw, null, "unknown verified_id → null");
  } finally {
    cleanup(repoDir);
  }
});

test("transport_peer_high_water_for_returns_max_seq_per_verified_id", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const kA = mkEphemeralSshKey("phw-A");
  const kB = mkEphemeralSshKey("phw-B");
  const repoDir = mkTempRepoDir("phw-max");
  try {
    const t = createFilesystemTransport(repoDir);
    // A has seq 0, 1, 2. B has seq 0, 1.
    for (let s = 0; s <= 2; s++) {
      const core = {
        type: "heartbeat",
        verified_id: kA.fingerprint,
        person_id: "pid-A",
        seq: s,
        prev_hash: null,
        ts: "2026-05-20T00:00:00Z",
        content: { session_id: "sA" },
      };
      const r = await t.appendRecord(signRecord(core, kA.keyPath));
      assertEqual(r.ok, true, `append A seq ${s} ok`);
    }
    for (let s = 0; s <= 1; s++) {
      const core = {
        type: "heartbeat",
        verified_id: kB.fingerprint,
        person_id: "pid-B",
        seq: s,
        prev_hash: null,
        ts: "2026-05-20T00:00:00Z",
        content: { session_id: "sB" },
      };
      const r = await t.appendRecord(signRecord(core, kB.keyPath));
      assertEqual(r.ok, true, `append B seq ${s} ok`);
    }
    const hwA = await t.peerHighWaterFor(kA.fingerprint);
    const hwB = await t.peerHighWaterFor(kB.fingerprint);
    assertEqual(hwA, 2, "high water for A is max seq 2");
    assertEqual(hwB, 1, "high water for B is max seq 1");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
    cleanup(repoDir);
  }
});

// ============================================================================
// Suite 6 — concurrent-append atomicity (multi-process)
// ============================================================================
console.log("\n--- concurrent-append atomicity ---");

test("transport_concurrent_appends_are_atomic", async () => {
  // Two child processes append 100 small records concurrently. We verify all
  // 200 lines land on disk AND each line parses as a complete JSON record
  // (no torn writes). Per-emitter chain integrity is a fold-engine concern;
  // here we exercise O_APPEND atomicity only.
  const kA = mkEphemeralSshKey("concur-A");
  const kB = mkEphemeralSshKey("concur-B");
  const repoDir = mkTempRepoDir("concur");
  const workerScript = path.join(repoDir, "worker.js");
  try {
    fs.writeFileSync(
      workerScript,
      `
const TRANSPORT = ${JSON.stringify(TRANSPORT)};
const COC_SIGN = ${JSON.stringify(COC_SIGN)};
const { createFilesystemTransport } = require(TRANSPORT);
const { canonicalSerialize, sign } = require(COC_SIGN);

async function main() {
  const [repoDir, keyPath, verifiedId, personId, label, countStr] = process.argv.slice(2);
  const count = parseInt(countStr, 10);
  const t = createFilesystemTransport(repoDir);
  for (let s = 0; s < count; s++) {
    const core = {
      type: "heartbeat",
      verified_id: verifiedId,
      person_id: personId,
      seq: s,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: { label, idx: s },
    };
    const bytes = canonicalSerialize(core);
    const r = sign(bytes, { keyType: "ssh", keyPath });
    if (!r.ok) { console.error("sign failed: " + r.error); process.exit(1); }
    const record = Object.assign({}, core, { sig: r.sig });
    const w = await t.appendRecord(record);
    if (!w.ok) { console.error("append failed: " + w.error); process.exit(1); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
`,
    );

    const N = 100;
    const runChild = (keyPath, verifiedId, personId, label) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [
          workerScript,
          repoDir,
          keyPath,
          verifiedId,
          personId,
          label,
          String(N),
        ]);
        let stderr = "";
        p.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        p.on("exit", (code) => resolve({ status: code, stderr }));
      });

    const [resA, resB] = await Promise.all([
      runChild(kA.keyPath, kA.fingerprint, "pid-A", "labelA"),
      runChild(kB.keyPath, kB.fingerprint, "pid-B", "labelB"),
    ]);
    assertEqual(
      resA.status,
      0,
      `worker A exit 0; stderr: ${resA.stderr || "<empty>"}`,
    );
    assertEqual(
      resB.status,
      0,
      `worker B exit 0; stderr: ${resB.stderr || "<empty>"}`,
    );

    const stateIo = require(STATE_IO);
    const logPath = stateIo.resolveLogPath(repoDir);
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assertEqual(
      lines.length,
      2 * N,
      `200 complete lines on disk; got: ${lines.length}`,
    );
    let nA = 0;
    let nB = 0;
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        throw new Error(
          `torn write detected — line failed JSON.parse: ${line.slice(0, 80)}...`,
        );
      }
      assert(
        obj && obj.type === "heartbeat" && obj.sig,
        `line MUST be a complete signed record; got: ${JSON.stringify(obj).slice(0, 80)}`,
      );
      if (obj.verified_id === kA.fingerprint) nA += 1;
      else if (obj.verified_id === kB.fingerprint) nB += 1;
    }
    assertEqual(nA, N, "all A records present");
    assertEqual(nB, N, "all B records present");
  } finally {
    cleanup(kA.dir);
    cleanup(kB.dir);
    cleanup(repoDir);
  }
});

// ============================================================================
// Suite 7 — A2a engine integration (end-to-end via this transport)
// ============================================================================
console.log("\n--- A2a engine integration end-to-end ---");

test("engine_folds_records_from_filesystem_transport_end_to_end", async () => {
  const { createFilesystemTransport } = require(TRANSPORT);
  const { foldLog } = require(ENGINE);
  const k = mkEphemeralSshKey("e2e-engine");
  const repoDir = mkTempRepoDir("e2e-engine");
  try {
    const t = createFilesystemTransport(repoDir);

    const genesisCore = {
      type: "genesis-anchor",
      verified_id: k.fingerprint,
      person_id: "pid-owner",
      seq: 0,
      prev_hash: null,
      ts: "2026-05-20T00:00:00Z",
      content: {
        genesis: {
          repo_owner: "owner-A",
          repo_owner_kind: "user",
          root_commit: "abc123",
          genesis_generation: 0,
        },
        gh_api_owner_capture: { login: "owner-A", type: "User" },
        gh_api_root_commit_capture: { sha: "abc123", verified: true },
      },
    };
    const genesisRecord = signRecord(genesisCore, k.keyPath);

    // The 2KB ceiling is a transport-layer invariant (architecture §2.2);
    // larger gh-api captures belong on the git-ref transport per A3. The
    // minimal-capture shape here MUST fit under 2KB.
    const lineLen = JSON.stringify(genesisRecord).length + 1;
    if (lineLen > 2048) {
      throw new Error(
        `minimal genesis-anchor shape exceeds 2KB (${lineLen}B); ` +
          `signing-key or capture-shape regression — investigate before skipping`,
      );
    }
    const wG = await t.appendRecord(genesisRecord);
    assertEqual(
      wG.ok,
      true,
      "genesis-anchor write ok via filesystem transport",
    );

    const nowIso = new Date().toISOString();
    const hbCore = {
      type: "heartbeat",
      verified_id: k.fingerprint,
      person_id: "pid-owner",
      seq: 1,
      prev_hash: null,
      ts: nowIso,
      content: { session_id: "s-e2e" },
    };
    const hbRecord = signRecord(hbCore, k.keyPath);
    const wH = await t.appendRecord(hbRecord);
    assertEqual(wH.ok, true, "heartbeat write ok via filesystem transport");

    const records = await t.readAllRecords();
    assertEqual(records.length, 2, "two records read back via transport");

    const roster = {
      genesis: {
        repo_owner: "owner-A",
        repo_owner_kind: "user",
        root_commit: "abc123",
        genesis_generation: 0,
      },
      persons: {
        "pid-owner": {
          display_id: "owner-A",
          role: "owner",
          github_login: "owner-A",
          host_role: "human",
          keys: [{ type: "ssh", fingerprint: k.fingerprint, pubkey: k.pubKey }],
        },
      },
    };

    const r = foldLog(records, roster, {
      peerHighWaterFor: t.peerHighWaterFor,
    });
    assert(
      r.foldState && r.foldState.trustRoot,
      "trustRoot established from genesis-anchor read via filesystem transport",
    );
    assertEqual(
      r.foldState.trustRoot.verified_id,
      k.fingerprint,
      "trustRoot names the signer round-tripped through the transport",
    );
    const acceptedTypes = r.accepted.map((rec) => rec.type);
    assert(
      acceptedTypes.includes("genesis-anchor"),
      `genesis-anchor accepted in fold; got: ${acceptedTypes.join(",")}`,
    );
  } finally {
    cleanup(k.dir);
    cleanup(repoDir);
  }
});

// ---- driver -----------------------------------------------------------------
run();
