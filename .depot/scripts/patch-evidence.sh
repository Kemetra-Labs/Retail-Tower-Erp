#!/usr/bin/env bash
# RT-1366: patch evidence for the opt-in Depot CI pre-push preflight.
#
# `depot ci run` uploads only TRACKED changes (new files need `git add -N` first) and does NOT carry
# `.github/workflows/**` changes. This step prints what actually arrived on the runner and fails
# closed, so a green run cannot silently have tested less than the local work.
#
#   EXPECTED_FILES  repo-relative paths separated by newlines, spaces or commas (may be empty)
#   EXPECTED_FILE   optional path of a file listing expected paths (one per line; whole-line # comments allowed)
#
# Exit 1: an expected file is missing on the runner, or the list names a `.github/workflows/**` path,
# an absolute path or a `..` path. Run from the repository root.
set -u

# Canonical form: no CR, no repeated or "/./" slashes, no leading "./" or trailing "/." (so that
# ".github//workflows" and ".github/./workflows" cannot slip past the .github/workflows rule).
normalize() {
  local p="$1" prev=""
  p="${p//$'\r'/}"
  while [ "$p" != "$prev" ]; do
    prev="$p"
    p="${p//\/\//\/}"
    p="${p//\/.\//\/}"
    p="${p#./}"
    p="${p%/.}"
  done
  printf '%s' "$p"
}

expected=()
add_expected() {
  local raw="$1" tok
  raw="${raw//,/ }"
  set -f   # a token such as "*" must stay literal, never expand to real files
  for tok in $raw; do
    tok="$(normalize "$tok")"
    [ -n "$tok" ] && expected+=("$tok")
  done
  set +f
}

add_expected "${EXPECTED_FILES:-}"
if [ -n "${EXPECTED_FILE:-}" ] && [ ! -f "$EXPECTED_FILE" ]; then
  echo "NOTE  $EXPECTED_FILE not found: fine if you pass EXPECTED_FILES, but a new list file needs 'git add -N' (check 'expected files: N' below)"
fi
if [ -n "${EXPECTED_FILE:-}" ] && [ -f "$EXPECTED_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    add_expected "$line"
  done < "$EXPECTED_FILE"
fi

echo "HEAD: $(git rev-parse HEAD)"
echo "--- changed files on the runner (tracked diff vs HEAD, then untracked), with sha256"
changed="$( { git -c core.quotepath=off diff --name-only HEAD; git -c core.quotepath=off ls-files --others --exclude-standard; } | sort -u)"
if [ -z "$changed" ]; then
  echo "(none: no local patch reached the runner)"
else
  while IFS= read -r f; do
    if [ -f "$f" ]; then echo "$(sha256sum -- "$f" | cut -d' ' -f1)  $f"; else echo "(deleted)  $f"; fi
  done <<< "$changed"
fi

rc=0
echo "--- expected files: ${#expected[@]}"
for f in "${expected[@]+"${expected[@]}"}"; do
  case "$f" in
    /*|[A-Za-z]:*|..|../*|*/../*|*/..) echo "FAIL  $f  (absolute or parent path is not allowed)"; rc=1; continue ;;
    .github/workflows|.github/workflows/*) echo "FAIL  $f  (.github/workflows changes are not carried by depot ci run; prove the wiring on the PR)"; rc=1; continue ;;
  esac
  if [ -f "$f" ]; then
    echo "PRESENT  $(sha256sum -- "$f" | cut -d' ' -f1)  $f"
    printf '%s\n' "$changed" | grep -Fxq -- "$f" || echo "NOTE     $f is present but not in the changed list (unchanged versus HEAD)"
  else
    echo "FAIL  $f  (missing on the runner: a new file needs 'git add -N' before depot ci run)"
    rc=1
  fi
done
[ "$rc" -eq 0 ] && echo "patch evidence OK" || echo "patch evidence FAILED"
exit "$rc"
