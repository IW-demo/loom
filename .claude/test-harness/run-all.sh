#!/bin/bash
# Run all three suites (capability, compliance, safety) against all three CLIs.
# Each suite writes its own JSONL + per-test .log under .claude/test-harness/results/.

set -e

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HARNESS_DIR"

CLI_ARG="${1:-all}"

echo "============================================================"
echo " COC multi-CLI test harness"
echo " CLIs: $CLI_ARG"
echo " Results: $HARNESS_DIR/results/"
echo "============================================================"

for SUITE in capability compliance safety; do
  echo ""
  echo ">>> Running $SUITE suite..."
  node "suites/${SUITE}.mjs" --cli "$CLI_ARG"
done

echo ""
echo "============================================================"
echo " ALL SUITES COMPLETE"
echo " Inspect per-test logs: $HARNESS_DIR/results/"
echo "============================================================"
