#!/usr/bin/env node
/*
 * ============================================================================
 *  Pre-Emit Validator — F30 (issue #350 Stage 2)
 * ============================================================================
 *
 *  loom is its own L5_DELEGATED consumer of its own rule corpus. It authors
 *  the rules that downstream `/redteam` enforces via mechanical sweep, but it
 *  did not run those sweeps against its OWN emit output before `/sync`
 *  distributed it — so each downstream Round-1 sweep re-derived the same class
 *  of gap, filed an issue, loom patched, repeat (issue #350's 7-finding
 *  cluster). This validator closes the class: it runs the rule-corpus
 *  mechanical sweeps against loom's emit surface at `/sync` time and BLOCKS on
 *  any violation, turning each downstream sweep into an asserted invariant at
 *  loom emit time.
 *
 *  Value-anchor (value-prioritization.md MUST-1 source e — user-filed/approved
 *  spec): issue #350 § "Acceptance criteria" — "tools/validate-emit.* scaffold
 *  lands with the 7 first-cycle checks ... /sync blocks on any check fail
 *  unless --allow=<check-name>:<path> ... validator itself follows
 *  probe-driven-verification.md (each check is structural)".
 *
 *  THE CHECKS (1-7 map 1:1 to issue #350 Findings 1-7; 8 added F104):
 *    1. command-frontmatter        every .claude/commands/*.md opens with `---`
 *                                  (or is in COMMAND_FRONTMATTER_EXEMPT)
 *    2. command-line-cap           command body (after frontmatter) <= 150 lines
 *    3. readonly-specialist-tools  agents named read-only in agents.md MUST NOT
 *                                  declare file-mutation tools (Edit/Write).
 *                                  Bash + Task are allowed — reviewer's mechanical
 *                                  sweeps need Bash, Task is sub-delegation.
 *    4. tool-canonicality          every agent `tools:` value is a canonical CC tool
 *    5. mirror-exclusion           every source SKILL is emitted to each CLI tree
 *                                  (fresh emit) OR is in cli_emit_exclusions
 *                                  (v1 scopes to skills — Finding 7's category;
 *                                  command/agent mirror needs emitter-side
 *                                  reconciliation, tracked as the check-5 follow-up)
 *    6. paths-annotation-consistency  a rule annotated with a path glob in the
 *                                  emitted CLAUDE/AGENTS/GEMINI Rules Index MUST
 *                                  carry that glob in its `paths:` frontmatter
 *    7. audit-fixture-coverage     every `detect*` detector in violation-patterns.js
 *                                  has an audit-fixture dir with >=1 flag + >=1 clean
 *    8. loom-only-mutual-exclusion (F104) a `loom_only:` glob that is ALSO in a
 *                                  synced tier FAILS (blocks /sync); a glob
 *                                  matching 0 on-disk files = WARN (non-blocking).
 *
 *  Each check is STRUCTURAL (file existence, frontmatter parse, line count, set
 *  membership, glob match, tree presence) per probe-driven-verification.md
 *  MUST-3 — no regex-over-prose semantic assertion. No LLM needed.
 *
 *  STATUS per artifact:  pass | fail | fixture-needed | skip
 *    - fail            verified violation; BLOCKS /sync (exit 1) unless allowed
 *    - fixture-needed  check-7 missing-fixture finding; BLOCKS unless allowed
 *    - skip            check could not run (input absent, e.g. no staged emit
 *                      tree for check 5); informational, does NOT block
 *
 *  OVERRIDE:  --allow=<check-id>:<artifact>   (repeatable)
 *    Removes a specific (check, artifact) finding from the blocking set. The
 *    override is echoed in the report so the /sync commit message records every
 *    suppression (auditable per issue #350 acceptance criteria).
 *
 *  Usage:
 *    node .claude/bin/validate-emit.mjs [--json] [--check <id>] [--allow <id>:<path>] [--help]
 *
 *  Exit:
 *    0 = no blocking findings (all pass/skip, or every fail/fixture-needed allowed)
 *    1 = >=1 unallowed blocking finding
 *    2 = usage / IO error
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**` per sync-manifest.yaml). Zero
 *  client/org tokens; detection is purely structural.
 * ============================================================================
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// CJS bridge — the provenance-event schema (EVENT_KINDS, the frozen closed
// taxonomy) and coc-sign's canonicalSerialize (the byte-exact seam serializer
// csq signs against) are CommonJS hook libs. Routing both through one
// createRequire keeps check-9 (provenance-parity, F101-4 / loom#411 item 5)
// anchored on the SAME taxonomy the capture hooks use — no re-declaration drift.
const _require = createRequire(import.meta.url);
const { EVENT_KINDS } = _require("../hooks/lib/provenance-event.js");
const { canonicalSerialize } = _require("../hooks/lib/coc-sign.js");

// #392 — the unified `.coc/` emitter. Reused read-only here to surface the
// emit-breaking conditions (duplicate id §9.4.2 / grammar violation §9.2.1) at
// /sync time. emitCoc uses the loom checkout (emit-cli-artifacts.mjs::REPO);
// the check SKIPs when validate-emit is pointed at a different root.
import { emitCoc } from "./emit-coc.mjs";
import { REPO as EMIT_REPO } from "./emit-cli-artifacts.mjs";

// --- Repo root resolution -----------------------------------------------

function findRepoRoot(startDir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || startDir;
  } catch {
    process.stderr.write(
      `validate-emit: warning: git rev-parse failed for cwd=${startDir}; scanning relative to cwd\n`,
    );
    return startDir;
  }
}

// --- Constants ----------------------------------------------------------

// Canonical Claude Code tool surface. `LS` is NOT in the set (issue #350
// Finding 6). `*` is the wildcard grant (the catch-all `claude` agent).
const CANONICAL_CC_TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task",
  "WebSearch", "WebFetch", "Skill", "Agent", "NotebookEdit", "*",
]);

// File-MUTATION tools a read-only specialist MUST NOT declare. Per agents.md
// § "Verify Specialist Tool Inventory", implementation delegation requires a
// specialist with `Edit` AND `Bash`; "read-only" means it cannot MUTATE files
// (no Edit/Write). Bash is NOT forbidden — reviewer/security-reviewer run
// read-only mechanical sweeps (`grep -c`, `pytest --collect-only`) that need
// Bash (agents.md § "Reviewer Mechanical Sweeps"). Task is sub-delegation, not
// file mutation. So the prohibition is exactly the two mutation tools.
const READONLY_FORBIDDEN_TOOLS = new Set(["Edit", "Write"]);

const COMMAND_LINE_CAP = 150; // cc-artifacts.md Rule 3 + command-authoring SKILL

// Commands intentionally exempt from the `---` frontmatter requirement.
// Empty by default; any entry MUST be documented in command-authoring/SKILL.md.
const COMMAND_FRONTMATTER_EXEMPT = new Set([]);

// A violation-pattern detector is any export matching this shape.
const DETECTOR_RE = /^detect[A-Z]/;

const CHECK_IDS = [
  "command-frontmatter",
  "command-line-cap",
  "readonly-specialist-tools",
  "tool-canonicality",
  "mirror-exclusion",
  "paths-annotation-consistency",
  "audit-fixture-coverage",
  "loom-only-mutual-exclusion",
  "provenance-parity",
  "coc-artifact-ids",
];

const STATUS = {
  PASS: "pass",
  FAIL: "fail",
  FIXTURE_NEEDED: "fixture-needed",
  SKIP: "skip",
};

// A finding blocks /sync iff it is FAIL or FIXTURE_NEEDED (and not allowed).
function isBlocking(status) {
  return status === STATUS.FAIL || status === STATUS.FIXTURE_NEEDED;
}

// --- Frontmatter parsing ------------------------------------------------

// Returns { hasFrontmatter, body, fields } where fields parses the simple
// YAML subset loom artifacts use: scalar `key: value` and `key:` + `- item`
// list blocks. Only the leading `---` … `---` block is parsed.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { hasFrontmatter: false, body: text, fields: {} };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Unterminated frontmatter — treat as none (structural; the check that
    // cares about frontmatter presence will still see line[0]==='---').
    return { hasFrontmatter: true, body: text, fields: {}, unterminated: true };
  }
  const fmLines = lines.slice(1, end);
  const fields = {};
  let currentListKey = null;
  for (const raw of fmLines) {
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && currentListKey) {
      const val = stripQuotes(listItem[1].trim());
      fields[currentListKey].push(val);
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (val === "") {
        // Could be a list header OR an empty scalar. Default to list.
        fields[key] = [];
        currentListKey = key;
      } else {
        fields[key] = stripQuotes(val);
        currentListKey = null;
      }
    }
  }
  const body = lines.slice(end + 1).join("\n");
  return { hasFrontmatter: true, body, fields };
}

function stripQuotes(s) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

// Parse a `tools:` value that may be an inline comma list (`Read, Edit`) or a
// YAML list block (parsed as array by parseFrontmatter). Returns string[].
function parseToolList(toolsField) {
  if (Array.isArray(toolsField)) return toolsField.map((t) => t.trim()).filter(Boolean);
  if (typeof toolsField === "string") {
    return toolsField
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

// --- File walkers -------------------------------------------------------

function listMarkdown(dir, depth = 0) {
  const out = [];
  // Security: bound recursion depth. A symlink-cycle is already blocked by the
  // isSymbolicLink() guard below, but a genuine on-disk deep tree (e.g. a
  // pathological skills/ layout) could still stack-overflow the walker
  // (security-reviewer R3 LOW-2 — unbounded-recursion DoS guard).
  if (depth > 20) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    // Security: never follow symlinks. A symlink-cycle (e.g. `commands/loop ->
    // ..`) would otherwise wedge /sync via unbounded recursion (security-reviewer
    // R1 M1 — symlink-cycle DoS guard).
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith(".")) continue;
      out.push(...listMarkdown(full, depth + 1));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function safeRead(file) {
  // Security: bound max file size at 10 MB. readFileSync on an unbounded file
  // (e.g. a multi-GB .md accidentally committed) would OOM the validator
  // (security-reviewer R3 LOW-1 — unbounded-input DoS guard). Oversize files
  // return null, matching the existing failure-mode semantics (callers treat
  // null as SKIP/error).
  try {
    const st = statSync(file);
    if (st.size > 10 * 1024 * 1024) return null;
  } catch {
    return null;
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// =======================================================================
//  CHECK 1 — command frontmatter
// =======================================================================
function checkCommandFrontmatter(root) {
  const id = "command-frontmatter";
  const dir = join(root, ".claude", "commands");
  const results = [];
  for (const f of listMarkdown(dir)) {
    const rel = relative(root, f);
    const name = basename(f);
    if (COMMAND_FRONTMATTER_EXEMPT.has(name)) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: "exempt" });
      continue;
    }
    const text = safeRead(f);
    if (text === null) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "unreadable" });
      continue;
    }
    // reviewer R1 #4: an unterminated frontmatter (`---` open, no close) consumes
    // the entire body — the validator must fail it explicitly, not silently PASS.
    const fmCheck = parseFrontmatter(text);
    if (fmCheck.unterminated) {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: "frontmatter open '---' but no closing '---' (parseFrontmatter would consume entire body)",
      });
      continue;
    }
    const first = text.split(/\r?\n/)[0];
    if (first === "---") {
      results.push({ artifact: rel, status: STATUS.PASS });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `first line is '${first.slice(0, 40)}' — expected '---' (command-authoring SKILL frontmatter requirement)`,
      });
    }
  }
  return { id, source_rule: "command-authoring SKILL", results };
}

// =======================================================================
//  CHECK 2 — command line cap (body after frontmatter <= 150)
// =======================================================================
function checkCommandLineCap(root) {
  const id = "command-line-cap";
  const dir = join(root, ".claude", "commands");
  const results = [];
  for (const f of listMarkdown(dir)) {
    const rel = relative(root, f);
    const text = safeRead(f);
    if (text === null) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "unreadable" });
      continue;
    }
    const { body } = parseFrontmatter(text);
    // Trailing newline produces one empty element; trim it for the count.
    const bodyLines = body.replace(/\n+$/, "").split(/\r?\n/).length;
    if (bodyLines <= COMMAND_LINE_CAP) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: `${bodyLines} body lines` });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `${bodyLines} body lines > ${COMMAND_LINE_CAP} (cc-artifacts.md Rule 3)`,
      });
    }
  }
  return { id, source_rule: "cc-artifacts.md Rule 3", results };
}

// =======================================================================
//  CHECK 3 — read-only specialist tool inventory
// =======================================================================
// Parse the read-only specialist list from agents.md verbatim
// ("Read-only specialists (`a`, `b`, ...)"), then assert each named agent's
// frontmatter `tools:` declares NONE of READONLY_FORBIDDEN_TOOLS.
function parseReadonlySpecialists(root) {
  const agentsRule = safeRead(join(root, ".claude", "rules", "agents.md"));
  if (agentsRule === null) return null;
  const m = agentsRule.match(/Read-only specialists\s*\(([^)]*)\)/);
  if (!m) return null;
  const names = [];
  for (const bt of m[1].matchAll(/`([a-z0-9-]+)`/g)) names.push(bt[1]);
  return names;
}

function findAgentFile(root, name) {
  const agentsDir = join(root, ".claude", "agents");
  for (const f of listMarkdown(agentsDir)) {
    if (basename(f) === `${name}.md`) return f;
  }
  return null;
}

function checkReadonlySpecialistTools(root) {
  const id = "readonly-specialist-tools";
  const results = [];
  const names = parseReadonlySpecialists(root);
  if (names === null) {
    return {
      id,
      source_rule: "agents.md § Verify Specialist Tool Inventory",
      results: [{ artifact: "rules/agents.md", status: STATUS.SKIP, detail: "could not parse read-only specialist list" }],
    };
  }
  for (const name of names) {
    const f = findAgentFile(root, name);
    if (!f) {
      results.push({ artifact: `agents/**/${name}.md`, status: STATUS.SKIP, detail: "agent file not found" });
      continue;
    }
    const rel = relative(root, f);
    const { fields } = parseFrontmatter(safeRead(f) || "");
    const tools = parseToolList(fields.tools);
    const forbidden = tools.filter((t) => READONLY_FORBIDDEN_TOOLS.has(t));
    if (forbidden.length === 0) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: `tools: ${tools.join(", ") || "(none)"}` });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `read-only specialist '${name}' declares implementation tools: ${forbidden.join(", ")} (agents.md classifies it read-only)`,
      });
    }
  }
  return { id, source_rule: "agents.md § Verify Specialist Tool Inventory", results };
}

// =======================================================================
//  CHECK 4 — tool-name canonicality
// =======================================================================
function checkToolCanonicality(root) {
  const id = "tool-canonicality";
  const dir = join(root, ".claude", "agents");
  const results = [];
  for (const f of listMarkdown(dir)) {
    const rel = relative(root, f);
    const text = safeRead(f);
    if (text === null) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "unreadable" });
      continue;
    }
    const { fields } = parseFrontmatter(text);
    if (fields.tools === undefined) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "no tools: frontmatter" });
      continue;
    }
    const tools = parseToolList(fields.tools);
    const bad = tools.filter((t) => !CANONICAL_CC_TOOLS.has(t));
    if (bad.length === 0) {
      results.push({ artifact: rel, status: STATUS.PASS });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `non-canonical tool(s): ${bad.join(", ")} — canonical set: ${[...CANONICAL_CC_TOOLS].filter((t) => t !== "*").join(", ")}`,
      });
    }
  }
  return { id, source_rule: "cc-artifacts.md (canonical CC tool set)", results };
}

// =======================================================================
//  CHECK 5 — mirror + exclusion completeness
// =======================================================================
// Parse cli_emit_exclusions from sync-manifest.yaml; for each CLI {codex,
// gemini} and each source artifact under skills/agents/commands, the artifact
// is EITHER excluded (matches an exclusion glob) OR must be present in the
// staged .{cli}/ tree at its mapped path. If the staged tree is absent (no
// emit run yet) the artifact is SKIP (informational), never FAIL.
function parseEmitExclusions(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const lines = manifest.split(/\r?\n/);
  const out = { codex: [], gemini: [] };
  let inBlock = false;
  let cli = null;
  for (const raw of lines) {
    if (/^cli_emit_exclusions:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // A new top-level key (no indent, ends with `:`) ends the block.
      if (/^[A-Za-z0-9_]+:/.test(raw)) {
        inBlock = false;
        continue;
      }
      const cliHdr = raw.match(/^  ([A-Za-z0-9_]+):\s*$/);
      if (cliHdr) {
        cli = cliHdr[1];
        if (!out[cli]) out[cli] = [];
        continue;
      }
      const item = raw.match(/^\s+-\s+(.*)$/);
      if (item && cli && out[cli]) out[cli].push(item[1].trim());
    }
  }
  return out;
}

function matchesGlob(relPath, glob) {
  // Support exact match and trailing `/**` prefix match (the only forms used
  // in cli_emit_exclusions).
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return relPath === prefix || relPath.startsWith(prefix + "/");
  }
  return relPath === glob;
}

// --- loom_only / tiers parsing (check 8) -------------------------------

// Parse the top-level FLAT `loom_only:` glob list (F104). Same shape as
// `obsoleted:` / `exclude:`: a top-level key whose body is `- <glob>`
// entries at 2-space indent, no nested CLI sub-keys. Returns string[] (may
// be empty) or null when the manifest is unreadable.
function parseLoomOnly(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const out = [];
  let inBlock = false;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^loom_only:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A new top-level key (no indent, ends with `:`) ends the block.
    if (/^[A-Za-z0-9_-]+:\s*$/.test(raw) && !raw.startsWith(" ")) break;
    const item = raw.match(/^ {2}-\s*(.+?)\s*$/);
    if (item) {
      const v = item[1].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// Parse the `tiers:` block into { tier: [glob, ...] }. 2-space tier key →
// 4-space `- glob` entries. Returns {} when absent / unreadable.
function parseTiers(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return {};
  const tiers = {};
  let inBlock = false;
  let cur = null;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^tiers:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^[A-Za-z0-9_-]+:\s*$/.test(raw) && !raw.startsWith(" ")) break;
    const tierHdr = raw.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (tierHdr) {
      cur = tierHdr[1];
      tiers[cur] = [];
      continue;
    }
    const item = raw.match(/^ {4}-\s*(.+?)\s*$/);
    if (item && cur) {
      const v = item[1].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
      if (v) tiers[cur].push(v);
    }
  }
  return tiers;
}

// Does `relPath` (manifest-relative, e.g. `agents/management/coc-sync.md`)
// match `glob`? Supports exact + trailing `/**` (matchesGlob) AND a bare
// glob authored WITH a leading `.claude/` is tolerated by stripping it. The
// path-shape both stanzas use is bare (`agents/...`), so a literal compare
// suffices for the common case; `/**` handles directory-prefix tier globs.
function loomGlobMatch(relPath, glob) {
  const g = glob.startsWith(".claude/") ? glob.slice(".claude/".length) : glob;
  return matchesGlob(relPath, g);
}

// Emit a FRESH per-CLI tree via emit-cli-artifacts.mjs --out <tmp>, so the
// mirror check compares against what the emitter ACTUALLY produces — not a
// possibly-stale checked-in .codex/.gemini tree, and not a hand-rolled path
// mapping that drifts from the emitter's real layout. Returns
// { ok, dir, error }. The caller MUST rmSync(dir) when done.
function emitFresh(root) {
  const dir = mkdtempSync(join(tmpdir(), "validate-emit-"));
  try {
    execFileSync(
      "node",
      [join(root, ".claude", "bin", "emit-cli-artifacts.mjs"), "--out", dir],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, dir, error: e && e.stderr ? String(e.stderr) : String(e && e.message) };
  }
}

// Is source artifact `art` present in the freshly-emitted `<emitDir>/<cli>/`
// tree? Detection matches the emitter's real layout (emit-cli-artifacts.mjs):
//   skill   skills/<n>     → <cli>/skills/<n>            (dir)
//   command commands/<n>.md→ codex prompts/<n>.md | gemini commands/<n>.toml
//   agent   agents/.../<n>.md → codex prompts/* containing <n> | gemini agents/<n>.md
// Agent codex naming is emitter-decided (a promptName), so codex-agent presence
// is a stem-contains scan of the prompts/ dir — robust to the emitter's choice.
function presentInEmit(emitDir, cli, art) {
  const base = join(emitDir, cli);
  if (art.kind === "skill") {
    return existsSync(join(base, "skills", basename(art.rel)));
  }
  if (art.kind === "command") {
    const stem = basename(art.rel, ".md");
    if (cli === "codex") return existsSync(join(base, "prompts", `${stem}.md`));
    return existsSync(join(base, "commands", `${stem}.toml`));
  }
  if (art.kind === "agent") {
    const stem = basename(art.rel, ".md");
    if (cli === "gemini") return existsSync(join(base, "agents", `${stem}.md`));
    // codex: scan prompts/ for any emitted file whose name contains the stem.
    const promptsDir = join(base, "prompts");
    let entries;
    try {
      entries = readdirSync(promptsDir);
    } catch {
      return false;
    }
    return entries.some((n) => n.endsWith(".md") && n.includes(stem));
  }
  return false;
}

function collectSourceArtifacts(root) {
  // Returns manifest-relative paths for skills (dir), commands (md), agents (md).
  const arts = [];
  // skills: one entry per skill dir (presence of the dir is what's emitted)
  const skillsDir = join(root, ".claude", "skills");
  try {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue; // security-reviewer R1 M1 — no symlink follow
      if (e.isDirectory() && !e.name.startsWith(".")) {
        arts.push({ kind: "skill", rel: `skills/${e.name}` });
      }
    }
  } catch { /* no skills dir */ }
  for (const f of listMarkdown(join(root, ".claude", "commands"))) {
    const b = basename(f);
    if (b.startsWith("_")) continue; // _README etc. are not emittable artifacts
    arts.push({ kind: "command", rel: `commands/${b}` });
  }
  for (const f of listMarkdown(join(root, ".claude", "agents"))) {
    if (basename(f).startsWith("_")) continue; // _README is not an agent
    arts.push({ kind: "agent", rel: relative(join(root, ".claude"), f) });
  }
  return arts;
}

function checkMirrorExclusion(root, opts) {
  const id = "mirror-exclusion";
  const exclusions = parseEmitExclusions(root);
  const results = [];
  if (exclusions === null) {
    return {
      id,
      source_rule: "sync-manifest.yaml cli_emit_exclusions",
      results: [{ artifact: "sync-manifest.yaml", status: STATUS.SKIP, detail: "manifest unreadable" }],
    };
  }
  // Compare against a FRESH emit. Prefer a caller-supplied --emit-dir (the tree
  // /sync just produced); otherwise emit into a temp dir ourselves.
  let emitDir = (opts && opts.emitDir) || null;
  let ownEmit = null;
  if (!emitDir) {
    ownEmit = emitFresh(root);
    if (!ownEmit.ok) {
      return {
        id,
        source_rule: "sync-manifest.yaml cli_emit_exclusions",
        results: [
          {
            artifact: "(emit)",
            status: STATUS.SKIP,
            detail: `could not run emit-cli-artifacts.mjs: ${(ownEmit.error || "").slice(0, 200)}`,
          },
        ],
      };
    }
    emitDir = ownEmit.dir;
  }
  try {
    // SCOPE (v1): skills only. Skills emit uniformly to `<cli>/skills/<name>`
    // for every CLI, so "mirror to all trees unless excluded" holds cleanly and
    // matches issue #350 Finding 7 (a skill drop). Commands and agents have
    // CLI-divergent emit shapes + richer structural skips (codex strips the
    // `-specialist` suffix → `specialist-<short>.md`; `_README`, architects, and
    // management agents are skipped by emitter logic, not just literal
    // cli_emit_exclusions). Re-deriving that here produces false positives; the
    // correct extension is an emitter-side `--report-json` reconciliation the
    // validator consumes (tracked as the check-5 follow-up). Management agents
    // are loom-only and never emitted.
    const arts = collectSourceArtifacts(root).filter(
      (a) => a.kind === "skill" && !a.rel.startsWith("agents/management/"),
    );
    for (const cli of ["codex", "gemini"]) {
      const excl = exclusions[cli] || [];
      for (const a of arts) {
        const tag = `${cli}:${a.rel}`;
        if (excl.some((g) => matchesGlob(a.rel, g))) {
          results.push({ artifact: tag, status: STATUS.PASS, detail: "excluded (declared)" });
          continue;
        }
        if (presentInEmit(emitDir, cli, a)) {
          results.push({ artifact: tag, status: STATUS.PASS });
        } else {
          results.push({
            artifact: tag,
            status: STATUS.FAIL,
            detail: `not emitted to ${cli} and not in cli_emit_exclusions.${cli} — undeclared drop (issue #350 Finding 7)`,
          });
        }
      }
    }
  } finally {
    if (ownEmit && ownEmit.dir) {
      try {
        rmSync(ownEmit.dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
  return { id, source_rule: "sync-manifest.yaml cli_emit_exclusions", results };
}

// =======================================================================
//  CHECK 6 — paths-glob ↔ Rules-Index annotation consistency
// =======================================================================
// In the emitted baseline surfaces (CLAUDE.md / AGENTS.md / GEMINI.md) a rule
// MAY be annotated with a path glob in its Rules-Index row. When it is, the
// rule's own `paths:` frontmatter MUST include that glob. Loom's own Rules
// Index carries no per-rule glob annotations, so this check is typically a
// vacuous PASS at loom and a live regression-lock for downstream USE templates
// whose CLAUDE.md does carry annotations (issue #350 Finding 3).
const RS_GLOB_RE = /\*\*\/\*\.(rs|py|rb|ts|js)\b/g;

function checkPathsAnnotationConsistency(root) {
  const id = "paths-annotation-consistency";
  const results = [];
  const indexFiles = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
    .map((f) => join(root, f))
    .filter(existsSync);
  if (indexFiles.length === 0) {
    return {
      id,
      source_rule: "cross-cli-parity (Rules-Index annotation)",
      results: [{ artifact: "CLAUDE.md", status: STATUS.SKIP, detail: "no baseline index file" }],
    };
  }
  let anyAnnotation = false;
  for (const idxFile of indexFiles) {
    const text = safeRead(idxFile);
    if (text === null) continue;
    const idxRel = relative(root, idxFile);
    for (const line of text.split(/\r?\n/)) {
      // A Rules-Index row may name MULTIPLE rule files with one shared glob
      // (e.g. "`rules/A.md` and `rules/B.md` | **/*.rs |"). Use matchAll so
      // every rule on the row is checked (reviewer R1 #1 — silent-drop on
      // 2nd+ rule per row was the original `.match` defect).
      const ruleRefs = [...line.matchAll(/`((?:\.claude\/)?rules\/[A-Za-z0-9_.-]+\.md)`/g)];
      const globs = [...line.matchAll(RS_GLOB_RE)].map((m) => m[0]);
      if (ruleRefs.length === 0 || globs.length === 0) continue;
      anyAnnotation = true;
      for (const ruleRef of ruleRefs) {
        const ruleRel = ruleRef[1].replace(/^\.claude\//, "");
        const rulePath = join(root, ".claude", ruleRel);
        const ruleText = safeRead(rulePath);
        if (ruleText === null) {
          results.push({ artifact: `${idxRel} → ${ruleRel}`, status: STATUS.FAIL, detail: "annotated rule file not found" });
          continue;
        }
        const { fields } = parseFrontmatter(ruleText);
        const paths = Array.isArray(fields.paths) ? fields.paths : [];
        const missing = globs.filter((g) => !paths.includes(g));
        if (missing.length === 0) {
          results.push({ artifact: `${idxRel} → ${ruleRel}`, status: STATUS.PASS });
        } else {
          results.push({
            artifact: `${idxRel} → ${ruleRel}`,
            status: STATUS.FAIL,
            detail: `Rules-Index annotates ${missing.join(", ")} but rule paths: lacks it (issue #350 Finding 3)`,
          });
        }
      }
    }
  }
  if (!anyAnnotation) {
    results.push({ artifact: "(rules-index)", status: STATUS.SKIP, detail: "no per-rule path-glob annotations in baseline index" });
  }
  return { id, source_rule: "cross-cli-parity (Rules-Index annotation)", results };
}

// =======================================================================
//  CHECK 7 — audit-fixture coverage
// =======================================================================
// Every `detect*` export in violation-patterns.js MUST have an audit-fixture
// dir with >=1 flag fixture AND >=1 clean fixture (cc-artifacts.md Rule 9 +
// hook-output-discipline.md MUST-4). Detector enumeration is a positive
// allowlist (the `detect*` name shape) per cc-artifacts.md Rule 10.
function enumerateDetectors(root) {
  const vp = safeRead(join(root, ".claude", "hooks", "lib", "violation-patterns.js"));
  if (vp === null) return null;
  // Parse the module.exports { ... } block; collect identifiers matching detect*.
  const exp = vp.match(/module\.exports\s*=\s*{([\s\S]*?)}/);
  const names = new Set();
  const scope = exp ? exp[1] : vp;
  for (const m of scope.matchAll(/\b(detect[A-Z][A-Za-z0-9]*)\b/g)) names.add(m[1]);
  return [...names];
}

function classifyFixtures(dir) {
  // Returns { flag, clean } counts based on filename convention.
  let flag = 0;
  let clean = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name.toLowerCase();
    if (n.includes("expected")) continue; // expected-output sidecars
    // reviewer R1 #2: strict prefix only. Previously a broader regex (`bad`,
    // `safe`, `dirty`, etc.) classified names like `clean-flag.txt` as flag,
    // silently turning "missing clean fixture" into a green PASS. The loom
    // convention is `^flag-` / `^clean-` per the #354 fixture set.
    if (/^flag[-_.]/.test(n)) flag++;
    else if (/^clean[-_.]/.test(n)) clean++;
  }
  return { flag, clean };
}

function checkAuditFixtureCoverage(root) {
  const id = "audit-fixture-coverage";
  const detectors = enumerateDetectors(root);
  if (detectors === null) {
    return {
      id,
      source_rule: "cc-artifacts.md Rule 9 / hook-output-discipline.md MUST-4",
      results: [{ artifact: "hooks/lib/violation-patterns.js", status: STATUS.SKIP, detail: "violation-patterns.js unreadable" }],
    };
  }
  const fixtureBase = join(root, ".claude", "audit-fixtures", "violation-patterns");
  const results = [];
  for (const det of detectors.sort()) {
    const dir = join(fixtureBase, det);
    const counts = classifyFixtures(dir);
    if (counts === null) {
      results.push({
        artifact: `violation-patterns/${det}`,
        status: STATUS.FIXTURE_NEEDED,
        detail: "no audit-fixture dir (issue #350 Finding 5)",
      });
    } else if (counts.flag >= 1 && counts.clean >= 1) {
      results.push({ artifact: `violation-patterns/${det}`, status: STATUS.PASS, detail: `${counts.flag} flag / ${counts.clean} clean` });
    } else {
      results.push({
        artifact: `violation-patterns/${det}`,
        status: STATUS.FIXTURE_NEEDED,
        detail: `needs >=1 flag + >=1 clean (have ${counts.flag} flag / ${counts.clean} clean)`,
      });
    }
  }
  return { id, source_rule: "cc-artifacts.md Rule 9 / hook-output-discipline.md MUST-4", results };
}

// Check 8 — loom-only mutual exclusion (F104).
//   FAIL  a loom_only glob that ALSO appears as a tier entry (any tier) —
//         a path declared never-sync but also tier-listed would be both
//         emitted (by tier) and never-emitted (by loom_only); the manifest
//         contradicts itself. Blocks /sync.
//   FIXTURE_NEEDED  (WARN, non-blocking would be ideal but the status taxonomy
//         only has pass/fail/fixture-needed/skip; per the F104 spec a
//         zero-match glob is a WARN, NOT a block) → emitted as `skip` with a
//         "WARN:" detail so it surfaces without blocking /sync.
//   PASS  a loom_only glob that matches >=1 on-disk file AND is in no tier.
function checkLoomOnlyMutualExclusion(root) {
  const id = "loom-only-mutual-exclusion";
  const source_rule = "sync-manifest.yaml loom_only (F104) / cross-repo.md Rule 4";
  const loomOnly = parseLoomOnly(root);
  if (loomOnly === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: "sync-manifest.yaml", status: STATUS.SKIP, detail: "manifest unreadable" }],
    };
  }
  if (loomOnly.length === 0) {
    return {
      id,
      source_rule,
      results: [{ artifact: "loom_only", status: STATUS.SKIP, detail: "no loom_only entries declared" }],
    };
  }
  const tiers = parseTiers(root);
  // Flatten every tier's globs with the owning tier name (any tier is synced —
  // every tier is subscribed by >=1 repo per repos.<t>.tier_subscriptions).
  const tierEntries = [];
  for (const [tier, globs] of Object.entries(tiers)) {
    for (const g of globs) tierEntries.push({ tier, glob: g });
  }
  const results = [];
  for (const lo of loomOnly) {
    // (a) mutual-exclusion: loom_only glob collides with a synced-tier glob.
    const collisions = tierEntries.filter(
      (t) => t.glob === lo || loomGlobMatch(t.glob.replace(/^\.claude\//, ""), lo) || loomGlobMatch(lo, t.glob),
    );
    if (collisions.length > 0) {
      const where = collisions.map((c) => `${c.tier}:${c.glob}`).join(", ");
      results.push({
        artifact: lo,
        status: STATUS.FAIL,
        detail: `loom_only path is ALSO in synced tier(s) ${where} — a never-sync artifact cannot be tier-listed (mutual-exclusion violation)`,
      });
      continue;
    }
    // (b) zero-match WARN: glob matches no on-disk file. Non-blocking — emit
    // as SKIP with a WARN: prefix so it surfaces without halting /sync.
    const candidate = join(root, ".claude", lo);
    const exists = existsSync(candidate) || (lo.endsWith("/**") && existsSync(join(root, ".claude", lo.slice(0, -3))));
    if (!exists) {
      results.push({
        artifact: lo,
        status: STATUS.SKIP,
        detail: `WARN: loom_only glob matches 0 on-disk files (stale entry? verify the path)`,
      });
      continue;
    }
    results.push({ artifact: lo, status: STATUS.PASS, detail: "never-sync, in no synced tier, matches on-disk file" });
  }
  return { id, source_rule, results };
}

// =======================================================================
//  CHECK 9 — provenance-event cross-CLI parity (F101-4 / loom#411 item 5)
// =======================================================================
// The CC lane captures provenance events (the F101-2 hooks) of the closed
// taxonomy EVENT_KINDS {HumanInput, Action, Decision, Delegation}. This check
// enforces that EVERY kind CC actually captures carries an EXPLICIT cross-CLI
// parity declaration for each target lane (codex, gemini) in the manifest's
// `provenance_parity` block — either `wired` (validator asserts the named hook
// is registered in that lane's emit target) or `deferred` (an explicit, tracked
// known gap, #NNN required). A captured kind with NO declaration for a lane is a
// SILENT DROP → FAIL (the failure mode #408 blocks). Source of truth for the
// captured-kind set is the HOOKS, not the declaration: the kinds are extracted
// from the capture-hook sources and byte-compared (canonicalSerialize, the
// csq-seam serializer) against the declared cc_capture set — drift is a hard
// finding. Structural per probe-driven-verification.md MUST-3 (no LLM).

// Target lanes = the non-cc CLIs of parity_enforcement.required_coverage.hooks.
// Stable set; mirrors cli-drift-audit.mjs CLIS minus the reference lane.
const PROVENANCE_TARGET_LANES = ["codex", "gemini"];
const PROVENANCE_KIND_SET = new Set(EVENT_KINDS);

// Parse the `provenance_parity:` block (a 2-space child of parity_enforcement)
// with a line-oriented state machine (the parseEmitExclusions idiom — no YAML
// dep). cc_capture / lanes list items are pipe-delimited single strings:
//   cc_capture:  "<kind>|<hook-file>|<cc-event>"
//   lanes (deferred): "<lane>|<kind>|deferred|<#tracking>|<reason…>"
//   lanes (wired):    "<lane>|<kind>|wired|<hook-file>|<lane-event>"
// Returns { present, enabled, ccCapture[], lanes[] } or null when absent.
function parseProvenanceParity(manifestText) {
  if (manifestText == null) return null;
  const lines = manifestText.split(/\r?\n/);
  let inBlock = false;
  let section = null; // "cc_capture" | "lanes"
  const out = { present: false, enabled: false, ccCapture: [], lanes: [] };
  for (const raw of lines) {
    if (/^  provenance_parity:\s*$/.test(raw)) {
      inBlock = true;
      out.present = true;
      continue;
    }
    if (!inBlock) continue;
    // Terminate on a 2-space-or-less alphabetic key (a sibling/parent key such
    // as `tiers:` at col 0). Comments (`#`), list items, and blanks do not end
    // the block.
    if (/^ {0,2}[A-Za-z_]/.test(raw)) {
      inBlock = false;
      continue;
    }
    const enabledM = raw.match(/^    enabled:\s*(true|false)\s*$/);
    if (enabledM) {
      out.enabled = enabledM[1] === "true";
      // Do NOT reset `section` here — `enabled:` is a scalar key and must not
      // drop the list items of a section it happens to follow if a future
      // hand-edit reorders fields (reviewer R1 LOW).
      continue;
    }
    if (/^    cc_capture:\s*$/.test(raw)) {
      section = "cc_capture";
      continue;
    }
    if (/^    lanes:\s*$/.test(raw)) {
      section = "lanes";
      continue;
    }
    const item = raw.match(/^\s+-\s+"([^"]*)"\s*$/);
    if (item && section) {
      const parts = item[1].split("|");
      if (section === "cc_capture") {
        out.ccCapture.push({
          kind: parts[0] || "",
          hook: parts[1] || "",
          event: parts[2] || "",
          raw: item[1],
        });
      } else {
        out.lanes.push({
          lane: parts[0] || "",
          kind: parts[1] || "",
          status: parts[2] || "",
          // f4 = #tracking (deferred) | hook-file (wired)
          // f5 = reason (deferred)    | lane-event (wired); reason may contain `|`
          f4: parts[3] || "",
          f5: parts.slice(4).join("|"),
          raw: item[1],
        });
      }
    }
  }
  return out.present ? out : null;
}

// Extract the kind: "<X>" string literals actually emitted by the declared CC
// capture hooks (the source of truth). `kind: classified.kind` (identifier, no
// quote) is intentionally not matched. Returns { kinds:Set, byHook:Map, errors }.
function extractHookKinds(root, ccCapture) {
  const errors = [];
  const kinds = new Set();
  const byHook = new Map();
  const hookFiles = [...new Set((ccCapture || []).map((c) => c.hook).filter(Boolean))];
  for (const hf of hookFiles) {
    const src = safeRead(join(root, ".claude", "hooks", hf));
    if (src === null) {
      errors.push(`cc_capture hook '${hf}' not found at .claude/hooks/${hf}`);
      continue;
    }
    // Strip JS comments BEFORE matching so a doc-comment `kind: "X"` neither
    // injects a phantom kind (over-match) NOR masks a real drift by supplying a
    // kind the code does not emit — a comment listing all 4 kinds in a hook whose
    // code returns 3 would otherwise hide the regression (security R1 MED). Accept
    // double / single / backtick quote forms so a non-double-quote emission is
    // still extracted; a MISSED emission would drop a kind silently, whereas an
    // extracted-but-different kind surfaces as a loud byte-drift FAIL (reviewer R1 MED).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const found = new Set();
    for (const m of code.matchAll(/\bkind:\s*["'`]([A-Za-z]+)["'`]/g)) found.add(m[1]);
    byHook.set(hf, found);
    for (const k of found) kinds.add(k);
  }
  return { kinds, byHook, errors };
}

// Pure evaluator — no IO. `laneHookPresent(lane, hookFile) => bool` is the
// emit-target presence oracle (injected so tests/fixtures drive it). Returns the
// validate-emit results[] array.
function evaluateProvenanceParity({ block, extraction, laneHookPresent, hookEmitsKind }) {
  const MANIFEST = "sync-manifest.yaml::provenance_parity";
  if (!block) {
    return [
      {
        artifact: MANIFEST,
        status: STATUS.FAIL,
        detail:
          "provenance_parity block absent from sync-manifest.yaml (F101-4 / #411 item 5) — provenance capture has no declared cross-CLI parity contract",
      },
    ];
  }
  if (!block.enabled) {
    return [{ artifact: MANIFEST, status: STATUS.SKIP, detail: "provenance_parity.enabled=false" }];
  }
  const results = [];

  // (a) cc_capture must be non-empty when enabled.
  if (!block.ccCapture.length) {
    results.push({
      artifact: MANIFEST,
      status: STATUS.FAIL,
      detail: "provenance_parity.enabled=true but cc_capture is empty — no reference capture surface declared",
    });
  }

  // (b) declared cc_capture hook IO errors (missing/unreadable hook file).
  for (const e of extraction.errors) {
    results.push({ artifact: MANIFEST, status: STATUS.FAIL, detail: e });
  }

  // (c) every hook-emitted kind MUST be in the closed taxonomy EVENT_KINDS.
  for (const k of extraction.kinds) {
    if (!PROVENANCE_KIND_SET.has(k)) {
      results.push({
        artifact: `hook-kind:${k}`,
        status: STATUS.FAIL,
        detail: `capture hook emits kind "${k}" outside provenance-event.js::EVENT_KINDS [${EVENT_KINDS.join(", ")}]`,
      });
    }
  }

  // (d) each declared cc_capture entry must be backed by its hook + in-taxonomy.
  const declaredKinds = new Set();
  for (const c of block.ccCapture) {
    declaredKinds.add(c.kind);
    if (!PROVENANCE_KIND_SET.has(c.kind)) {
      results.push({
        artifact: `cc_capture:${c.kind}`,
        status: STATUS.FAIL,
        detail: `cc_capture declares kind "${c.kind}" outside EVENT_KINDS`,
      });
      continue;
    }
    const hookKinds = extraction.byHook.get(c.hook);
    if (hookKinds && !hookKinds.has(c.kind)) {
      results.push({
        artifact: `cc_capture:${c.kind}`,
        status: STATUS.FAIL,
        detail: `cc_capture maps ${c.kind} → ${c.hook} but that hook emits no kind: "${c.kind}" literal`,
      });
    }
  }

  // (e) byte-exact drift: declared cc_capture kind set vs hook-extracted set.
  // Arrays sorted before canonicalSerialize (it preserves array order; only
  // object keys are sorted). Compared as the csq-signable bytes (Buffer.equals).
  const declaredSorted = [...declaredKinds].sort();
  const extractedSorted = [...extraction.kinds].filter((k) => PROVENANCE_KIND_SET.has(k)).sort();
  const declBytes = canonicalSerialize(declaredSorted);
  const extrBytes = canonicalSerialize(extractedSorted);
  if (!declBytes.equals(extrBytes)) {
    results.push({
      artifact: MANIFEST,
      status: STATUS.FAIL,
      detail: `cc_capture kind set drifts from hook-emitted kinds (byte-exact seam): declared=${declBytes.toString(
        "utf8",
      )} hooks=${extrBytes.toString("utf8")}`,
    });
  }

  // The kinds parity is enforced over = hook-extracted (the source of truth);
  // fall back to declared if extraction yielded nothing (so a missing-hook
  // config still reports lane coverage rather than silently passing).
  const capturedKinds = extractedSorted.length ? extractedSorted : declaredSorted;

  // index + orphan-lane-decl check.
  const laneIndex = new Map();
  for (const cell of block.lanes) {
    laneIndex.set(`${cell.lane}|${cell.kind}`, cell);
    if (!PROVENANCE_TARGET_LANES.includes(cell.lane)) {
      results.push({
        artifact: `lanes:${cell.raw}`,
        status: STATUS.FAIL,
        detail: `lane "${cell.lane}" is not a target lane [${PROVENANCE_TARGET_LANES.join(", ")}]`,
      });
    } else if (!capturedKinds.includes(cell.kind)) {
      results.push({
        artifact: `lanes:${cell.raw}`,
        status: STATUS.FAIL,
        detail: `lanes declares parity for kind "${cell.kind}" which CC does not capture`,
      });
    }
  }

  // (f) per (target lane × captured kind): require an explicit declaration.
  for (const lane of PROVENANCE_TARGET_LANES) {
    for (const kind of capturedKinds) {
      const cell = laneIndex.get(`${lane}|${kind}`);
      const art = `${lane}:${kind}`;
      if (!cell) {
        results.push({
          artifact: art,
          status: STATUS.FAIL,
          detail: `SILENT DROP: CC captures provenance kind "${kind}" but ${lane} has no provenance_parity declaration (wired|deferred) — #408 no-silent-drops`,
        });
        continue;
      }
      if (cell.status === "deferred") {
        // f4 IS the tracking ref (one pipe-delimited field) — require the WHOLE
        // field to be `#NNN`, not merely contain it, so `see #1` / embedded-digit
        // noise is rejected (security R1 LOW).
        if (!/^#\d+$/.test(cell.f4 || "")) {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `deferred declaration MUST carry a #NNN tracking ref (got "${cell.f4}") — value-prioritization.md MUST-2`,
          });
        } else {
          results.push({
            artifact: art,
            status: STATUS.SKIP,
            detail: `deferred (tracked ${cell.f4}): ${cell.f5 || "(no reason given)"}`,
          });
        }
      } else if (cell.status === "wired") {
        const hook = cell.f4 || "";
        // The wired hook field MUST be a bare hook filename. Without this gate the
        // presence oracle's match could be satisfied by a generic token (".js" /
        // "node" / "hooks") present in every command string — a manifest-edit
        // false-pass that defeats the wired guarantee (security R1 HIGH). The
        // filename-shape constraint + segment-exact presence match (laneHookPresent)
        // are the two halves of that fix; an empty f4 fails the shape here too
        // (reviewer R1 LOW empty-f4 case).
        if (!/^[A-Za-z0-9_-]+\.js$/.test(hook)) {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `wired declaration field 4 must be a bare hook filename matching /^[A-Za-z0-9_-]+\\.js$/; got "${hook}"`,
          });
        } else if (!laneHookPresent(lane, hook)) {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `declared wired → "${hook}" but that hook is NOT registered in the ${lane} emit target (.${lane}/...)`,
          });
        } else if (!hookEmitsKind(hook, kind)) {
          // Registration alone is insufficient: a wired cell could name ANY
          // registered hook (e.g. validate-bash-command.js, the Bash tripwire)
          // that emits ZERO provenance kinds — a visible-but-wrong PASS asserting
          // capture-wiring that does not exist (security R2 MED). A wired capture
          // MUST name a `.claude/hooks/*.js` that ACTUALLY emits the declared kind.
          // BOUNDARY: a future Codex/Gemini capture mechanism that is NOT a
          // `.claude/hooks/*.js` (e.g. the codex-mcp-guard) is not a JS hook with a
          // `kind:"X"` literal — wiring it MUST extend this contract under #411
          // item-1 (the manifest is on the self-referential-codify gate, so that
          // extension runs through mandatory multi-agent redteam). Until then this
          // fails loud rather than false-passing.
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `declared wired → "${hook}" is registered in the ${lane} emit target but does NOT emit provenance kind "${kind}" (not a capture hook for this kind; a wired capture MUST name a .claude/hooks/*.js that emits the kind — non-hooks mechanisms must extend the contract per #411 item-1)`,
          });
        } else {
          results.push({
            artifact: art,
            status: STATUS.PASS,
            detail: `wired → ${hook}${cell.f5 ? ` (${cell.f5})` : ""} registered in ${lane} emit target AND emits ${kind}`,
          });
        }
      } else {
        results.push({
          artifact: art,
          status: STATUS.FAIL,
          detail: `unknown status "${cell.status}" for ${art} (expected wired|deferred)`,
        });
      }
    }
  }

  return results;
}

// Collect every `command` string value from a hook-registration JSON document
// (codex hooks.json / gemini settings.json). Returns [] on parse failure (a
// malformed emit target cannot satisfy a `wired` parity assertion).
function collectHookCommands(jsonText) {
  if (jsonText == null) return [];
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const cmds = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "command" && typeof v === "string") cmds.push(v);
        else walk(v);
      }
    }
  };
  walk(doc);
  return cmds;
}

// IO wrapper: load manifest + hooks + emit targets, build the presence oracle,
// delegate to the pure evaluator.
function checkProvenanceParity(root) {
  const id = "provenance-parity";
  const source_rule = "cross-cli-parity.md + loom#411 item 5 (F101-4)";
  const block = parseProvenanceParity(safeRead(join(root, ".claude", "sync-manifest.yaml")));
  const extraction = extractHookKinds(root, block ? block.ccCapture : []);
  const codexCmds = collectHookCommands(safeRead(join(root, ".codex", "hooks.json")));
  const geminiCmds = collectHookCommands(safeRead(join(root, ".gemini", "settings.json")));
  const laneHookPresent = (lane, hookFile) => {
    if (!hookFile) return false;
    const cmds = lane === "codex" ? codexCmds : lane === "gemini" ? geminiCmds : [];
    // Segment-exact match (NOT a raw substring): split each command on path
    // separators / whitespace / quotes and require an exact path-segment equal to
    // hookFile. A raw `.includes(hookFile)` lets a generic f4 token (".js"/"node")
    // false-pass (security R1 HIGH); the wired branch additionally constrains f4 to
    // a `*.js` filename shape, so this segment match is the second half of the fix.
    return cmds.some((c) => c.split(/[\s/"']+/).includes(hookFile));
  };
  // Does the named hook file actually EMIT the provenance kind? Reuses the same
  // hook-source extraction as the cc_capture source-of-truth (security R2 MED — a
  // wired hook must be a real capture hook for the kind, not just any registered
  // hook). A hook absent from .claude/hooks/ emits nothing → false → wired FAILs.
  const hookEmitsKind = (hookFile, kind) => {
    if (!/^[A-Za-z0-9_-]+\.js$/.test(hookFile)) return false;
    const ex = extractHookKinds(root, [{ hook: hookFile }]);
    const set = ex.byHook.get(hookFile);
    return !!(set && set.has(kind));
  };
  const results = evaluateProvenanceParity({ block, extraction, laneHookPresent, hookEmitsKind });
  return { id, source_rule, results };
}

// Check 10 — `.coc/` artifact-id soundness (#392).
//   FAIL  the .coc/ emitter throws: a source artifact name derives to an
//         invalid id (spec §9.2.1, e.g. >33 chars) OR two names collide on one
//         id within a kind (spec §9.4.2 — csq hard-errors coc.duplicate_id).
//   SKIP+WARN  an emitted file exceeds the 60 KiB producer budget. spec-09
//         imposes NO consumer-side size cap, so this is a producer-quality
//         WARN, NOT a /sync block (emitting a truncated body would lose
//         load-bearing content per zero-tolerance.md Rule 2/6).
//   PASS  the .coc/ tree emits cleanly.
//   SKIP  validate-emit pointed at a non-loom root (emitCoc reads the loom
//         checkout; the check is meaningful only there).
function checkCocArtifactIds(root) {
  const id = "coc-artifact-ids";
  const source_rule = "issue #392 / spec-09 §9.2.1 + §9.4.2 (governance.csq)";
  if (resolve(root) !== EMIT_REPO) {
    return {
      id,
      source_rule,
      results: [{ artifact: ".coc/", status: STATUS.SKIP, detail: "runs against the loom checkout only" }],
    };
  }
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "validate-coc-"));
    const r = emitCoc({ outDir: tmp });
    const results = [
      {
        artifact: ".coc/",
        status: STATUS.PASS,
        detail: `${r.records} artifacts (rules=${r.counts.rules} agents=${r.counts.agents} skills=${r.counts.skills} commands=${r.counts.commands})`,
      },
    ];
    for (const w of r.warnOversize) {
      results.push({
        artifact: w.relInCoc,
        status: STATUS.SKIP,
        detail: `WARN: ${w.bytes}B > 60KiB producer budget — emitted, not truncated (spec-09 has no consumer cap)`,
      });
    }
    return { id, source_rule, results };
  } catch (err) {
    return {
      id,
      source_rule,
      results: [{ artifact: ".coc/", status: STATUS.FAIL, detail: String((err && err.message) || err) }],
    };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Orchestration ------------------------------------------------------

const CHECK_FNS = {
  "command-frontmatter": checkCommandFrontmatter,
  "command-line-cap": checkCommandLineCap,
  "readonly-specialist-tools": checkReadonlySpecialistTools,
  "tool-canonicality": checkToolCanonicality,
  "mirror-exclusion": checkMirrorExclusion,
  "paths-annotation-consistency": checkPathsAnnotationConsistency,
  "audit-fixture-coverage": checkAuditFixtureCoverage,
  "loom-only-mutual-exclusion": checkLoomOnlyMutualExclusion,
  "provenance-parity": checkProvenanceParity,
  "coc-artifact-ids": checkCocArtifactIds,
};

function runChecks(root, only, opts) {
  const ids = only && only.length ? only : CHECK_IDS;
  const checks = [];
  for (const id of ids) {
    const fn = CHECK_FNS[id];
    if (!fn) {
      process.stderr.write(`validate-emit: unknown check '${id}'\n`);
      process.exit(2);
    }
    checks.push(fn(root, opts));
  }
  return checks;
}

function applyAllowlist(checks, allow) {
  // allow: Set of "<check-id>:<artifact>" strings.
  for (const c of checks) {
    for (const r of c.results) {
      if (isBlocking(r.status) && allow.has(`${c.id}:${r.artifact}`)) {
        r.allowed = true;
      }
    }
  }
}

function parseArgs(argv) {
  const out = { json: false, help: false, only: [], allow: new Set(), emitDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--check") out.only.push(argv[++i]);
    else if (a.startsWith("--check=")) out.only.push(a.slice("--check=".length));
    else if (a === "--allow") out.allow.add(argv[++i]);
    else if (a.startsWith("--allow=")) out.allow.add(a.slice("--allow=".length));
    else if (a === "--emit-dir") out.emitDir = argv[++i];
    else if (a.startsWith("--emit-dir=")) out.emitDir = a.slice("--emit-dir=".length);
    else {
      process.stderr.write(`validate-emit: unknown flag '${a}'\n`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  return `validate-emit.mjs — pre-emit validator (issue #350 Stage 2)

usage:
  node .claude/bin/validate-emit.mjs [--json] [--check <id>] [--allow <id>:<path>] [--help]

flags:
  --json              emit JSON report to stdout (machine-readable)
  --check ID          run only check ID (repeatable). One of:
                      ${CHECK_IDS.join(", ")}
  --allow ID:PATH     suppress a specific (check, artifact) blocking finding
                      (repeatable; echoed in the report for audit)
  --emit-dir DIR      compare check 5 (mirror-exclusion) against an already-
                      emitted tree at DIR (DIR/codex, DIR/gemini). /sync passes
                      the tree it just produced; standalone runs emit a fresh
                      temp tree automatically.
  --help, -h          show this message and exit 0

exit codes:
  0  no blocking findings (all pass/skip, or every fail/fixture-needed allowed)
  1  >=1 unallowed blocking finding
  2  usage / IO error
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const root = findRepoRoot(process.cwd());
  const checks = runChecks(root, args.only, { emitDir: args.emitDir });
  applyAllowlist(checks, args.allow);

  // Tally.
  let blocking = 0;
  let allowed = 0;
  const tally = { pass: 0, fail: 0, "fixture-needed": 0, skip: 0 };
  for (const c of checks) {
    for (const r of c.results) {
      tally[r.status] = (tally[r.status] || 0) + 1;
      if (isBlocking(r.status)) {
        if (r.allowed) allowed++;
        else blocking++;
      }
    }
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: blocking === 0,
          tally,
          blocking,
          allowed,
          allowlist: [...args.allow],
          checks: checks.map((c) => ({
            id: c.id,
            source_rule: c.source_rule,
            results: c.results,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write("validate-emit — pre-emit rule-corpus sweep (issue #350)\n\n");
    for (const c of checks) {
      const fails = c.results.filter((r) => isBlocking(r.status) && !r.allowed);
      const allowedHere = c.results.filter((r) => isBlocking(r.status) && r.allowed);
      const mark = fails.length ? "FAIL" : "ok";
      process.stdout.write(`[${mark}] ${c.id}  (${c.source_rule})\n`);
      for (const r of fails) {
        process.stdout.write(`      ✗ ${r.artifact} — ${r.detail || r.status}\n`);
      }
      for (const r of allowedHere) {
        process.stdout.write(`      ~ ${r.artifact} — ALLOWED (${r.detail || r.status})\n`);
      }
    }
    process.stdout.write(
      `\nsummary: ${tally.pass} pass / ${tally.fail} fail / ${tally["fixture-needed"]} fixture-needed / ${tally.skip} skip` +
        ` — ${blocking} blocking${allowed ? `, ${allowed} allowed` : ""}\n`,
    );
    if (blocking > 0) {
      process.stdout.write(
        `\n/sync is BLOCKED. Fix the findings above, or pass --allow=<check-id>:<artifact> to suppress a specific finding (recorded in the /sync commit message).\n`,
      );
    }
  }
  process.exit(blocking > 0 ? 1 : 0);
}

// Export internals for the audit-fixture harness.
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

export {
  parseFrontmatter,
  parseToolList,
  matchesGlob,
  emitFresh,
  presentInEmit,
  parseEmitExclusions,
  parseReadonlySpecialists,
  enumerateDetectors,
  classifyFixtures,
  checkCommandFrontmatter,
  checkCommandLineCap,
  checkReadonlySpecialistTools,
  checkToolCanonicality,
  checkMirrorExclusion,
  checkPathsAnnotationConsistency,
  checkAuditFixtureCoverage,
  checkLoomOnlyMutualExclusion,
  checkProvenanceParity,
  parseProvenanceParity,
  extractHookKinds,
  evaluateProvenanceParity,
  collectHookCommands,
  parseLoomOnly,
  parseTiers,
  loomGlobMatch,
  PROVENANCE_TARGET_LANES,
  CANONICAL_CC_TOOLS,
  READONLY_FORBIDDEN_TOOLS,
  CHECK_IDS,
  STATUS,
  findRepoRoot,
};

if (isMain) main();
