// @ts-nocheck
/*
 * Regression tests for .claude/hooks/validate-bash-command.js — the
 * destructive-working-tree-op detectors hardened for #401 Shard 3 (F92)
 * after the R1 redteam:
 *   - HIGH-1: leading-token anchor must tolerate `git -C <dir>` (the
 *     cross-tree form the #401 incident used) + sudo/env prefixes.
 *   - MUST-2 (hook-output-discipline): block severity MUST come from a
 *     STRUCTURAL signal, not a lexical regex span. The detectors run
 *     `git status --porcelain` and BLOCK only when the resolved tree is
 *     dirty (reset --hard) / has untracked-not-ignored files (git clean);
 *     a clean tree → halt-and-report (surface, allow). force-push →
 *     halt-and-report (GitHub rejects push-to-main server-side).
 *
 * Tier 1, STRUCTURAL probes per `probe-driven-verification.md` Rule 3 —
 * exit codes + user_summary presence. Each test builds a controlled git
 * repo (clean / dirty / untracked) so the structural verdict is
 * deterministic, NOT dependent on the harness checkout's git state.
 *
 * Run: node --test .claude/test-harness/tests/validate-bash-command.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const HOOK = path.join(REPO, ".claude", "hooks", "validate-bash-command.js");

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// Build a temp git repo with one committed file. opts.dirty → modify the
// tracked file (porcelain `M`); opts.untracked → add an untracked file
// (porcelain `??`). Returns the repo dir.
function mkRepo(label, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vbc-${label}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "tracked\n");
  git(dir, ["add", "tracked.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  if (opts.dirty) fs.writeFileSync(path.join(dir, "tracked.txt"), "MODIFIED\n");
  if (opts.untracked)
    fs.writeFileSync(path.join(dir, "untracked.txt"), "untracked work\n");
  return dir;
}

// Invoke the hook with an explicit cwd (the structural check runs there
// unless the command carries its own `-C <dir>`).
function runHook(command, cwd) {
  const payload = JSON.stringify({ tool_input: { command }, cwd: cwd || REPO });
  const r = spawnSync("node", [HOOK], {
    input: payload,
    encoding: "utf8",
    cwd: cwd || REPO,
    timeout: 8000,
  });
  return {
    status: r.status,
    out: (r.stdout || "") + (r.stderr || ""),
  };
}

const cleanup = (dirs) =>
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

// ──────────────────────────────────────────────────────────────────
// git reset --hard — STRUCTURAL severity
// ──────────────────────────────────────────────────────────────────

test("RH1: reset --hard against a DIRTY tree → BLOCK (exit 2, structural)", () => {
  const dir = mkRepo("rh1", { dirty: true });
  try {
    const r = runHook("git reset --hard HEAD", dir);
    assert.equal(r.status, 2, "dirty-tree --hard MUST block");
    assert.match(r.out, /DIRTY working tree/);
  } finally {
    cleanup([dir]);
  }
});

test("RH2: reset --hard against a CLEAN tree → halt-and-report (exit 0, no false-block)", () => {
  const dir = mkRepo("rh2", {});
  try {
    const r = runHook("git reset --hard HEAD", dir);
    assert.equal(r.status, 0, "clean-tree --hard MUST NOT hard-block");
    assert.match(r.out, /verify clean tree or use --keep/);
  } finally {
    cleanup([dir]);
  }
});

test("RH3: `git -C <dirty> reset --hard` from another cwd → BLOCK (HIGH-1 anchor)", () => {
  const target = mkRepo("rh3", { dirty: true });
  const elsewhere = mkRepo("rh3-cwd", {});
  try {
    const r = runHook(`git -C ${target} reset --hard HEAD`, elsewhere);
    assert.equal(r.status, 2, "git -C <dirty> reset --hard MUST block (anchor tolerates -C)");
    assert.match(r.out, /DIRTY working tree/);
  } finally {
    cleanup([target, elsewhere]);
  }
});

test("RH4: reset --hard inside a `git commit -m` body does NOT detect (leading token)", () => {
  const dir = mkRepo("rh4", { dirty: true });
  try {
    const r = runHook('git commit -m "earlier I ran git reset --hard"', dir);
    assert.doesNotMatch(r.out, /DIRTY working tree/);
  } finally {
    cleanup([dir]);
  }
});

// ──────────────────────────────────────────────────────────────────
// git clean -f[d] — STRUCTURAL severity
// ──────────────────────────────────────────────────────────────────

test("GC1: `git clean -fd` with untracked files present → BLOCK (exit 2)", () => {
  const dir = mkRepo("gc1", { untracked: true });
  try {
    const r = runHook("git clean -fd", dir);
    assert.equal(r.status, 2, "force-clean with untracked present MUST block");
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("GC2: `git clean -fd` with NO untracked files → halt-and-report (exit 0)", () => {
  const dir = mkRepo("gc2", {}); // clean — nothing to delete
  try {
    const r = runHook("git clean -fd", dir);
    assert.equal(r.status, 0, "force-clean of nothing MUST NOT hard-block");
    assert.match(r.out, /no untracked detected/);
  } finally {
    cleanup([dir]);
  }
});

test("GC3: `git clean -n` (dry-run) is exempt even with untracked present", () => {
  const dir = mkRepo("gc3", { untracked: true });
  try {
    const r = runHook("git clean -n", dir);
    assert.doesNotMatch(r.out, /untracked files present/);
    assert.doesNotMatch(r.out, /no untracked detected/);
  } finally {
    cleanup([dir]);
  }
});

test("GC4: `git clean -fdn` (force + dry-run override) is exempt", () => {
  const dir = mkRepo("gc4", { untracked: true });
  try {
    const r = runHook("git clean -fdn", dir);
    assert.doesNotMatch(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("GC5: `git -C <repo-with-untracked> clean -fd` → BLOCK (HIGH-1 anchor)", () => {
  const target = mkRepo("gc5", { untracked: true });
  const elsewhere = mkRepo("gc5-cwd", {});
  try {
    const r = runHook(`git -C ${target} clean -fd`, elsewhere);
    assert.equal(r.status, 2, "git -C <untracked> clean -fd MUST block (anchor tolerates -C)");
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([target, elsewhere]);
  }
});

test("GC6: `sudo git clean -fd` with untracked present → BLOCK (prefix-tolerant anchor)", () => {
  const dir = mkRepo("gc6", { untracked: true });
  try {
    const r = runHook("sudo git clean -fd", dir);
    assert.equal(r.status, 2, "sudo-prefixed force-clean MUST still be detected");
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("GC7: `git clean -fd` inside a `git commit -m` body does NOT detect", () => {
  const dir = mkRepo("gc7", { untracked: true });
  try {
    const r = runHook('git commit -m "earlier I ran git clean -fd"', dir);
    assert.doesNotMatch(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("GC8: `git cleanup --force` is NOT `git clean` (subcommand boundary)", () => {
  const dir = mkRepo("gc8", { untracked: true });
  try {
    const r = runHook("git cleanup --force", dir);
    assert.doesNotMatch(r.out, /untracked files present/);
    assert.doesNotMatch(r.out, /no untracked detected/);
  } finally {
    cleanup([dir]);
  }
});

// ──────────────────────────────────────────────────────────────────
// force-push — severity downgraded to halt-and-report (MUST-2;
// GitHub server-side rejection is the structural backstop)
// ──────────────────────────────────────────────────────────────────

test("FP1: force-push to main → halt-and-report (exit 0, not block)", () => {
  const dir = mkRepo("fp1", {});
  try {
    const r = runHook("git push --force origin main", dir);
    assert.equal(r.status, 0, "lexical force-push signal → halt-and-report, not block");
    assert.match(r.out, /force-push to main\/master/);
  } finally {
    cleanup([dir]);
  }
});

test("FP2: `git -C <dir> push --force main` → detected (HIGH-1 anchor)", () => {
  const dir = mkRepo("fp2", {});
  try {
    const r = runHook(`git -C ${dir} push --force-with-lease main`, dir);
    assert.match(r.out, /force-push to main\/master/);
  } finally {
    cleanup([dir]);
  }
});

test("FP3: non-force push to a feature branch is NOT flagged", () => {
  const dir = mkRepo("fp3", {});
  try {
    const r = runHook("git push origin feat/x", dir);
    assert.doesNotMatch(r.out, /force-push/);
  } finally {
    cleanup([dir]);
  }
});

// ──────────────────────────────────────────────────────────────────
// dispatch lock — unrelated halt-and-report path unaffected
// ──────────────────────────────────────────────────────────────────

test("NV1: `--no-verify` still halt-and-report (exit 0 + payload)", () => {
  const dir = mkRepo("nv1", {});
  try {
    const r = runHook("git commit --no-verify -m x", dir);
    assert.equal(r.status, 0);
    assert.match(r.out, /--no-verify/);
  } finally {
    cleanup([dir]);
  }
});

// ──────────────────────────────────────────────────────────────────
// R2 redteam (security HIGH-R2-1 + MED-R2-1) — wrapper-prefix operand
// forms + --work-tree= attached-form porcelain target.
// ──────────────────────────────────────────────────────────────────

test("R2-GC9: `sudo -u root git clean -fd` (operand form) with untracked → BLOCK (HIGH-R2-1)", () => {
  const dir = mkRepo("r2gc9", { untracked: true });
  try {
    const r = runHook("sudo -u root git clean -fd", dir);
    assert.equal(r.status, 2, "the `-u root` operand must NOT break the wrapper skip");
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("R2-RH5: `sudo -u root git reset --hard` (operand form) on dirty tree → BLOCK (HIGH-R2-1)", () => {
  const dir = mkRepo("r2rh5", { dirty: true });
  try {
    const r = runHook("sudo -u root git reset --hard HEAD", dir);
    assert.equal(r.status, 2);
    assert.match(r.out, /DIRTY working tree/);
  } finally {
    cleanup([dir]);
  }
});

test("R2-GC10: `command git clean -fd` with untracked → BLOCK (HIGH-R2-1 sibling)", () => {
  const dir = mkRepo("r2gc10", { untracked: true });
  try {
    const r = runHook("command git clean -fd", dir);
    assert.equal(r.status, 2);
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("R2-GC11: `/usr/bin/git clean -fd` (path-qualified) with untracked → BLOCK (HIGH-R2-1 sibling)", () => {
  const dir = mkRepo("r2gc11", { untracked: true });
  try {
    const r = runHook("/usr/bin/git clean -fd", dir);
    assert.equal(r.status, 2);
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});

test("R2-MED1: `git --work-tree=<untracked> clean -fd` from a CLEAN cwd → BLOCK (porcelain follows --work-tree)", () => {
  const target = mkRepo("r2med-target", { untracked: true });
  const cleanCwd = mkRepo("r2med-cwd", {});
  try {
    // Pre-R2-fix: --work-tree= was not captured → porcelain checked the
    // clean cwd → false downgrade to halt-and-report. Post-fix: the check
    // follows --work-tree to the untracked target → block.
    const r = runHook(`git --work-tree=${target} --git-dir=${target}/.git clean -fd`, cleanCwd);
    assert.equal(r.status, 2, "porcelain MUST inspect the --work-tree target, not cwd");
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([target, cleanCwd]);
  }
});

test("R2-FP-bare-cmd: a non-git command sharing a wrapper does not crash the parser", () => {
  const dir = mkRepo("r2bare", {});
  try {
    // `echo git clean` — echo is NOT a wrapper; the scan terminates at the
    // bare non-git command and never treats the literal `git` arg as a cmd.
    const r = runHook("echo git clean -fd", dir);
    assert.doesNotMatch(r.out, /untracked files present/);
    assert.doesNotMatch(r.out, /no untracked detected/);
  } finally {
    cleanup([dir]);
  }
});

// ──────────────────────────────────────────────────────────────────
// R3 redteam (security MED-R3-1) — backslash-escaped git token.
//
// ACCEPTED RESIDUALS (NOT closable at this layer; backed by the
// sync-tier-aware pre-write snapshot forever-layer per journal/0178 CRIT-1):
//   - `git$IFS clean -fd`  — `$IFS` expands at bash runtime; the hook sees
//     the pre-expansion token `git$IFS` (same blindness hook-output-
//     discipline.md Rule 3 codifies for `$VAR`; expanding it is forbidden).
//   - `sudo sh -c 'git clean -fd'` / `xargs git clean` — subshell / non-
//     leading invocation (CRIT-1 structural blindness; the snapshot covers).
// ──────────────────────────────────────────────────────────────────

test("R3-GC12: `\\git clean -fd` (backslash-escaped) with untracked → BLOCK (MED-R3-1)", () => {
  const dir = mkRepo("r3gc12", { untracked: true });
  try {
    // `\git` runs the git binary at bash runtime (backslash skips alias
    // lookup only); isGitToken's optional leading `\` must still detect it.
    const r = runHook("\\git clean -fd", dir);
    assert.equal(r.status, 2, "backslash-escaped git must still be detected");
    assert.match(r.out, /untracked files present/);
  } finally {
    cleanup([dir]);
  }
});
