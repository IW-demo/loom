#!/usr/bin/env node
/*
 * F42 — posture v1→v2 schema migration regression suite.
 *
 * Per probe-driven-verification.md MUST-3: structural probes (input → expected
 * output) — no LLM judge required. The brief at workspaces/multi-operator-coc/
 * session-notes flagged that computeOperativePosture returned L5_DELEGATED for
 * every operator because state-io.js::readPosture only ever produced the v1
 * shape, and multi-operator-sessionstart.js's local readPosture passed the v1
 * shape to computeOperativePosture which then matched neither the v2
 * `operators` map nor the v2 `repo_floor` and fell through to its defaults.
 *
 * Coverage:
 *   - fresh-repo read (no posture.json, no .initialized): v2 shape, repo_floor L5
 *   - v1-on-disk read auto-migrates to v2 shape
 *   - v2-on-disk read returns v2 shape unchanged
 *   - corrupt-state read (init marker present, file missing) fails closed to L1
 *   - corrupt-JSON read falls back to .bak, then fail-closed
 *   - computeOperativePosture(readPosture(fresh), pid) returns L2 (operator
 *     default) under L5 floor → min = L2, NOT L5
 *   - computeOperativePosture against migrated v1 → operator default L2, floor
 *     from migrated value
 *   - legacy v1-shape facets (posture, since, pending_verification,
 *     violation_window_30d, transition_history, _fresh, _fail_closed) survive
 *     on the return value so legacy consumers (posture-gate, session-start,
 *     detect-violations) keep working
 *
 * Run: node .claude/test-harness/tests/posture-v2-migration.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const require = createRequire(import.meta.url);
const stateIoPath = path.join(
  repoRoot,
  ".claude",
  "hooks",
  "lib",
  "state-io.js",
);
const postureV2Path = path.join(
  repoRoot,
  ".claude",
  "hooks",
  "lib",
  "posture-v2.js",
);

// ---- test sandbox helpers ---------------------------------------------------
//
// Each test gets a private state dir via CLAUDE_TRUST_STATE_DIR so reads/writes
// don't touch the real repo state (which is gitignored and per-clone anyway).
// We cache-bust the modules per-sandbox because state-io.js + state-resolver.js
// read the env var at module-load. The simplest clean-room is delete-from-cache
// and re-require with the env var set.

function withSandbox(fn) {
  const sandboxBase = fs.mkdtempSync(path.join(os.tmpdir(), "posture-f42-"));
  const stateDir = path.join(sandboxBase, ".claude", "learning");
  fs.mkdirSync(stateDir, { recursive: true });
  const prevEnv = process.env.CLAUDE_TRUST_STATE_DIR;
  process.env.CLAUDE_TRUST_STATE_DIR = stateDir;
  // Bust the require cache so state-io picks up the new env var via its
  // require of state-resolver.
  delete require.cache[require.resolve(stateIoPath)];
  delete require.cache[
    require.resolve(path.join(repoRoot, ".claude", "hooks", "lib", "state-resolver.js"))
  ];
  delete require.cache[require.resolve(postureV2Path)];
  const stateIo = require(stateIoPath);
  const postureV2 = require(postureV2Path);
  try {
    fn({ stateIo, postureV2, sandboxBase, stateDir });
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_TRUST_STATE_DIR;
    else process.env.CLAUDE_TRUST_STATE_DIR = prevEnv;
    // Best-effort sandbox cleanup
    try {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// ---- fresh-repo path --------------------------------------------------------

test("readPosture on fresh repo returns v2 shape with repo_floor L5_DELEGATED", () => {
  withSandbox(({ stateIo }) => {
    // No posture.json, no .initialized marker → fresh repo.
    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.schema_version, 2);
    assert.equal(p.repo_floor.posture, "L5_DELEGATED");
    assert.equal(p.repo_floor.set_by, "system-fresh-repo");
    assert.deepEqual(p.operators, {});
    assert.equal(p._fresh, true);
    assert.equal(p._fail_closed, undefined);
    // Legacy v1 facets MUST be present for back-compat with posture-gate,
    // detect-violations, session-start.
    assert.equal(p.posture, "L5_DELEGATED");
    assert.equal(typeof p.since, "string");
    assert.deepEqual(p.pending_verification, []);
    assert.deepEqual(p.violation_window_30d, {});
    assert.deepEqual(p.transition_history, []);
  });
});

// ---- v1-on-disk migration ---------------------------------------------------

test("readPosture on v1-on-disk file auto-migrates to v2 shape", () => {
  withSandbox(({ stateIo, stateDir }) => {
    const v1 = {
      posture: "L3_SHARED_PLANNING",
      since: "2026-05-01T00:00:00.000Z",
      transition_history: [
        { from: "L5_DELEGATED", to: "L3_SHARED_PLANNING", type: "DOWNGRADE" },
      ],
      pending_verification: [
        { rule_id: "test-rule", since: "2026-05-01T00:00:00Z", grace_period_days: 7 },
      ],
      violation_window_30d: { "test-rule": 2 },
      _initialized: true,
    };
    writeJson(path.join(stateDir, "posture.json"), v1);
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    // v2-canonical shape
    assert.equal(p.schema_version, 2);
    assert.equal(p.repo_floor.posture, "L3_SHARED_PLANNING");
    assert.equal(p.repo_floor.set_by, "system-migration-v1-to-v2");
    assert.equal(p.repo_floor.since, "2026-05-01T00:00:00.000Z");
    assert.deepEqual(p.operators, {});
    assert.equal(p._initialized, true);
    // Legacy facets surface repo_floor as `posture` (semantics preserved)
    assert.equal(p.posture, "L3_SHARED_PLANNING");
    // v1-specific operational state (pending_verification + violation_window_30d)
    // MUST survive the migration.
    assert.equal(p.pending_verification.length, 1);
    assert.equal(p.pending_verification[0].rule_id, "test-rule");
    assert.deepEqual(p.violation_window_30d, { "test-rule": 2 });
    assert.equal(p.transition_history.length, 1);
  });
});

// ---- v2-on-disk passthrough -------------------------------------------------

test("readPosture on v2-on-disk file returns v2 shape unchanged", () => {
  withSandbox(({ stateIo, stateDir }) => {
    const v2 = {
      schema_version: 2,
      repo_floor: {
        posture: "L4_CONTINUOUS_INSIGHT",
        since: "2026-05-15T00:00:00.000Z",
        set_by: "person:alice",
      },
      operators: {
        "person:alice": {
          posture: "L5_DELEGATED",
          since: "2026-05-15T00:00:00.000Z",
          set_by: "person:alice",
        },
        "person:bob": {
          posture: "L2_SUPERVISED",
          since: "2026-05-15T00:00:00.000Z",
          set_by: "person:alice",
        },
      },
      _initialized: true,
      transition_history: [],
    };
    writeJson(path.join(stateDir, "posture.json"), v2);
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.schema_version, 2);
    assert.equal(p.repo_floor.posture, "L4_CONTINUOUS_INSIGHT");
    assert.equal(p.operators["person:alice"].posture, "L5_DELEGATED");
    assert.equal(p.operators["person:bob"].posture, "L2_SUPERVISED");
    // Legacy facet surfaces repo_floor as posture
    assert.equal(p.posture, "L4_CONTINUOUS_INSIGHT");
  });
});

// ---- corrupt-state fail-closed ----------------------------------------------

test("readPosture with init marker but missing posture.json fails closed to L1", () => {
  withSandbox(({ stateIo, stateDir }) => {
    // Init marker present but no posture.json + no .bak → deleted state.
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.schema_version, 2);
    assert.equal(p.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(p._fail_closed, true);
    // Legacy facet semantics: posture surfaces the floor (L1)
    assert.equal(p.posture, "L1_PSEUDO_AGENT");
    assert.equal(p.transition_history[0].type, "FAIL_CLOSED");
  });
});

test("readPosture with corrupt JSON main + missing bak fails closed to L1", () => {
  withSandbox(({ stateIo, stateDir }) => {
    fs.writeFileSync(path.join(stateDir, "posture.json"), "{not-valid-json");
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(p._fail_closed, true);
  });
});

test("readPosture falls back to .bak when main is corrupt", () => {
  withSandbox(({ stateIo, stateDir }) => {
    fs.writeFileSync(path.join(stateDir, "posture.json"), "{not-json");
    writeJson(path.join(stateDir, "posture.json.bak"), {
      posture: "L4_CONTINUOUS_INSIGHT",
      since: "2026-05-10T00:00:00.000Z",
      transition_history: [],
      pending_verification: [],
      violation_window_30d: {},
      _initialized: true,
    });
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    // v1 .bak migrated to v2 at read time
    assert.equal(p.schema_version, 2);
    assert.equal(p.repo_floor.posture, "L4_CONTINUOUS_INSIGHT");
    assert.notEqual(p._fail_closed, true);
  });
});

// ---- computeOperativePosture integration -----------------------------------
//
// These are the load-bearing tests: they prove the F42 brief's silent fallback
// is closed. Pre-F42, computeOperativePosture(v1_shape, pid) found no
// `operators[pid]` AND no `repo_floor`, then fell through to its defaults
// (operator → L2, floor → L5) and returned min(L2, L5) = L2 — but ONLY if it
// was passed a v2 shape. The actual v1 shape (no `repo_floor`) made
// `repo_floor.posture` undefined which failed the `_isValidPosture` guard, and
// the function defaulted to L5_DELEGATED — i.e. EVERY operator got L5.
// Post-F42, readPosture always returns v2 shape, so the function returns the
// correct min(L2_SUPERVISED, repo_floor) for a new operator under any floor.

test("computeOperativePosture(readPosture(fresh), unknown-operator) returns L2 under L5 floor", () => {
  withSandbox(({ stateIo, postureV2 }) => {
    const p = stateIo.readPosture(process.cwd());
    const op = postureV2.computeOperativePosture(p, "person:new-operator");
    // Fresh repo: floor L5, new operator default L2 → min = L2 (operator wins)
    assert.equal(op.posture, "L2_SUPERVISED");
    assert.equal(op.source, "operator");
  });
});

test("computeOperativePosture(readPosture(v1 file), unknown-operator) returns L2 under migrated floor", () => {
  withSandbox(({ stateIo, postureV2, stateDir }) => {
    writeJson(path.join(stateDir, "posture.json"), {
      posture: "L3_SHARED_PLANNING",
      since: "2026-05-01T00:00:00.000Z",
      transition_history: [],
      pending_verification: [],
      violation_window_30d: {},
      _initialized: true,
    });
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    const op = postureV2.computeOperativePosture(p, "person:new-operator");
    // v1 floor L3 migrates to repo_floor L3; new operator default L2 → L2 wins
    assert.equal(op.posture, "L2_SUPERVISED");
    assert.equal(op.source, "operator");
  });
});

test("computeOperativePosture(readPosture(v2 file), rostered-operator) returns operator-specific posture", () => {
  withSandbox(({ stateIo, postureV2, stateDir }) => {
    writeJson(path.join(stateDir, "posture.json"), {
      schema_version: 2,
      repo_floor: {
        posture: "L4_CONTINUOUS_INSIGHT",
        since: "2026-05-15T00:00:00.000Z",
        set_by: "person:alice",
      },
      operators: {
        "person:alice": {
          posture: "L5_DELEGATED",
          since: "2026-05-15T00:00:00.000Z",
          set_by: "person:alice",
        },
        "person:bob": {
          posture: "L3_SHARED_PLANNING",
          since: "2026-05-15T00:00:00.000Z",
          set_by: "person:alice",
        },
      },
      _initialized: true,
      transition_history: [],
    });
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    // alice: operator L5, floor L4 → min L4 (floor wins)
    const alice = postureV2.computeOperativePosture(p, "person:alice");
    assert.equal(alice.posture, "L4_CONTINUOUS_INSIGHT");
    assert.equal(alice.source, "floor");
    // bob: operator L3, floor L4 → min L3 (operator wins)
    const bob = postureV2.computeOperativePosture(p, "person:bob");
    assert.equal(bob.posture, "L3_SHARED_PLANNING");
    assert.equal(bob.source, "operator");
    // unknown carol: operator default L2, floor L4 → min L2
    const carol = postureV2.computeOperativePosture(p, "person:carol");
    assert.equal(carol.posture, "L2_SUPERVISED");
    assert.equal(carol.source, "operator");
  });
});

// ---- failClosedPosture v2-shape regression ----------------------------------

test("failClosedPosture returns v2 shape with repo_floor L1 + legacy facets", () => {
  withSandbox(({ stateIo }) => {
    const fc = stateIo.failClosedPosture("test reason");
    assert.equal(fc.schema_version, 2);
    assert.equal(fc.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(fc.repo_floor.set_by, "system-fail-closed");
    assert.equal(fc._fail_closed, true);
    assert.equal(fc.posture, "L1_PSEUDO_AGENT");
    assert.equal(fc.transition_history[0].type, "FAIL_CLOSED");
    assert.equal(fc.transition_history[0].reason, "test reason");
  });
});

// ---- v1 file with corrupt posture-string falls through ----------------------

test("readPosture on v1-shape with invalid posture string skips to .bak / fail-closed", () => {
  withSandbox(({ stateIo, stateDir }) => {
    writeJson(path.join(stateDir, "posture.json"), {
      posture: "NOT_A_VALID_POSTURE",
      since: "2026-05-01T00:00:00.000Z",
    });
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");

    const p = stateIo.readPosture(process.cwd());
    // Invalid v1 → no .bak → fail-closed
    assert.equal(p.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(p._fail_closed, true);
  });
});

// ---- HIGH-1 adversarial init-marker nuke (security-reviewer Wave 2 R1) -------
// Threat model: adversary with file-write access bypasses the deny-matrix and
// nukes posture.json + posture.json.bak + .initialized in one shot to make the
// repo masquerade as fresh (which would auto-default to L5_DELEGATED under the
// pre-fix marker-only check). The clone-init witness file (.coc-clone-init-witness)
// lives at a separate sentinel; its survival proves the substrate WAS
// provisioned and forces fail-closed L1 regardless of marker state.

test("HIGH-1: clone-init witness survives while .initialized nuked → fail-closed L1", () => {
  withSandbox(({ stateIo, stateDir }) => {
    // Simulate the post-adversary state: posture+bak+marker all nuked, but
    // the clone-init witness file remains (the adversary doesn't know about
    // it OR can't reach it from the deny-restricted surface).
    fs.writeFileSync(path.join(stateDir, ".coc-clone-init-witness"), "test");
    // No posture.json, no posture.json.bak, no .initialized
    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(p._fail_closed, true);
    // Reason names the adversarial discriminator branch
    assert.match(
      p.transition_history[0].reason,
      /clone-init witness survives.*adversarial init-marker nuke/i,
    );
  });
});

test("HIGH-1 negative: no witness + no marker → fresh-repo L5 (regression guard)", () => {
  withSandbox(({ stateIo }) => {
    // Pristine fresh repo — no witness, no marker, no posture. The new
    // discriminator path MUST NOT downgrade this benign case to L1.
    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.repo_floor.posture, "L5_DELEGATED");
    assert.equal(p._fresh, true);
  });
});

test("HIGH-1 negative: marker present + witness present + log absent → L1 (existing post-init-damage path)", () => {
  withSandbox(({ stateIo, stateDir }) => {
    // Pre-existing case: substrate provisioned (marker + witness), but log was
    // nuked. discriminateState's existing post-init-state-damage branch fires.
    fs.writeFileSync(path.join(stateDir, ".initialized"), "test");
    fs.writeFileSync(path.join(stateDir, ".coc-clone-init-witness"), "test");
    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(p._fail_closed, true);
  });
});

// ---- F52 closure: directory-sweep adversary on .claude/learning/* ------------
// F52 (multi-operator-coordination.md § Origin "Open follow-up forest items")
// relocates `CLONE_INIT_WITNESS_FILE` OUT of `.claude/learning/` to a separate-
// location sentinel (`<repoRoot>/.git/coc-clone-init-witness` in production;
// `<sandboxRoot>/.coc-clone-init-witness` in test sandboxes). The directory-
// sweep adversary (`rm -rf .claude/learning/*`) from Wave2-R2 NEW-3 now wipes
// only 3 files (posture + bak + .initialized) — the witness at the sibling
// location survives. `discriminateState` detects this via the
// `!initMarkerExists && cloneInitWitnessExists` branch (posture-v2.js:404) and
// returns `corrupt-L1` — the adversarial-init-marker-nuke disposition.

test("F52 CLOSED: directory-sweep on .claude/learning/* with witness at sibling → corrupt-L1", () => {
  withSandbox(({ stateIo, sandboxBase }) => {
    // Pre-init the witness at the NEW separate-location sentinel BEFORE the
    // adversarial sweep. Under F52 the witness lives at sandbox-sibling
    // (`<sandboxBase>/.coc-clone-init-witness`) — OUTSIDE `.claude/learning/`.
    const witnessPath = path.join(sandboxBase, ".coc-clone-init-witness");
    fs.writeFileSync(witnessPath, "clone-init-recorded", { mode: 0o600 });
    // Directory-sweep adversary: nuke EVERYTHING in `.claude/learning/*`.
    // Under OLD code (witness co-located inside `.claude/learning/`), the
    // witness was wiped along with posture + bak + .initialized — 4-file-nuke
    // → fresh-repo-L5 (the residual NEW-3 named). Under F52, the witness
    // at the SIBLING location survives.
    //
    // Note: in this sandbox no `.claude/learning/*` artifacts were ever
    // created, so there is nothing to remove — the test models the post-nuke
    // state directly. The witness MUST persist at sibling location.
    assert.equal(fs.existsSync(witnessPath), true);

    const p = stateIo.readPosture(process.cwd());
    // F52 flip: under OLD code this was `L5_DELEGATED + _fresh: true` (the
    // honest-disclosure pin NEW-3 carried). With F52 wired, the witness
    // survives → discriminateState fires the adversarial-nuke branch → L1.
    assert.equal(p.repo_floor.posture, "L1_PSEUDO_AGENT");
    assert.equal(p._fail_closed, true);
    assert.match(
      p.transition_history[0].reason,
      /clone-init witness survives while \.initialized marker is absent/,
    );
  });
});

test("F52: genuine fresh clone (no witness anywhere) still → fresh-repo-L5", () => {
  withSandbox(({ stateIo, sandboxBase }) => {
    // No witness pre-created; no state files; no init marker — pristine fresh
    // clone. Discriminator MUST NOT confuse this with the adversarial-nuke
    // case from the test above. Regression-locks the F52 disposition: the
    // signal that flips L5 → L1 is witness-presence, NOT witness-resolution.
    const witnessPath = path.join(sandboxBase, ".coc-clone-init-witness");
    assert.equal(fs.existsSync(witnessPath), false);

    const p = stateIo.readPosture(process.cwd());
    assert.equal(p.repo_floor.posture, "L5_DELEGATED");
    assert.equal(p._fresh, true);
  });
});

// ---- F52: migration helper (legacy → new location) --------------------------
// migrateWitnessIfPresent ports an existing legacy witness file at
// `<stateDir>/.coc-clone-init-witness` to the F52 separate-location sentinel.
// Idempotent; safe to call on every readPosture invocation.

test("F52: migrateWitnessIfPresent relocates legacy witness to sandbox sibling", () => {
  withSandbox(({ stateIo, sandboxBase, stateDir }) => {
    // Pre-create the legacy witness at the OLD in-`.claude/learning/` path.
    const legacyPath = path.join(stateDir, ".coc-clone-init-witness");
    fs.writeFileSync(legacyPath, "legacy-clone-init-recorded", { mode: 0o600 });
    assert.equal(fs.existsSync(legacyPath), true);
    // New location starts absent.
    const newPath = path.join(sandboxBase, ".coc-clone-init-witness");
    assert.equal(fs.existsSync(newPath), false);

    const res = stateIo.migrateWitnessIfPresent(process.cwd());

    assert.equal(res.ok, true);
    assert.equal(res.migrated, true);
    // Content preserved at new location.
    assert.equal(fs.existsSync(newPath), true);
    assert.equal(fs.readFileSync(newPath, "utf8"), "legacy-clone-init-recorded");
    // Legacy unlinked atomically.
    assert.equal(fs.existsSync(legacyPath), false);
  });
});

test("F52: migrateWitnessIfPresent is idempotent (no legacy → no-op)", () => {
  withSandbox(({ stateIo }) => {
    // No legacy witness anywhere.
    const res = stateIo.migrateWitnessIfPresent(process.cwd());
    assert.equal(res.ok, true);
    assert.equal(res.migrated, false);
  });
});

// ---- F52: resolveWitnessPath surface ---------------------------------------

test("F52: resolveWitnessPath in test sandbox returns sandbox-sibling path", () => {
  withSandbox(({ stateIo, sandboxBase }) => {
    const r = stateIo.resolveWitnessPath(process.cwd());
    assert.equal(r.ok, true);
    assert.equal(r.value, path.join(sandboxBase, ".coc-clone-init-witness"));
    assert.equal(r.source, "test-sandbox-sibling");
  });
});

test("F52: resolveWitnessPath rejects empty repoDir with typed error", () => {
  withSandbox(({ stateIo }) => {
    const r = stateIo.resolveWitnessPath("");
    assert.equal(r.ok, false);
    assert.match(r.reason, /repoDir must be a non-empty string/);
  });
});

// ---- F53: atomic-write defense-in-depth (O_NOFOLLOW + parent-dir fsync) ------
// F53 (multi-operator-coordination.md § Origin "Open follow-up forest items")
// hardens migrateWitnessIfPresent's atomic write against two LOW findings from
// F52 security-reviewer Round 1:
//   (a) symlink-redirect — an adversary pre-plants a symlink at the tmp path;
//       O_NOFOLLOW makes openSync raise ELOOP instead of writing through it.
//   (b) crash-durability — the parent dir of the new location is fsynced after
//       renameSync and BEFORE the legacy unlink, so the witness is present at
//       legacy OR durably at newPath across any crash window, never neither.
// Both are bounded by the substrate's bounded-trust threat model; shipped as
// defense-in-depth. Structural probes per probe-driven-verification.md MUST-3.

test("F53 (a): migrateWitnessIfPresent refuses a symlink pre-planted at the tmp path", () => {
  withSandbox(({ stateIo, sandboxBase, stateDir }) => {
    // Legacy witness present → migration will attempt a tmp+rename to newPath.
    const legacyPath = path.join(stateDir, ".coc-clone-init-witness");
    fs.writeFileSync(legacyPath, "legacy-clone-init-recorded", { mode: 0o600 });
    const newPath = path.join(sandboxBase, ".coc-clone-init-witness");
    // The migration writes to `${newPath}.tmp.${process.pid}`; tests run in the
    // SAME process, so this path matches exactly.
    const tmpPath = `${newPath}.tmp.${process.pid}`;
    // Adversary pre-plants a symlink at the tmp path pointing at a sink OUTSIDE
    // the witness dir. Under "w" semantics openSync would FOLLOW the link and
    // write the witness content into the attacker's sink.
    const sink = path.join(sandboxBase, "attacker-sink");
    fs.writeFileSync(sink, "");
    fs.symlinkSync(sink, tmpPath);
    assert.equal(fs.lstatSync(tmpPath).isSymbolicLink(), true);

    const res = stateIo.migrateWitnessIfPresent(process.cwd());

    // O_NOFOLLOW → ELOOP → typed failure at the write-tmp boundary, NOT a
    // silent write-through.
    assert.equal(res.ok, false);
    assert.match(res.reason, /migrate: write tmp:/);
    // The attacker sink MUST NOT have received the witness content.
    assert.equal(fs.readFileSync(sink, "utf8"), "");
    // The legacy witness MUST remain intact — migration aborted cleanly.
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(
      fs.readFileSync(legacyPath, "utf8"),
      "legacy-clone-init-recorded",
    );
    // The new location MUST NOT have been created.
    assert.equal(fs.existsSync(newPath), false);
  });
});

test("F53 (b): migrateWitnessIfPresent fsyncs the parent dir of the new location", () => {
  withSandbox(({ stateIo, sandboxBase, stateDir }) => {
    const legacyPath = path.join(stateDir, ".coc-clone-init-witness");
    fs.writeFileSync(legacyPath, "legacy-clone-init-recorded", { mode: 0o600 });
    const newPath = path.join(sandboxBase, ".coc-clone-init-witness");
    const parentDir = path.dirname(newPath);

    // Structural probe: intercept openSync to capture the fd opened for the
    // parent directory (mode "r"), and fsyncSync to record every fd it flushed.
    // The assertion proves the parent-dir fd was actually passed to fsyncSync —
    // not merely that a boolean field is set.
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    let parentDirFd = null;
    const fsyncedFds = [];
    fs.openSync = (p, flags, mode) => {
      const fd = realOpen(p, flags, mode);
      if (path.resolve(String(p)) === path.resolve(parentDir) && flags === "r") {
        parentDirFd = fd;
      }
      return fd;
    };
    fs.fsyncSync = (fd) => {
      fsyncedFds.push(fd);
      return realFsync(fd);
    };

    let res;
    try {
      res = stateIo.migrateWitnessIfPresent(process.cwd());
    } finally {
      fs.openSync = realOpen;
      fs.fsyncSync = realFsync;
    }

    // Migration succeeded end-to-end.
    assert.equal(res.ok, true);
    assert.equal(res.migrated, true);
    assert.equal(res.parent_dir_synced, true);
    // O_NOFOLLOW is present on darwin/linux (the substrate's deploy targets), so
    // the symlink protection was active on this write — observable per F53.
    assert.equal(res.nofollow_supported, true);
    assert.equal(fs.readFileSync(newPath, "utf8"), "legacy-clone-init-recorded");
    assert.equal(fs.existsSync(legacyPath), false);
    // Structural proof of (b): the parent dir was opened AND its fd fsynced.
    assert.notEqual(parentDirFd, null, "parent dir was opened for fsync");
    assert.ok(
      fsyncedFds.includes(parentDirFd),
      "parent dir fd was passed to fsyncSync",
    );
  });
});
