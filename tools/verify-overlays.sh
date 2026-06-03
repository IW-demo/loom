#!/usr/bin/env bash
# tools/verify-overlays.sh — verify variant overlays land correctly in USE templates.
#
# Two overlay forms exist (per .claude/guides/co-setup/variant-authoring.md):
#   1. Full-file overlay:  variant file IS the deployed content
#   2. Slot-keyed overlay: variant file contains <!-- slot:NAME --> bodies that
#      replace matching slots in the global; deployed content is composed via
#      .claude/bin/compose.mjs --global X --overlay Y
#
# For each variant declaration in .claude/sync-manifest.yaml::variants the
# verifier:
#   - peeks at the variant file to detect slot-keyed form
#   - computes the EXPECTED md5: variant md5 (full-file) OR composed md5 (slot)
#   - MD5-compares deployed against:
#       expected → ✓ correctly applied
#       global   → ✗ CRIT-2 overlay missed
#       neither  → ✗ drift from both
#
# Usage:
#   tools/verify-overlays.sh                  # all langs
#   tools/verify-overlays.sh py rs            # subset of langs
#
# Exit non-zero if any failure detected.

set -euo pipefail

LOOM_ROOT="$(git rev-parse --show-toplevel)"
MANIFEST="${LOOM_ROOT}/.claude/sync-manifest.yaml"
RESOLVER="${LOOM_ROOT}/.claude/bin/lib/loom-links.mjs"

command -v yq >/dev/null 2>&1   || { echo "ERROR: yq required"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node required (loom-links resolver)"; exit 2; }
[ -f "$MANIFEST" ]              || { echo "ERROR: manifest not at $MANIFEST"; exit 2; }
[ -f "$RESOLVER" ]              || { echo "ERROR: resolver not at $RESOLVER"; exit 2; }

# Map a sync-manifest `templates[].repo` basename to its loom-links
# logical key. Convention follows the in-repo naming:
#   kailash-coc-claude-<v> → use-template.claude-<v>   (CC-only templates)
#   kailash-coc-<v>        → use-template.<v>          (multi-CLI templates)
#   coc-claude-<v>         → use-template.claude-<v>   (e.g. coc-claude-base)
#   coc-<v>                → use-template.<v>          (e.g. coc-base — base
#                                                        multi-CLI; ordered LAST
#                                                        so `coc-claude-*` does
#                                                        not get re-stripped)
# Per `cross-repo.md` MUST-1 / MUST-NOT, no positional fallback —
# undeclared linkages MUST fail loud at the resolver.
manifest_repo_to_logical_key() {
  local key
  case "$1" in
    kailash-coc-claude-*) key="use-template.claude-${1#kailash-coc-claude-}";;
    kailash-coc-*)        key="use-template.${1#kailash-coc-}";;
    coc-claude-*)         key="use-template.claude-${1#coc-claude-}";;
    coc-*)                key="use-template.${1#coc-}";;
    *)                    return 1;;
  esac
  # Allowlist-validate the derived key shape: lowercase letters, digits,
  # dots, and hyphens only. Closes the injection-surface upstream by
  # rejecting any quote/metachar that survived prefix-stripping before
  # it can reach the `node` body (R1 security LOW-S1 + MED-S1).
  case "$key" in
    *[!a-z0-9.-]*) return 1;;
  esac
  printf '%s' "$key"
}

# Resolve a template's on-disk root via the loom-links resolver
# (`bin/lib/loom-links.mjs::resolveRepo`). Returns the absolute path
# on stdout or exits non-zero with the resolver's reason on stderr.
# Replaces the positional `${LOOM_ROOT}/${tpl}` guess that re-broke
# every resolver-mapped deployment per #351. Passes the resolver path
# + logical key via env vars (NOT string interpolation into a JS
# literal) so any quote-shaped manifest entry cannot break out of the
# `node` body — closes R1 security MED-S1 + reviewer LOW-R1.
resolve_template_root() {
  local key
  key="$(manifest_repo_to_logical_key "$1")" || {
    echo "ERROR: cannot map template repo '$1' to a loom-links key" >&2
    return 1
  }
  COC_RESOLVE_KEY="$key" COC_RESOLVE_LIB="$RESOLVER" \
    node --input-type=module -e '
      const lib = process.env.COC_RESOLVE_LIB;
      const key = process.env.COC_RESOLVE_KEY;
      import("file://" + lib).then((m) => {
        const r = m.resolveRepo(key, { require: false });
        if (r && r.value) { process.stdout.write(r.value); return; }
        if (r && r.skipped) {
          process.stderr.write("resolver: " + key + " → skipped: " + r.reason + "\n");
          process.exit(2);
        }
        process.stderr.write("resolver: " + key + " → unknown output\n");
        process.exit(2);
      }).catch((e) => {
        process.stderr.write(String((e && e.message) || e) + "\n");
        process.exit(2);
      });
    '
}

md5of() {
  if   command -v md5sum >/dev/null 2>&1; then md5sum "$1" | awk '{print $1}'
  elif command -v md5    >/dev/null 2>&1; then md5 -q "$1"
  else echo "ERROR: no md5 tool" >&2; exit 2
  fi
}

md5of_string() {
  if   command -v md5sum >/dev/null 2>&1; then printf '%s' "$1" | md5sum | awk '{print $1}'
  elif command -v md5    >/dev/null 2>&1; then printf '%s' "$1" | md5 -q
  else echo "ERROR: no md5 tool" >&2; exit 2
  fi
}

is_slot_keyed() {
  # Returns 0 if file contains a <!-- slot:NAME --> marker.
  grep -q '^<!-- slot:' "$1" 2>/dev/null
}

COMPOSE="${LOOM_ROOT}/.claude/bin/compose.mjs"
STRIP="${LOOM_ROOT}/.claude/bin/lib/strip-build-internal.mjs"

# Apply the BUILD-internal path-strip that /sync's emit pipeline applies to
# the composed output (`emit-cli-artifacts.mjs:389` →
# `stripBuildInternalReferences`) BEFORE computing an expected md5. Without
# this, every file whose source carries `packages/kailash-*` paths (genericized
# to "the X package (...)" at deploy time) reports a spurious drift-from-both —
# the #F89 false-positive class. The strip is idempotent and a no-op on clean
# content, so applying it uniformly matches emit exactly. Writes to a tempfile
# (not $() capture) so trailing newlines survive. Returns the stripped md5 on
# stdout; non-zero on strip failure so the caller surfaces it loudly.
stripped_md5of() {
  local src="$1" so rc
  so=$(mktemp)
  if ! node "$STRIP" --apply "$src" --out "$so" >/dev/null 2>&1; then
    rm -f "$so"
    return 1
  fi
  md5of "$so"
  rc=$?
  rm -f "$so"
  return $rc
}

if [ "$#" -eq 0 ]; then
  LANGS=$(yq -r '.repos | keys[]' "$MANIFEST" | grep -v '^prism$' | tr '\n' ' ')
else
  LANGS="$*"
fi

templates_for_lang() {
  yq -r ".repos.${1}.templates[].repo" "$MANIFEST" 2>/dev/null | grep -v '^null$' || true
}

# tab-separated rows; aggregate at end so subshell-loop counters survive.
RESULTS_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE"' EXIT

while IFS= read -r global_path; do
  global_file="${LOOM_ROOT}/.claude/${global_path}"
  if [ ! -f "$global_file" ]; then
    printf 'skip\t%s\t%s\t%s\n' "(global-missing)" "$global_path" "(no global source)" >> "$RESULTS_FILE"
    continue
  fi
  # Strip-aware: the deployed-if-overlay-missed form is strip(global), not raw
  # global, so the CRIT-2 "GLOBAL-deployed" comparison below must use the
  # stripped global md5 to match what /sync would actually ship.
  if ! global_md5=$(stripped_md5of "$global_file"); then
    printf 'fail\t%s\t%s\t%s\n' "(any)" "$global_path" "strip-failed: $global_path" >> "$RESULTS_FILE"
    continue
  fi

  for lang in $LANGS; do
    variant_path=$(yq -r ".variants[\"${global_path}\"].${lang} // \"null\"" "$MANIFEST")
    [ "$variant_path" = "null" ] && continue
    [ "$variant_path" = "~" ]    && continue

    variant_file="${LOOM_ROOT}/.claude/${variant_path}"
    if [ ! -f "$variant_file" ]; then
      printf 'fail\t%s\t%s\t%s\n' "(any-${lang})" "$global_path" "variant-file-missing: $variant_path" >> "$RESULTS_FILE"
      continue
    fi

    # Slot-keyed → expected md5 = compose(global, overlay); else = variant md5.
    # Use a tempfile so trailing newlines are preserved (bash $() truncates them).
    if is_slot_keyed "$variant_file"; then
      compose_out=$(mktemp)
      if ! node "$COMPOSE" --global "$global_file" --overlay "$variant_file" --out "$compose_out" >/dev/null 2>&1; then
        printf 'fail\t%s\t%s\t%s\n' "(any-${lang})" "$global_path" "compose-failed: $variant_path" >> "$RESULTS_FILE"
        rm -f "$compose_out"
        continue
      fi
      # Strip the composed output exactly as emit does before comparing.
      if ! expected_md5=$(stripped_md5of "$compose_out"); then
        printf 'fail\t%s\t%s\t%s\n' "(any-${lang})" "$global_path" "strip-failed: composed $variant_path" >> "$RESULTS_FILE"
        rm -f "$compose_out"
        continue
      fi
      rm -f "$compose_out"
      mode="slot"
    else
      # Full-file overlay: emit composes (variant replaces global) then strips.
      if ! expected_md5=$(stripped_md5of "$variant_file"); then
        printf 'fail\t%s\t%s\t%s\n' "(any-${lang})" "$global_path" "strip-failed: $variant_path" >> "$RESULTS_FILE"
        continue
      fi
      mode="full"
    fi

    # Rename-aware deployed-path: when the variant overlay's basename differs
    # from the global's basename, the manifest declares a variant RENAME
    # (e.g. global skills/.../python-version-bump.md → rs variant
    # skills/.../rust-version-bump.md). The deployed file in the rs template
    # carries the variant basename, NOT the global one — looking under the
    # global basename surfaces a spurious deployed-missing per #187.
    global_basename=$(basename "$global_path")
    overlay_basename=$(basename "$variant_path")
    if [ "$overlay_basename" != "$global_basename" ]; then
      deployed_rel="$(dirname "$global_path")/$overlay_basename"
    else
      deployed_rel="$global_path"
    fi
    for tpl in $(templates_for_lang "$lang"); do
      # Resolve template root via the canonical NAME→location binding
      # (per `cross-repo.md` MUST-1). An undeclared linkage fails loud
      # at the resolver — no positional `${LOOM_ROOT}/${tpl}` fallback.
      # `|| true` keeps the failing command-substitution from aborting the
      # whole run under `set -e` (resolve_template_root exits 2 on a skipped
      # linkage); the `-z` guard below is the intended graceful handler and
      # was previously dead code under set -e (latent until #F89's compose
      # fix stopped slot overlays from `continue`-ing before this line).
      tpl_root="$(resolve_template_root "$tpl" 2>/dev/null)" || true
      if [ -z "$tpl_root" ]; then
        printf 'fail\t%s\t%s\t%s\n' "$tpl" "$global_path" "template-unresolved: missing loom-links entry for $tpl" >> "$RESULTS_FILE"
        continue
      fi
      deployed="${tpl_root}/.claude/${deployed_rel}"
      if [ ! -f "$deployed" ]; then
        printf 'fail\t%s\t%s\t%s\n' "$tpl" "$global_path" "deployed-missing" >> "$RESULTS_FILE"
        continue
      fi
      d_md5=$(md5of "$deployed")
      if   [ "$d_md5" = "$expected_md5" ]; then
        printf 'pass\t%s\t%s\t%s\n' "$tpl" "$global_path" "variant-applied(${lang},${mode})" >> "$RESULTS_FILE"
      elif [ "$d_md5" = "$global_md5" ]; then
        # Slot-keyed no-op overlay: composed === global. Not a CRIT-2.
        if [ "$mode" = "slot" ] && [ "$expected_md5" = "$global_md5" ]; then
          printf 'pass\t%s\t%s\t%s\n' "$tpl" "$global_path" "variant-applied(${lang},slot-noop)" >> "$RESULTS_FILE"
        else
          printf 'fail\t%s\t%s\t%s\n' "$tpl" "$global_path" "GLOBAL-deployed(CRIT-2-overlay-missed,${lang},${mode})" >> "$RESULTS_FILE"
        fi
      else
        printf 'fail\t%s\t%s\t%s\n' "$tpl" "$global_path" "drift-from-both(${lang},${mode})" >> "$RESULTS_FILE"
      fi
    done
  done
done < <(yq -r '.variants | keys[]' "$MANIFEST")

# emit table
printf '\n%-30s  %-50s  %s\n' "TEMPLATE" "PATH" "STATUS"
printf '%-30s  %-50s  %s\n'   "--------" "----" "------"
total=0; pass=0; fail=0
while IFS=$'\t' read -r status tpl path msg; do
  total=$((total+1))
  case "$status" in
    pass) sym='✓'; pass=$((pass+1));;
    fail) sym='✗'; fail=$((fail+1));;
    *)    sym='-';;
  esac
  printf '%s %-28s  %-50s  %s\n' "$sym" "$tpl" "$path" "$msg"
done < <(sort "$RESULTS_FILE")

printf '\n%s\n' "----- SUMMARY -----"
printf 'Langs checked: %s\n' "$LANGS"
printf 'Total checks:  %d\n' "$total"
printf 'Passing:       %d\n' "$pass"
printf 'Failing:       %d\n' "$fail"

[ "$fail" -eq 0 ]
