#!/usr/bin/env bash
# Subprocess-driven smoke tests for the trust-posture POC.
# Mitigates red-team MED-1 (no regression harness for hook migration).

set -uo pipefail

POC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$POC/hooks/detect-violations.js"
TMPDIR=$(mktemp -d)
export CLAUDE_TRUST_STATE_DIR="$TMPDIR/.claude/learning"
export CLAUDE_SESSION_ID="test-session-$$"
mkdir -p "$CLAUDE_TRUST_STATE_DIR"

PASS=0
FAIL=0
FAILS=()

assert_jq() {
  # $1=label, $2=stdin payload, $3=expected jq filter (must produce non-empty)
  local label="$1" stdin="$2" filter="$3"
  local out
  out=$(printf '%s' "$stdin" | node "$HOOK" 2>/dev/null)
  if printf '%s' "$out" | jq -e "$filter" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo "  PASS  $label"
  else
    FAIL=$((FAIL + 1))
    FAILS+=("$label :: $filter :: $(printf '%s' "$out" | head -c 300)")
    echo "  FAIL  $label"
  fi
}

assert_violations_contains() {
  local label="$1" rule_id="$2"
  local file="$CLAUDE_TRUST_STATE_DIR/violations.jsonl"
  if [ -f "$file" ] && grep -q "\"$rule_id\"" "$file"; then
    PASS=$((PASS + 1))
    echo "  PASS  $label  (vio_log has $rule_id)"
  else
    FAIL=$((FAIL + 1))
    FAILS+=("$label :: violations.jsonl missing rule_id $rule_id")
    echo "  FAIL  $label"
  fi
}

reset_state() {
  rm -f "$CLAUDE_TRUST_STATE_DIR/violations.jsonl"
}

echo "=== T1: instruct-and-wait shape (Stop uses systemMessage, not hookSpecificOutput) ==="
node -e "
const {instructAndWait} = require('$POC/lib/instruct-and-wait.js');
const stop = instructAndWait({
  hookEvent:'Stop', severity:'post-mortem',
  what_happened:'x', why:'y', agent_must_report:[], agent_must_wait:'z'
});
const post = instructAndWait({
  hookEvent:'PostToolUse', severity:'halt-and-report',
  what_happened:'x', why:'y', agent_must_report:[], agent_must_wait:'z'
});
const pre  = instructAndWait({
  hookEvent:'PreToolUse', severity:'block',
  what_happened:'x', why:'y', agent_must_report:[], agent_must_wait:'z'
});
console.log(JSON.stringify({stop, post, pre}));
" > "$TMPDIR/iaw.json"

if jq -e '.stop.json.systemMessage and (.stop.json.hookSpecificOutput | not)' "$TMPDIR/iaw.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  Stop: systemMessage present, hookSpecificOutput absent"
else
  FAIL=$((FAIL + 1)); FAILS+=("Stop emit shape wrong"); echo "  FAIL  Stop: emit shape"
fi
if jq -e '.post.json.hookSpecificOutput.validation and (.post.json.continue == true)' "$TMPDIR/iaw.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  PostToolUse halt-and-report: hookSpecificOutput.validation present, continue:true"
else
  FAIL=$((FAIL + 1)); FAILS+=("PostToolUse emit shape wrong")
fi
if jq -e '.pre.json.continue == false and .pre.exitCode == 2' "$TMPDIR/iaw.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  PreToolUse block: continue:false, exitCode:2"
else
  FAIL=$((FAIL + 1)); FAILS+=("PreToolUse block emit shape wrong")
fi

echo ""
echo "=== T2: state-io fail-closed on missing/corrupt posture.json ==="
reset_state
node -e "
const {readPosture} = require('$POC/lib/state-io.js');
const fs = require('fs'), path = require('path');
const dir = process.env.CLAUDE_TRUST_STATE_DIR;
// Case A: missing — returns _fresh L5 (no init marker)
const a = readPosture('$TMPDIR');
console.log('A:', a.posture, a._fresh ? 'fresh' : 'state', a._fail_closed ? 'failclosed' : '-');
// Case B: corrupt JSON + init marker present — must fail-closed to L1
fs.writeFileSync(path.join(dir, '.initialized'), 'x');
fs.writeFileSync(path.join(dir, 'posture.json'), '{not valid');
const b = readPosture('$TMPDIR');
console.log('B:', b.posture, b._fail_closed ? 'failclosed' : '-');
// Case C: invalid posture value
fs.writeFileSync(path.join(dir, 'posture.json'), JSON.stringify({posture:'L99_BOGUS'}));
const c = readPosture('$TMPDIR');
console.log('C:', c.posture, c._fail_closed ? 'failclosed' : '-');
" > "$TMPDIR/posture.txt"

if grep -q "^A: L5_DELEGATED fresh" "$TMPDIR/posture.txt"; then
  PASS=$((PASS + 1)); echo "  PASS  Missing+no-init → L5_DELEGATED fresh"
else
  FAIL=$((FAIL + 1)); FAILS+=("posture missing case wrong: $(cat $TMPDIR/posture.txt | grep ^A:)")
fi
if grep -q "^B: L1_PSEUDO_AGENT failclosed" "$TMPDIR/posture.txt"; then
  PASS=$((PASS + 1)); echo "  PASS  Corrupt+init-marker → L1_PSEUDO_AGENT fail-closed"
else
  FAIL=$((FAIL + 1)); FAILS+=("posture corrupt case wrong: $(cat $TMPDIR/posture.txt | grep ^B:)")
fi
if grep -q "^C: L1_PSEUDO_AGENT failclosed" "$TMPDIR/posture.txt"; then
  PASS=$((PASS + 1)); echo "  PASS  Invalid-value+init-marker → L1_PSEUDO_AGENT fail-closed"
else
  FAIL=$((FAIL + 1)); FAILS+=("posture invalid-value case wrong: $(cat $TMPDIR/posture.txt | grep ^C:)")
fi

echo ""
echo "=== T3: state-io atomic append + ≤2KB cap ==="
reset_state
node -e "
const {appendViolation, readRecentViolations} = require('$POC/lib/state-io.js');
appendViolation('$TMPDIR', {rule_id:'r1', severity:'low', evidence:'short'});
appendViolation('$TMPDIR', {rule_id:'r2', severity:'high', evidence:'X'.repeat(5000)});
const rv = readRecentViolations('$TMPDIR');
const long = rv.find(v => v.rule_id === 'r2');
console.log('count', rv.length, 'truncated', long._truncated ? 'yes' : 'no', 'evidence_len', long.evidence.length);
" > "$TMPDIR/append.txt"

if grep -q "count 2 truncated yes" "$TMPDIR/append.txt"; then
  PASS=$((PASS + 1)); echo "  PASS  Append count=2 + oversize evidence truncated"
else
  FAIL=$((FAIL + 1)); FAILS+=("append/truncate wrong: $(cat $TMPDIR/append.txt)")
fi

echo ""
echo "=== T4: detect-violations Stop event — pre-existing without SHA ==="
reset_state
PAYLOAD=$(jq -n --arg t "This issue is pre-existing and not introduced in this session. Out of scope." '{hook_event_name:"Stop", cwd:env.TMPDIR, last_assistant_text:$t}' TMPDIR=$TMPDIR)
assert_jq "Stop pre-existing-no-SHA: post-mortem severity in systemMessage" "$PAYLOAD" '.systemMessage | test("POST-MORTEM")'
assert_violations_contains "violations.jsonl appended for pre-existing" "zero-tolerance/Rule-1c"

echo ""
echo "=== T5: detect-violations Stop event — sweep substitution ==="
reset_state
PAYLOAD=$(jq -n --arg t "Done. Sweep 5: 0/0/0 (clean). Ready to merge." '{hook_event_name:"Stop", cwd:env.TMPDIR, last_assistant_text:$t}' TMPDIR=$TMPDIR)
assert_jq "Stop sweep-substitution: detected" "$PAYLOAD" '.systemMessage | test("sweep-completeness/MUST-2")'
assert_violations_contains "violations.jsonl appended for sweep-substitution" "sweep-completeness/MUST-2"

echo ""
echo "=== T6: detect-violations Stop event — sweep with substitution label is OK ==="
reset_state
PAYLOAD=$(jq -n --arg t "Done. Sweep 5: 0/0/0 (substituted per user approval, cite-check)." '{hook_event_name:"Stop", cwd:env.TMPDIR, last_assistant_text:$t}' TMPDIR=$TMPDIR)
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.systemMessage | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  Sweep with (substituted ...) label → no violation"
else
  FAIL=$((FAIL + 1)); FAILS+=("sweep with substitution label wrongly flagged: $OUT")
fi

echo ""
echo "=== T7: detect-violations Stop event — self-confession is ADVISORY, never block ==="
reset_state
PAYLOAD=$(jq -n --arg t "I missed this in my last run because of incomplete testing." '{hook_event_name:"Stop", cwd:env.TMPDIR, last_assistant_text:$t}' TMPDIR=$TMPDIR)
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
# Self-confession alone → post-mortem severity (not block); systemMessage present
if printf '%s' "$OUT" | jq -e '.continue == true and (.systemMessage | test("POST-MORTEM"))' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  Self-confession → continue:true post-mortem (never blocks)"
else
  FAIL=$((FAIL + 1)); FAILS+=("self-confession blocked instead of post-mortem: $OUT")
fi
assert_violations_contains "self-confession logged with provisional rule" "test-completeness/PROVISIONAL"

echo ""
echo "=== T8: detect-violations PostToolUse Bash — cross-repo gh ==="
reset_state
# cwd basename is loom; --repo points to kailash-py → drift
PAYLOAD=$(jq -n '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:"gh issue list --repo kailash-py/main"}, cwd:"/Users/<user>/repos/loom"}')
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.validation | test("repo-scope-discipline")' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  PostToolUse cross-repo gh → repo-scope flag"
else
  FAIL=$((FAIL + 1)); FAILS+=("repo-scope-bash detection wrong: $OUT")
fi
assert_violations_contains "cross-repo gh logged" "repo-scope-discipline/MUST-NOT-1"

# hook-output-discipline.md MUST-2: severity is halt-and-report (continue:true), NOT block.
if printf '%s' "$OUT" | jq -e '.continue == true' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  cross-repo gh emits continue:true (halt-and-report, not block)"
else
  FAIL=$((FAIL + 1)); FAILS+=("cross-repo gh wrongly emits continue:false (block severity): $OUT")
fi

echo ""
echo "=== T8a: hook-output-discipline MUST-3 — \$REPO shell-variable skip ==="
reset_state
# Pre-expansion shell variable in --repo arg → detector MUST skip (return null)
SHELLVAR_CMD=$(cat .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/skip-shell-variable.txt)
PAYLOAD=$(jq -n --arg cmd "$SHELLVAR_CMD" '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:$cmd}, cwd:"/Users/<user>/repos/loom"}')
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  \$REPO literal → bare passthrough (no false-positive flag)"
else
  FAIL=$((FAIL + 1)); FAILS+=("\$REPO false-positive resurfaced: $OUT")
fi
if [ ! -f "$CLAUDE_TRUST_STATE_DIR/violations.jsonl" ] || ! grep -q "repo-scope-discipline" "$CLAUDE_TRUST_STATE_DIR/violations.jsonl"; then
  PASS=$((PASS + 1)); echo "  PASS  \$REPO did NOT log a violation"
else
  FAIL=$((FAIL + 1)); FAILS+=("\$REPO wrongly logged a violation")
fi

echo ""
echo "=== T8b: hook-output-discipline MUST-3 — \${REPO} braced-variable skip ==="
reset_state
BRACED_CMD=$(cat .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/skip-braced-variable.txt)
PAYLOAD=$(jq -n --arg cmd "$BRACED_CMD" '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:$cmd}, cwd:"/Users/<user>/repos/loom"}')
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  \${REPO} braced-variable → bare passthrough"
else
  FAIL=$((FAIL + 1)); FAILS+=("\${REPO} false-positive: $OUT")
fi

echo ""
echo "=== T8c: hook-output-discipline MUST-3 — \$(...) command-substitution skip ==="
reset_state
CMDSUB_CMD=$(cat .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/skip-command-substitution.txt)
PAYLOAD=$(jq -n --arg cmd "$CMDSUB_CMD" '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:$cmd}, cwd:"/Users/<user>/repos/loom"}')
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  \$(...) command-substitution → bare passthrough"
else
  FAIL=$((FAIL + 1)); FAILS+=("\$(...) false-positive: $OUT")
fi

echo ""
echo "=== T8d: hook-output-discipline MUST-1 — emit() populates the six canonical fields ==="
# A halting-severity emit MUST populate every section. Inline-generate with
# all six fields populated to assert the canonical shape end-to-end.
node -e "
const {instructAndWait} = require('$POC/lib/instruct-and-wait.js');
const out = instructAndWait({
  hookEvent:'PreToolUse', severity:'block',
  what_happened:'attempted off-repo gh write',
  why:'repo-scope-discipline/MUST-NOT-1',
  agent_must_report:['Quote the command','State the rule','Propose remediation'],
  agent_must_wait:'Wait for user instruction.',
  user_summary:'cross-repo gh write blocked',
});
console.log(JSON.stringify(out));
" > "$TMPDIR/iaw-canonical.json"

if jq -e '.json.hookSpecificOutput.validation | test("REPORT TO USER")' "$TMPDIR/iaw-canonical.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  populated emit → validation contains REPORT TO USER block"
else
  FAIL=$((FAIL + 1)); FAILS+=("populated emit missing REPORT TO USER block")
fi
if jq -e '.json.hookSpecificOutput.validation | test("THEN:")' "$TMPDIR/iaw-canonical.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  populated emit → validation contains THEN: agent_must_wait line"
else
  FAIL=$((FAIL + 1)); FAILS+=("populated emit missing THEN: line")
fi
if jq -e '(.json.hookSpecificOutput.validation | test("WHAT HAPPENED")) and (.json.hookSpecificOutput.validation | test("WHY:"))' "$TMPDIR/iaw-canonical.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  populated emit → WHAT HAPPENED + WHY both present"
else
  FAIL=$((FAIL + 1)); FAILS+=("populated emit missing WHAT HAPPENED or WHY")
fi
if jq -e '.exitCode == 2 and .json.continue == false' "$TMPDIR/iaw-canonical.json" >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  block severity → exitCode:2, continue:false"
else
  FAIL=$((FAIL + 1)); FAILS+=("block severity exit/continue mismatch")
fi

# ====================================================================
# T8e–T8k — Issue #36: hierarchical-fork upstream-remote allowance.
# Each test sets up a temp git repo with the specified upstream remote,
# invokes the hook from that cwd, asserts flag/no-flag per the issue's
# expected-behavior table.
# ====================================================================

# Helper: create a temp git repo with optional upstream remote, return its path.
mk_temp_repo() {
  local repo_basename="$1" upstream_url="$2"
  local d
  d=$(mktemp -d "$TMPDIR/issue36-$repo_basename-XXXXXX")
  # Re-name so basename matches what the test wants
  local target_dir="$d/$repo_basename"
  mkdir -p "$target_dir"
  ( cd "$target_dir" && git init -q && git config user.email t@t.local && git config user.name t )
  if [ -n "$upstream_url" ]; then
    ( cd "$target_dir" && git remote add upstream "$upstream_url" )
  fi
  printf '%s\n' "$target_dir"
}

run_t8_upstream_case() {
  local label="$1" repo_basename="$2" upstream="$3" cmd="$4" expect="$5"
  reset_state
  local repo
  repo=$(mk_temp_repo "$repo_basename" "$upstream")
  local PAYLOAD
  PAYLOAD=$(jq -n --arg cwd "$repo" --arg cmd "$cmd" \
    '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:$cmd}, cwd:$cwd}')
  local OUT
  OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
  case "$expect" in
    null)
      if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput | not)' >/dev/null 2>&1; then
        PASS=$((PASS + 1)); echo "  PASS  $label"
      else
        FAIL=$((FAIL + 1)); FAILS+=("$label expected null, got: $OUT")
      fi
      ;;
    halt-and-report)
      if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.validation | test("repo-scope-discipline")' >/dev/null 2>&1; then
        PASS=$((PASS + 1)); echo "  PASS  $label"
      else
        FAIL=$((FAIL + 1)); FAILS+=("$label expected halt-and-report, got: $OUT")
      fi
      ;;
  esac
}

echo ""
echo "=== T8e: issue #36 case 1 — SSH form upstream match → no flag ==="
run_t8_upstream_case "SSH upstream match" "consumer" "git@github.com:Org/parent.git" \
  "gh issue create --repo Org/parent --title fix --body x" "null"

echo ""
echo "=== T8f: issue #36 case 2 — HTTPS form upstream match → no flag ==="
run_t8_upstream_case "HTTPS upstream match" "consumer" "https://github.com/Org/parent" \
  "gh issue create --repo Org/parent --title fix --body x" "null"

echo ""
echo "=== T8g: issue #36 case 3 — slug form upstream match → no flag ==="
run_t8_upstream_case "Slug upstream match" "consumer" "Org/parent" \
  "gh pr create --repo Org/parent --title fix --body x" "null"

echo ""
echo "=== T8h: issue #36 case 4 — sibling NOT upstream → halt-and-report ==="
run_t8_upstream_case "Sibling not upstream" "consumer" "git@github.com:Org/parent.git" \
  "gh issue create --repo Org/sibling --title x --body y" "halt-and-report"

echo ""
echo "=== T8i: issue #36 case 5 — no upstream remote (flat consumer) → halt-and-report ==="
run_t8_upstream_case "No upstream basename heuristic" "consumer" "" \
  "gh issue create --repo Org/parent --title x --body y" "halt-and-report"

echo ""
echo "=== T8j: issue #36 case 6 — cwd basename matches target → no flag ==="
run_t8_upstream_case "cwd basename matches" "parent" "git@github.com:Org/parent.git" \
  "gh issue create --repo Org/parent --title x --body y" "null"

echo ""
echo "=== T8k: issue #36 case 7 — gh without --repo → no flag ==="
run_t8_upstream_case "gh without --repo" "consumer" "git@github.com:Org/parent.git" \
  "gh issue list --state open" "null"

echo ""
echo "=== T9: detect-violations UserPromptSubmit — regression signal ==="
reset_state
PAYLOAD=$(jq -n '{hook_event_name:"UserPromptSubmit", prompt:"why is the BE/FE still broken?", cwd:env.TMPDIR}' TMPDIR=$TMPDIR)
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.additionalContext | test("REGRESSION SIGNAL")' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  UserPromptSubmit regression signal → context injected"
else
  FAIL=$((FAIL + 1)); FAILS+=("regression signal injection failed: $OUT")
fi

echo ""
echo "=== T10: detect-violations no-match passthrough ==="
reset_state
PAYLOAD=$(jq -n '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:"ls -la"}, cwd:env.TMPDIR}' TMPDIR=$TMPDIR)
OUT=$(printf '%s' "$PAYLOAD" | node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput | not) and (.systemMessage | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  Innocent Bash → bare passthrough"
else
  FAIL=$((FAIL + 1)); FAILS+=("passthrough wrong: $OUT")
fi
if [ ! -f "$CLAUDE_TRUST_STATE_DIR/violations.jsonl" ]; then
  PASS=$((PASS + 1)); echo "  PASS  No violations.jsonl created on innocent input"
else
  FAIL=$((FAIL + 1)); FAILS+=("violations.jsonl created on innocent input")
fi

echo ""
echo "=== T11: state-resolver finds main checkout from any cwd (unsets env override) ==="
env -u CLAUDE_TRUST_STATE_DIR node -e "
const {resolveMainCheckout} = require('$POC/lib/state-resolver.js');
const main = resolveMainCheckout('$POC');
console.log('main:', main);
" > "$TMPDIR/resolver.txt"
if grep -q "^main: /Users/<user>/repos/loom" "$TMPDIR/resolver.txt"; then
  PASS=$((PASS + 1)); echo "  PASS  resolver from POC subdir resolves to /Users/<user>/repos/loom"
else
  FAIL=$((FAIL + 1)); FAILS+=("resolver wrong: $(cat $TMPDIR/resolver.txt)")
fi

echo ""
echo "=== T12: hook timeout fallback ==="
# This is a structural check — confirm setTimeout is wired via grep
if grep -q "setTimeout(" "$HOOK" && grep -q "TIMEOUT_MS" "$HOOK"; then
  PASS=$((PASS + 1)); echo "  PASS  Hook has timeout fallback per cc-artifacts.md Rule 7"
else
  FAIL=$((FAIL + 1)); FAILS+=("timeout fallback missing")
fi

# Switch to PRODUCTION hook paths for Phase 2 tests
PROD_HOOK="/Users/<user>/repos/loom/.claude/hooks/detect-violations.js"
PROD_GATE="/Users/<user>/repos/loom/.claude/hooks/posture-gate.js"

echo ""
echo "=== T13: PreToolUse(Read) stale-record banner injection ==="
reset_state
# Setup: create a pending_verification rule with a recent 'since' timestamp
SINCE=$(date -u -v+1H +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u --date='+1 hour' +%Y-%m-%dT%H:%M:%S.000Z)
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<EOF
{"posture":"L5_DELEGATED","since":"2026-05-01T00:00:00.000Z","transition_history":[],"pending_verification":[{"rule_id":"test-completeness/MUST-1","since":"$SINCE","grace_period_days":7}],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<EOF
2026-05-01T00:00:00.000Z
EOF
# Create a stale .session-notes file (mtime old)
STALE_FILE="$TMPDIR/.session-notes"
echo "tests pass per yesterday" > "$STALE_FILE"
touch -t 202604010000 "$STALE_FILE"
PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"'$STALE_FILE'"},"cwd":"'$TMPDIR'"}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_HOOK" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.additionalContext // "" | test("STALE RECORD")' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  PreToolUse(Read) on stale file → banner injected"
else
  FAIL=$((FAIL + 1)); FAILS+=("stale-record banner missing: $OUT")
fi

echo ""
echo "=== T14: Stop receipt-token validation (missing ack → ack_failure) ==="
reset_state
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<EOF
{"posture":"L4_CONTINUOUS_INSIGHT","since":"2026-05-04T00:00:00.000Z","transition_history":[],"pending_verification":[{"rule_id":"test-completeness/MUST-1","since":"2026-05-04T00:00:00.000Z","grace_period_days":7}],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<EOF
2026-05-04T00:00:00.000Z
EOF
# Stop hook with assistant text that does NOT contain [ack: test-completeness/MUST-1]
PAYLOAD='{"hook_event_name":"Stop","cwd":"'$TMPDIR'","session_id":"sess-T14","last_assistant_text":"Working on the changes. Done."}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_HOOK" 2>/dev/null)
assert_violations_contains "ack_failure logged when [ack: rule_id] missing" "acknowledgement_failure/test-completeness/MUST-1"

echo ""
echo "=== T15: Stop receipt-token validation (ack present → no violation) ==="
reset_state
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<EOF
{"posture":"L4_CONTINUOUS_INSIGHT","since":"2026-05-04T00:00:00.000Z","transition_history":[],"pending_verification":[{"rule_id":"test-completeness/MUST-1","since":"2026-05-04T00:00:00.000Z","grace_period_days":7}],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<EOF
2026-05-04T00:00:00.000Z
EOF
PAYLOAD='{"hook_event_name":"Stop","cwd":"'$TMPDIR'","session_id":"sess-T15","last_assistant_text":"Acknowledged. [ack: test-completeness/MUST-1] Working on changes."}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_HOOK" 2>/dev/null)
if [ ! -f "$CLAUDE_TRUST_STATE_DIR/violations.jsonl" ] || ! grep -q "acknowledgement_failure" "$CLAUDE_TRUST_STATE_DIR/violations.jsonl"; then
  PASS=$((PASS + 1)); echo "  PASS  ack token present → no acknowledgement_failure logged"
else
  FAIL=$((FAIL + 1)); FAILS+=("false positive: ack present but ack_failure logged")
fi

echo ""
echo "=== T16: posture-gate L5 passthrough (no enforcement) ==="
reset_state
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<'EOF'
{"posture":"L5_DELEGATED","since":"2026-05-01T00:00:00.000Z","transition_history":[],"pending_verification":[],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<'EOF'
2026-05-01T00:00:00.000Z
EOF
PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/x.py","new_string":"x=1"},"cwd":"'$TMPDIR'"}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_GATE" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput.validation // "" | test("STOP") | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  L5 Edit → passthrough (no posture-gate enforcement)"
else
  FAIL=$((FAIL + 1)); FAILS+=("L5 passthrough wrong: $OUT")
fi

echo ""
echo "=== T17: posture-gate L2 blocks Edit ==="
reset_state
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<'EOF'
{"posture":"L2_SUPERVISED","since":"2026-05-04T00:00:00.000Z","transition_history":[],"pending_verification":[],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<'EOF'
2026-05-04T00:00:00.000Z
EOF
PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/x.py","new_string":"x=1"},"cwd":"'$TMPDIR'"}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_GATE" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.validation // "" | test("L2_SUPERVISED")' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  L2 Edit → halt-and-report (posture-gate fired)"
else
  FAIL=$((FAIL + 1)); FAILS+=("L2 enforcement missing: $OUT")
fi

echo ""
echo "=== T18: posture-gate L3 blocks git commit ==="
reset_state
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<'EOF'
{"posture":"L3_SHARED_PLANNING","since":"2026-05-04T00:00:00.000Z","transition_history":[],"pending_verification":[],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<'EOF'
2026-05-04T00:00:00.000Z
EOF
PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m wip"},"cwd":"'$TMPDIR'"}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_GATE" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.validation // "" | test("L3_SHARED_PLANNING")' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  L3 git commit → halt-and-report"
else
  FAIL=$((FAIL + 1)); FAILS+=("L3 commit-block missing: $OUT")
fi

echo ""
echo "=== T19: posture-gate L2 allows read-only Bash ==="
reset_state
cat > "$CLAUDE_TRUST_STATE_DIR/posture.json" <<'EOF'
{"posture":"L2_SUPERVISED","since":"2026-05-04T00:00:00.000Z","transition_history":[],"pending_verification":[],"violation_window_30d":{}}
EOF
cat > "$CLAUDE_TRUST_STATE_DIR/.initialized" <<'EOF'
2026-05-04T00:00:00.000Z
EOF
PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"'$TMPDIR'"}'
OUT=$(printf '%s' "$PAYLOAD" | node "$PROD_GATE" 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.continue == true and (.hookSpecificOutput.validation // "" | test("L2") | not)' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS  L2 read-only Bash (git status) → passthrough"
else
  FAIL=$((FAIL + 1)); FAILS+=("L2 read-only allowance broken: $OUT")
fi

echo ""
echo "=== T20: codify.md Trust Posture Wiring requirement is documented ==="
if grep -q "ENFORCEMENT" /Users/<user>/repos/loom/.claude/commands/codify.md && \
   grep -q "Trust Posture Wiring" /Users/<user>/repos/loom/.claude/commands/codify.md; then
  PASS=$((PASS + 1)); echo "  PASS  codify.md mandates Trust Posture Wiring with ENFORCEMENT clause"
else
  FAIL=$((FAIL + 1)); FAILS+=("codify.md ENFORCEMENT clause missing")
fi

echo ""
echo "=== T21: cc-architect.md has wiring grep sweep ==="
if grep -q "Trust Posture Wiring" /Users/<user>/repos/loom/.claude/agents/cc-architect.md && \
   grep -q "grep" /Users/<user>/repos/loom/.claude/agents/cc-architect.md; then
  PASS=$((PASS + 1)); echo "  PASS  cc-architect.md includes mechanical sweep for wiring"
else
  FAIL=$((FAIL + 1)); FAILS+=("cc-architect wiring sweep missing")
fi

# Phase 3: state-file three-layer mutation detection (issue #25 adoption)
PROD_VBC=/Users/<user>/repos/loom/.claude/hooks/validate-bash-command.js
mkdir -p /tmp/sftest

echo ""
echo "=== T22: Layer 1 — redirect to posture.json blocked ==="
echo '{"tool_input":{"command":"echo bogus > .claude/learning/posture.json"},"cwd":"/tmp"}' > /tmp/sftest/t22.json
node "$PROD_VBC" < /tmp/sftest/t22.json > /tmp/sftest/t22.out 2>/dev/null
if jq -e '.continue == false and (.hookSpecificOutput.validation | test("Layer 1"))' /tmp/sftest/t22.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  redirect → Layer 1 block"
else
  FAIL=$((FAIL + 1)); FAILS+=("Layer 1 redirect detection failed")
fi

echo ""
echo "=== T23: Layer 1 — sed -i in-place edit blocked ==="
echo '{"tool_input":{"command":"sed -i s/L4/L5/ .claude/learning/posture.json"},"cwd":"/tmp"}' > /tmp/sftest/t23.json
node "$PROD_VBC" < /tmp/sftest/t23.json > /tmp/sftest/t23.out 2>/dev/null
if jq -e '.continue == false and (.hookSpecificOutput.validation | test("Layer 1"))' /tmp/sftest/t23.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  sed -i → Layer 1 block"
else
  FAIL=$((FAIL + 1)); FAILS+=("Layer 1 sed -i detection failed")
fi

echo ""
echo "=== T24: Layer 2 — cp into posture.json blocked ==="
echo '{"tool_input":{"command":"cp /tmp/fake.json .claude/learning/posture.json"},"cwd":"/tmp"}' > /tmp/sftest/t24.json
node "$PROD_VBC" < /tmp/sftest/t24.json > /tmp/sftest/t24.out 2>/dev/null
if jq -e '.continue == false and (.hookSpecificOutput.validation | test("Layer 2"))' /tmp/sftest/t24.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  cp → Layer 2 block"
else
  FAIL=$((FAIL + 1)); FAILS+=("Layer 2 cp detection failed")
fi

echo ""
echo "=== T25: Layer 3 — python -c writing posture.json blocked ==="
cat > /tmp/sftest/t25.json <<'EOF'
{"tool_input":{"command":"python3 -c \"open('.claude/learning/posture.json','w').write('x')\""},"cwd":"/tmp"}
EOF
node "$PROD_VBC" < /tmp/sftest/t25.json > /tmp/sftest/t25.out 2>/dev/null
if jq -e '.continue == false and (.hookSpecificOutput.validation | test("Layer 3"))' /tmp/sftest/t25.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  python -c → Layer 3 block"
else
  FAIL=$((FAIL + 1)); FAILS+=("Layer 3 python -c detection failed")
fi

echo ""
echo "=== T26: read-only cat on posture.json passes ==="
echo '{"tool_input":{"command":"cat .claude/learning/posture.json"},"cwd":"/tmp"}' > /tmp/sftest/t26.json
node "$PROD_VBC" < /tmp/sftest/t26.json > /tmp/sftest/t26.out 2>/dev/null
if jq -e '.continue == true' /tmp/sftest/t26.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  cat → passthrough (read-only)"
else
  FAIL=$((FAIL + 1)); FAILS+=("cat read-only false-positive")
fi

echo ""
echo "=== T27: redirect to NON-protected file passes ==="
echo '{"tool_input":{"command":"echo something > /tmp/safe.json"},"cwd":"/tmp"}' > /tmp/sftest/t27.json
node "$PROD_VBC" < /tmp/sftest/t27.json > /tmp/sftest/t27.out 2>/dev/null
if jq -e '.continue == true' /tmp/sftest/t27.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  redirect to non-protected → passthrough"
else
  FAIL=$((FAIL + 1)); FAILS+=("non-protected false-positive")
fi

echo ""
echo "=== T28: violations.jsonl mutation blocked ==="
echo '{"tool_input":{"command":"echo evil >> .claude/learning/violations.jsonl"},"cwd":"/tmp"}' > /tmp/sftest/t28.json
node "$PROD_VBC" < /tmp/sftest/t28.json > /tmp/sftest/t28.out 2>/dev/null
if jq -e '.continue == false' /tmp/sftest/t28.out >/dev/null; then
  PASS=$((PASS + 1)); echo "  PASS  violations.jsonl append blocked"
else
  FAIL=$((FAIL + 1)); FAILS+=("violations.jsonl append not blocked")
fi

echo ""
echo "============================================="
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"
if [ $FAIL -gt 0 ]; then
  echo ""
  echo "  Failures:"
  for f in "${FAILS[@]}"; do echo "    - $f"; done
fi
echo "  tmpdir: $TMPDIR"
echo "============================================="

[ $FAIL -eq 0 ]
