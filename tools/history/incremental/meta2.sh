#!/bin/bash
# RT-776 / RT-841 metadata step for an incremental re-import (scratch only, no remote, never pushes).
#
# RE-CREATION (RT-710 owner override, 2026-10-25): the original RT-831 meta2.sh (sha256 a697db5e...) was lost. This
# script follows its description in RT-831 c13568 and RT-841: a parameterized successor of rt776-meta.sh that takes
# the dry-run output, the anchors, the trusted verifier with its pin and the source mirrors, and NEVER writes
# verify_incremental.py. Its own sha256 is pinned in PINS.tsv. It is not the original and has no evidence of its own
# until an independent verification passes.
#
#   meta2.sh repro RUN_ROOT ANCHOR_DIR OUT_ROOT
#
#   RUN_ROOT    output of "reimport-dryrun.sh repro": RUN_ROOT/a and RUN_ROOT/b, each with c/ (candidate),
#               shadow.git, evidence/, manifest.txt and a RESULT.txt that starts with OK.
#   ANCHOR_DIR  the anchors the dry run used (SHA256SUMS is checked).
#   OUT_ROOT    new, non-existing directory: OUT_ROOT/a and OUT_ROOT/b hold the two metadata builds.
#
# Required environment (no defaults, so nothing is trusted implicitly):
#   BASE             the anchored Shadow main sha (must equal ANCHOR_DIR/shadow.tsv)
#   VERIFIER         path of the TRUSTED verify_incremental.py copy (not the one in the candidate); its sha256 must
#                    equal PIN_VERIFIER_SHA256 below, which only an owner-reviewed edit of this file may change
#   MANIFEST_SHA256  sha256 of the dry run's manifest.txt (the value recorded in the evidence)
#   SRC_MIRRORS      directory with <Repo>.git mirrors (full history, tags, main at the anchored head)
set -Eeuo pipefail
unset PYTHONPATH PYTHONSTARTUP PYTHONHOME
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export TZ=UTC LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
HERE="$(cd "$(dirname "$0")" && pwd)"
PIN_NAME="Retail Tower history import"
PIN_EMAIL="history-import@kemetra.invalid"
MSG="Update history metadata for incremental re-import (RT-776)"   # fixed by the verifier (META_MESSAGE)
H=tools/history
PIN_VERIFIER_SHA256="feefd51e55ebffe86fd79d8856f2fc0195f32752cb641064f513d76fc5c99756"   # RT-776 c13217; also in PINS.tsv
VERIFIER_SHA256="$PIN_VERIFIER_SHA256"
PIN_GIT="git version 2.43.0"; PIN_PY="3.12."
VERIFIER_PATH="$H/verify_incremental.py"

die() { echo "FAIL: $*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
# Python gate: the verifier runs isolated (no script-directory or PYTHONPATH imports); it must print a controlled
# "FAIL: " line on stderr when it rejects, so a traceback or a missing file does not pass as a negative control.
ver() { python3 -I "$VER" "$@"; }
expect_reject() {  # errfile, expected text of the FAIL line (fixed string), then the verifier arguments
  local err="$1" want="$2"; shift 2
  if ver "$@" > /dev/null 2> "$err"; then return 1; fi
  grep -q '^FAIL: ' "$err" || die "verifier failed without a controlled FAIL line (see $err)"
  grep -q -F -e "$want" "$err" || die "verifier rejected for another reason than '$want' (see $err)"
}

[ "${1:-}" = repro ] && [ $# -eq 4 ] || { grep -E '^#   (meta2\.sh|RUN_ROOT|ANCHOR_DIR|OUT_ROOT)' "$0" | sed 's/^# *//' >&2; exit 2; }
RUN="$(cd "$2" && pwd)"; ANC="$(cd "$3" && pwd)"; OUT="$(realpath -m "$4")"
for v in BASE VERIFIER MANIFEST_SHA256 SRC_MIRRORS; do [ -n "${!v:-}" ] || die "$v is not set"; done
[[ "$BASE" =~ ^[0-9a-f]{40}$ ]] || die "BASE is not a 40-hex sha"
[ "$(git --version)" = "$PIN_GIT" ] || die "git is not $PIN_GIT"
python3 -c "import sys; sys.exit(0 if sys.version.startswith('$PIN_PY') else 1)" || die "python3 is not $PIN_PY"
[[ "$MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "MANIFEST_SHA256 is not a 64-hex sha256"
[ ! -e "$OUT" ] || die "$OUT exists"
VER="$(realpath "$VERIFIER")"; MIRRORS="$(cd "$SRC_MIRRORS" && pwd)"
[ "$(sha "$VER")" = "$VERIFIER_SHA256" ] || die "trusted verifier does not match the pin in meta2.sh"
(cd "$ANC" && sha256sum --quiet -c SHA256SUMS) || die "anchor files changed since capture"
[ "$(cut -f2 "$ANC/shadow.tsv")" = "$BASE" ] || die "BASE != anchored Shadow main"
PIN_DATE="$(cut -f2 "$ANC/pin.tsv")"
[[ "$PIN_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "pin.tsv date is malformed"
APPROVED=()
[ ! -f "$ANC/approved-tags.tsv" ] || APPROVED=(--approved-tags "$ANC/approved-tags.tsv")

# anchors.tsv rows are spliced into regexes and paths below: validate every field first.
while IFS=$'\t' read -r prod dir repo frozen new extra; do
  [ -z "${extra:-}" ] || die "anchors.tsv row has more than 5 fields"
  [[ "$prod" =~ ^[a-z0-9-]+$ ]] || die "anchors.tsv: bad product name"
  [[ "$dir" =~ ^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$ ]] || die "anchors.tsv: bad directory for $prod"
  [[ "$repo" =~ ^[A-Za-z0-9-]+$ ]] || die "anchors.tsv: bad repository for $prod"
  [[ "$frozen" =~ ^[0-9a-f]{40}$ && "$new" =~ ^[0-9a-f]{40}$ ]] || die "anchors.tsv: bad sha for $prod"
  [ "$(git -C "$MIRRORS/$repo.git" rev-parse refs/heads/main 2>/dev/null)" = "$new" ] || die "$repo.git mirror main != anchored $new"
done < "$ANC/anchors.tsv"

mval() { awk -F'\t' -v k="$2" '$1==k{print $2}' "$1"; }

bind_to_dryrun() {  # r: the dry-run manifest must describe exactly the files this step consumes
  local r="$1" m="$RUN/$1/manifest.txt" ev="$RUN/$1/evidence" prod dir repo frozen new want
  head -1 "$RUN/$r/RESULT.txt" | grep -qx OK || die "$RUN/$r/RESULT.txt does not start with OK"
  [ "$(sha "$m")" = "$MANIFEST_SHA256" ] || die "run $r manifest.txt != MANIFEST_SHA256"
  [ "$(mval "$m" candidate.head)" = "$(git -C "$RUN/$r/c" rev-parse HEAD)" ] || die "run $r candidate HEAD != manifest candidate.head"
  [ "$(mval "$m" anchors.sha256sums)" = "$(sha "$ANC/SHA256SUMS")" ] || die "run $r manifest anchors.sha256sums != ANCHOR_DIR"
  want=none; [ ! -f "$ANC/approved-tags.tsv" ] || want="$(sha "$ANC/approved-tags.tsv")"
  [ "$(mval "$m" approved-tags.sha256)" = "$want" ] || die "run $r manifest approved-tags.sha256 != ANCHOR_DIR/approved-tags.tsv"
  while IFS=$'\t' read -r prod dir repo frozen new; do
    [ "$(mval "$m" "$prod.crosswalk.sha256")" = "$(sha "$ev/$prod.crosswalk.tsv")" ] || die "run $r $prod crosswalk != manifest"
    [ "$(mval "$m" "$prod.tags.sha256")" = "$(sha "$ev/$prod.tags.tsv")" ] || die "run $r $prod tags != manifest"
  done < "$ANC/anchors.tsv"
}

build() {  # r  -> OUT/r : candidate + one metadata commit; touches only frozen.tsv, crosswalk/*.tsv, crosswalk/tags.tsv
  local r="$1" cand="$RUN/$1/c" ev="$RUN/$1/evidence" M="$OUT/$1" prod dir repo frozen new
  bind_to_dryrun "$r"
  git clone -q "$cand" "$M"
  git -C "$M" config core.autocrlf false
  [ "$(git -C "$M" rev-parse HEAD)" = "$(git -C "$cand" rev-parse HEAD)" ] || die "clone of run $r is not at the candidate head"
  git -C "$M" merge-base --is-ancestor "$BASE" HEAD || die "BASE is not an ancestor of the candidate"
  while IFS=$'\t' read -r prod dir repo frozen new; do
    grep -q -F -x "$(printf '%s\t%s\t%s\t%s' "$prod" "$dir" "$repo" "$frozen")" "$M/$H/frozen.tsv" || die "frozen.tsv row for $prod is not at the anchored frozen sha"
    sed -i -E "s|^($prod\t$dir\t$repo\t)$frozen\$|\1$new|" "$M/$H/frozen.tsv"
    cp "$ev/$prod.crosswalk.tsv" "$M/$H/crosswalk/$prod.tsv"
  done < "$ANC/anchors.tsv"
  # Only the per-product tag files that anchors.tsv names (bound to the manifest); anything else in evidence/ is refused.
  local f t=()
  for f in "$ev"/*.tags.tsv; do
    prod="$(basename "$f" .tags.tsv)"
    cut -f1 "$ANC/anchors.tsv" | grep -qx -F "$prod" || die "unexpected evidence file $f"
  done
  while IFS=$'	' read -r prod dir repo frozen new; do t+=("$ev/$prod.tags.tsv"); done < "$ANC/anchors.tsv"
  cat "${t[@]}" | sort > "$M/$H/crosswalk/tags.tsv"
  git -C "$M" add "$H/frozen.tsv" "$H/crosswalk"
  GIT_AUTHOR_NAME="$PIN_NAME" GIT_AUTHOR_EMAIL="$PIN_EMAIL" GIT_AUTHOR_DATE="$PIN_DATE" \
  GIT_COMMITTER_NAME="$PIN_NAME" GIT_COMMITTER_EMAIL="$PIN_EMAIL" GIT_COMMITTER_DATE="$PIN_DATE" \
    git -C "$M" commit -q --no-gpg-sign -m "$MSG"
}

check_and_verify() {  # r
  local r="$1" M="$OUT/$1" h names status merges
  h="$(git -C "$M" rev-parse HEAD)"
  # Scope: exactly the metadata files, modified only; the verifier is untouched and identical to the trusted copy (W3).
  names="$(git -C "$M" diff --no-renames --name-only HEAD~1 HEAD)"
  [ -n "$names" ] || die "metadata commit is empty"
  if printf '%s\n' "$names" | grep -v -E "^$H/(frozen\.tsv|crosswalk/[a-z0-9-]+\.tsv)\$" > /dev/null; then die "metadata commit touches paths outside the allowlist"; fi
  status="$(git -C "$M" diff --no-renames --name-status HEAD~1 HEAD)"
  if printf '%s\n' "$status" | grep -v -P '^M\t' > /dev/null; then die "metadata commit adds, deletes or retypes a file"; fi
  [ "$(git -C "$M" show "HEAD:$VERIFIER_PATH" | sha256sum | cut -d' ' -f1)" = "$VERIFIER_SHA256" ] || die "committed verifier != trusted copy"
  [ "$(git -C "$M" show "$BASE:$VERIFIER_PATH" | sha256sum | cut -d' ' -f1)" = "$VERIFIER_SHA256" ] || die "verifier at BASE != trusted copy"
  git -C "$M" diff --quiet HEAD~1 HEAD -- "$VERIFIER_PATH" || die "metadata commit modifies the verifier"
  merges="$(git -C "$M" rev-list --merges --count "$BASE..$h~1")"
  # Trusted verifier: OK with --src-base, and the negative controls.
  ver "$M" "$BASE" "$h" --pin-date "$PIN_DATE" --src-base "$MIRRORS" "${APPROVED[@]}" > "$OUT/$r.verify.txt"
  if [ "$merges" -gt 0 ]; then   # without merges the verifier legitimately needs no --src-base
    expect_reject "$OUT/$r.verify-nosrc.err" "--src-base is required" "$M" "$BASE" "$h" --pin-date "$PIN_DATE" "${APPROVED[@]}" || die "verifier accepted REV without --src-base"
  fi
  local stale_why="does not match the re-import merges"
  [ "$merges" -gt 0 ] || stale_why="tag refs differ from tags.tsv"   # no merges: h~1 is BASE, only the tags differ
  expect_reject "$OUT/$r.verify-stale.err" "$stale_why" "$M" "$BASE" "$h~1" --pin-date "$PIN_DATE" --src-base "$MIRRORS" "${APPROVED[@]}" || die "verifier accepted the stale candidate (no metadata commit)"
  # BASE against itself runs in the dry run's own Shadow clone: it holds BASE's tags only, not the candidate's new ones.
  ver "$RUN/$r/shadow.git" "$BASE" "$BASE" --pin-date "$PIN_DATE" > "$OUT/$r.verify-base.txt"
  ver "$M" "$h" "$h" --pin-date "$PIN_DATE" --src-base "$MIRRORS" "${APPROVED[@]}" > "$OUT/$r.verify-next-base.txt"
  git -C "$M" diff --no-renames --name-status HEAD~1 HEAD > "$OUT/$r.meta-diff.txt"
}

row() { [ -n "$2" ] || die "manifest value for $1 is empty"; printf '%s\t%s\n' "$1" "$2"; }

manifest() {  # r  (prints; identical for a and b when the build is reproducible)
  local r="$1" M="$OUT/$1" f v
  row verifier.sha256 "$VERIFIER_SHA256"
  v="$(sha "$HERE/meta2.sh")"; row script.sha256.meta2.sh "$v"
  row dryrun.manifest.sha256 "$MANIFEST_SHA256"
  v="$(sha "$ANC/SHA256SUMS")"; row anchors.sha256sums "$v"
  row base "$BASE"
  v="$(git -C "$M" rev-parse HEAD~1)"; row candidate.head "$v"
  v="$(git -C "$M" rev-parse 'HEAD~1^{tree}')"; row candidate.tree "$v"
  v="$(git -C "$M" rev-parse HEAD)"; row meta.commit "$v"
  v="$(git -C "$M" rev-parse 'HEAD^{tree}')"; row meta.tree "$v"
  for f in frozen.tsv crosswalk/backend-core.tsv crosswalk/erpnext-connector.tsv crosswalk/admin-console.tsv crosswalk/pos.tsv crosswalk/tags.tsv verify_incremental.py; do
    v="$(git -C "$M" rev-parse "HEAD:$H/$f")"; row "blob.$f" "$v"
  done
  v="$(sha "$OUT/$r.verify.txt")"; row verify.sha256 "$v"
  v="$(sha "$OUT/$r.meta-diff.txt")"; row meta-diff.sha256 "$v"
}

mkdir -p "$OUT"
for r in a b; do bind_to_dryrun "$r"; done   # both runs are bound before anything is built
for r in a b; do build "$r"; check_and_verify "$r"; done
manifest a > "$OUT/manifest-a.txt"; manifest b > "$OUT/manifest-b.txt"
cmp -s "$OUT/manifest-a.txt" "$OUT/manifest-b.txt" || die "metadata manifests differ between run a and run b"
cp "$OUT/manifest-a.txt" "$OUT/manifest.txt"
(cd "$OUT" && sha256sum manifest.txt > manifest.sha256)
printf 'OK\nreproducible: metadata builds a and b identical, meta commit %s, manifest sha256 %s\n' \
  "$(git -C "$OUT/a" rev-parse HEAD)" "$(cut -d' ' -f1 "$OUT/manifest.sha256")" | tee "$OUT/RESULT.txt"
