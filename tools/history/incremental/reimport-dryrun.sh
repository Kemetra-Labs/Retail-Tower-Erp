#!/bin/bash
# RT-760: overlay-preserving incremental re-import DRY RUN for Kemetra/Retail-Tower-Shadow (child of RT-710).
# Scratch-only. Never pushes and never writes to GitHub: the only network use is ls-remote and fetch.
# Run inside WSL on a short native path (for example ~/rt760). Pins are checked, not assumed.
#
# PROVENANCE (RT-710 owner override, 2026-10-25): this is a RE-CREATION, not the original RT-831 "v2" script
# (whose file was lost). It is RT-760's 477519cf script plus the bounded v2 change described in RT-831 c13568
# (previous tip proven through the committed crosswalk, newest import merge reachable by any parent), plus
# hardening: no implicit credential helper, no machine-specific paths. Its sha256 is pinned in PINS.tsv.
#
#   reimport-dryrun.sh anchors ANCHOR_DIR             capture live anchors once (network reads)
#   reimport-dryrun.sh run     ANCHOR_DIR OUT_DIR     one dry run into a clean OUT_DIR
#   reimport-dryrun.sh repro   ANCHOR_DIR OUT_ROOT    two clean runs (OUT_ROOT/a, OUT_ROOT/b), compare manifests
#   reimport-dryrun.sh selftest OUT_ROOT              offline: SELFTEST_SRC mirrors + synthetic commits and tags
#
# New tags are never auto-approved. The owner writes ANCHOR_DIR/approved-tags.tsv by hand after reviewing the
# anchors (one line per tag: prod<TAB>refs/tags/<name><TAB><source commit sha>). Missing file = no tag approved.
# Env: SRC_BASE (default https://github.com/Kemetra), SHADOW_URL, FILTER_REPO (required: path of the pinned
# git-filter-repo), GIT_ASKPASS (optional, set by the caller for private reads; never picked up implicitly).
# Selftest only: SHADOW_LOCAL (local Shadow repo with refs/heads/main and origin/main) and SELFTEST_SRC (directory of
# <Repo>.git mirrors whose main is at the frozen sha and whose tags are exactly those of crosswalk/tags.tsv).
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$HERE/$(basename "$0")"
CHECK="$HERE/rt760_check.py"
FR="${FILTER_REPO:-}"
[ -z "$FR" ] || FR="$(realpath "$FR" 2>/dev/null || echo "$FR")"
SRC_BASE="${SRC_BASE:-https://github.com/Kemetra}"
SHADOW_URL="${SHADOW_URL:-https://github.com/Kemetra/retail-tower-shadow.git}"
PIN_GIT="git version 2.43.0"
PIN_FR_SHA256="67447413e273fc76809289111748870b6f6072f08b17efe94863a92d810b7d94"
PIN_PY="3.12."
PIN_NAME="Retail Tower history import"
PIN_EMAIL="history-import@kemetra.invalid"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0 TZ=UTC LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
unset PYTHONPATH PYTHONSTARTUP PYTHONHOME

STEP="setup"
RESULT=""
declare -A NEXT=(
  [setup]="Fix the usage or path error shown and rerun from a new OUT_DIR."
  [pins]="Run inside WSL Ubuntu with git 2.43.0, Python 3.12 and FILTER_REPO set to the pinned git-filter-repo (sha256 in PINS.tsv)."
  [anchors]="Recapture anchors into a new ANCHOR_DIR (never edit anchor files; check read access of the caller's GIT_ASKPASS) and rerun."
  [fetch]="Recapture anchors into a new ANCHOR_DIR (a source or tag moved after capture) and rerun."
  [ancestry]="Stop: a source main was rewritten (not a fast-forward of frozen). Escalate on RT-710; do not rerun."
  [inventory]="Classify the unknown ref namespace with the owner before any further run (R4 allowlist)."
  [lfs]="Stop: decide LFS handling with the owner (RT-710 R4) before re-importing this product."
  [filter]="Compare the git-filter-repo pin and the committed callback with the original build, then rerun."
  [crosswalk]="Stop: re-filtered history is not stable. Attach the xwalk evidence to RT-710 and ask the owner how to proceed."
  [merge]="Stop: do not resolve by hand. Attach evidence/merge-*.txt to RT-710 for an owner decision."
  [overlay]="Stop: identify which merge touched the overlay (evidence/overlay-*.tsv) and report it on RT-760."
  [pgraph]="Read evidence/pgraph-*.txt and file the failing check as a finding on RT-760 (do not change tools/)."
  [run]="Read the failing run's RESULT.txt; it names the first failing boundary and its next action."
  [repro]="Diff the two manifest.txt files and find the non-pinned input before any execution run."
  [tags]="Stop: the owner reviews evidence/<prod>.xwalk-diff.tsv NEW_TAG rows; only the owner may add approved lines to ANCHOR_DIR/approved-tags.tsv, then rerun into a new OUT_DIR."
  [incremental]="Stop: read evidence/incremental.txt and the FAIL line; report it on RT-760 (do not repair the candidate)."
)
fail() { RESULT="$*"; echo "FAIL[$STEP]: $*" >&2; exit 1; }
on_exit() {
  local rc=$?
  [ -n "${OUT_REPORT:-}" ] || return $rc
  if [ $rc -ne 0 ]; then
    printf 'NEEDS VERIFICATION\nfirst failing boundary: %s\ndetail: %s\nnext safe action: %s\n' \
      "$STEP" "${RESULT:-exit $rc (see stderr)}" "${NEXT[$STEP]:-Report the error on RT-760.}" > "$OUT_REPORT"
    cat "$OUT_REPORT" >&2
  fi
  return $rc
}
trap on_exit EXIT
# Python checks print "FAIL: ..." on stderr; keep that line as the report detail.
py() {
  local err rc=0
  err="$(mktemp)"
  python3 "$@" 2> "$err" || rc=$?
  cat "$err" >&2
  [ $rc -eq 0 ] || RESULT="$(grep -m1 '^FAIL' "$err" || tail -1 "$err")"
  rm -f "$err"
  [ $rc -eq 0 ] || exit $rc
}
pin() { GIT_AUTHOR_NAME="$PIN_NAME" GIT_AUTHOR_EMAIL="$PIN_EMAIL" GIT_AUTHOR_DATE="$PIN_DATE" \
        GIT_COMMITTER_NAME="$PIN_NAME" GIT_COMMITTER_EMAIL="$PIN_EMAIL" GIT_COMMITTER_DATE="$PIN_DATE" "$@"; }

check_pins() {
  STEP="pins"
  [ "$(git --version)" = "$PIN_GIT" ] || fail "git is '$(git --version)', want '$PIN_GIT'"
  [ -n "$FR" ] && [ -f "$FR" ] || fail "FILTER_REPO is not set to an existing file"
  [ "$(sha256sum "$FR" | cut -d' ' -f1)" = "$PIN_FR_SHA256" ] || fail "git-filter-repo at $FR does not match the pin"
  python3 -c "import sys; sys.exit(0 if sys.version.startswith('$PIN_PY') else 1)" || fail "python3 is not $PIN_PY"
  python3 -c "import yaml" 2>/dev/null || fail "PyYAML is not importable by python3"
}

# Newest import or re-import merge of a product reachable from Shadow main by ANY parent path, so imports that sit
# on the second-parent side of a GitHub PR merge are found (the first-parent walk of the RT-760 script is not enough
# once an earlier re-import landed through a PR). Same rule as base_tip() in tools/history/verify_incremental.py:
# subject match, pinned author identity, and no newer candidate may descend from it. Prints the merge or fails.
newest_import() {
  local g="$1" repo="$2" dir="$3" c s o a p hit newer cands=() newest=()
  while IFS=$'\t' read -r c s; do
    hit=0   # literal prefixes (no regex): Import|import|Re-Import|Re-import <repo> history (<dir>)
    for p in "Import" "import" "Re-Import" "Re-import"; do
      [[ "$s" == "$p $repo history ($dir)"* ]] && hit=1
    done
    [ $hit -eq 1 ] || continue
    a="$(git -C "$g" cat-file commit "$c" | awk '/^author /{print; exit}')"   # raw author line, as the verifier tests it
    [[ "$a" == "author $PIN_NAME <$PIN_EMAIL> "* ]] || continue
    cands+=("$c")
  done < <(git -C "$g" log --merges --format='%H%x09%s' refs/heads/main)
  for c in "${cands[@]}"; do
    newer=0
    for o in "${cands[@]}"; do
      if [ "$o" != "$c" ] && git -C "$g" merge-base --is-ancestor "$c" "$o"; then newer=1; break; fi
    done
    [ $newer -eq 1 ] || newest+=("$c")
  done
  [ ${#newest[@]} -eq 1 ] || return 1
  printf '%s\n' "${newest[0]}"
}

# Rows of frozen-committed.tsv (4 fields) and anchors.tsv (5 fields) end up in paths, regexes and git arguments:
# validate every field before use. The trust root is Shadow main, but the checks are cheap.
validate_rows() {  # file nfields
  local f="$1" n="$2" prod dir repo frozen new extra
  while IFS=$'\t' read -r prod dir repo frozen new extra; do
    [[ "$prod" =~ ^[a-z0-9-]+$ ]] || fail "$f: bad product name"
    [[ "$dir" =~ ^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$ ]] || fail "$f: bad directory for $prod"
    [[ "$repo" =~ ^[A-Za-z0-9-]+$ ]] || fail "$f: bad repository name for $prod"
    [[ "$frozen" =~ ^[0-9a-f]{40}$ ]] || fail "$f: bad frozen sha for $prod"
    if [ "$n" -eq 5 ]; then [[ "$new" =~ ^[0-9a-f]{40}$ ]] || fail "$f: bad new sha for $prod"
    else [ -z "${new:-}" ] || fail "$f: unexpected fifth field for $prod"; fi
    [ -z "${extra:-}" ] || fail "$f: unexpected extra field for $prod"
  done < "$f"
}

# --- anchors: one capture, read by every run ----------------------------------------------------------
cmd_anchors() {
  local anc="$1"
  STEP="anchors"
  [ ! -e "$anc" ] || fail "$anc exists"
  mkdir -p "$anc"
  local tmp="$anc/.shadow.git"
  git ls-remote "$SHADOW_URL" > "$anc/shadow-refs.txt"
  local ssha
  ssha="$(awk -F'\t' '$2=="refs/heads/main"{print $1}' "$anc/shadow-refs.txt")"
  [ -n "$ssha" ] || fail "no refs/heads/main on Shadow"
  git init -q --bare "$tmp"
  git -C "$tmp" fetch -q --no-tags "$SHADOW_URL" "+$ssha:refs/heads/main"
  git -C "$tmp" show main:tools/history/frozen.tsv > "$anc/frozen-committed.tsv"
  git -C "$tmp" show main:tools/history/repo-ids.tsv > "$anc/repo-ids.tsv"
  # Overlay manifest: mode, blob id and path of everything outside the product subtrees (.github/**, CODEOWNERS, tools/**).
  validate_rows "$anc/frozen-committed.tsv" 4
  local pdirs
  mapfile -t pdirs < <(cut -f2 "$anc/frozen-committed.tsv")
  python3 "$CHECK" overlay "$tmp" main "${pdirs[@]}" > "$anc/overlay.tsv"
  rm -rf "$tmp"
  printf 'main\t%s\n' "$ssha" > "$anc/shadow.tsv"
  printf 'pin_date\t%s\n' "${PIN_DATE:-$(date -u +%Y-%m-%dT00:00:00Z)}" > "$anc/pin.tsv"
  : > "$anc/anchors.tsv"
  while IFS=$'\t' read -r prod dir repo frozen; do
    git ls-remote "$SRC_BASE/$repo.git" > "$anc/refs-$repo.txt"
    local new
    new="$(awk -F'\t' '$2=="refs/heads/main"{print $1}' "$anc/refs-$repo.txt")"
    [ -n "$new" ] || fail "no refs/heads/main on $repo"
    printf '%s\t%s\t%s\t%s\t%s\n' "$prod" "$dir" "$repo" "$frozen" "$new" >> "$anc/anchors.tsv"
  done < "$anc/frozen-committed.tsv"
  (cd "$anc" && sha256sum anchors.tsv shadow.tsv pin.tsv repo-ids.tsv frozen-committed.tsv overlay.tsv refs-*.txt > SHA256SUMS)
  echo "ANCHORS OK: $anc"; cat "$anc/anchors.tsv"
}

# --- run: steps 2-5 and 7 into a clean OUT ------------------------------------------------------------
cmd_run() {
  local anc out
  anc="$(cd "$1" && pwd)"; out="$2"
  STEP="setup"
  [ ! -e "$out" ] || fail "$out exists"
  mkdir -p "$out"/{src,work,evidence,inputs}
  out="$(cd "$out" && pwd)"
  OUT_REPORT="$out/RESULT.txt"
  local ev="$out/evidence"
  check_pins
  STEP="anchors"
  (cd "$anc" && sha256sum --quiet -c SHA256SUMS) || fail "anchor files changed since capture"
  validate_rows "$anc/anchors.tsv" 5
  validate_rows "$anc/frozen-committed.tsv" 4
  PIN_DATE="$(cut -f2 "$anc/pin.tsv")"
  local ssha
  ssha="$(cut -f2 "$anc/shadow.tsv")"

  STEP="fetch"
  git init -q --bare "$out/shadow.git"
  git -C "$out/shadow.git" fetch -q --no-tags "$SHADOW_URL" "+$ssha:refs/heads/main" '+refs/tags/*:refs/tags/*'
  git -C "$out/shadow.git" symbolic-ref HEAD refs/heads/main
  mkdir -p "$out/at-shadow"
  git -C "$out/shadow.git" archive main tools/history | tar -x -C "$out/at-shadow"
  local hist="$out/at-shadow/tools/history"
  cmp -s "$hist/frozen.tsv" "$anc/frozen-committed.tsv" || fail "Shadow frozen.tsv differs from the anchored copy"
  local dirs=()
  while IFS=$'\t' read -r prod dir repo frozen new; do dirs+=("$dir"); done < "$anc/anchors.tsv"
  python3 "$CHECK" overlay "$out/shadow.git" main "${dirs[@]}" > "$ev/overlay-before.tsv"
  cmp -s "$ev/overlay-before.tsv" "$anc/overlay.tsv" || fail "Shadow overlay differs from the anchored overlay manifest"

  # step 1-2: sources by SHA, ref inventory, generated inputs/
  cp "$anc/repo-ids.tsv" "$out/inputs/repo-ids.tsv"
  : > "$out/inputs/frozen.tsv"
  while IFS=$'\t' read -r prod dir repo frozen new; do
    STEP="fetch"
    local src="$out/src/$prod.git"
    git init -q --bare "$src"
    git -C "$src" fetch -q --no-tags "$SRC_BASE/$repo.git" "+$new:refs/heads/main" '+refs/tags/*:refs/tags/*'
    git -C "$src" symbolic-ref HEAD refs/heads/main
    [ "$(git -C "$src" rev-parse refs/heads/main)" = "$new" ] || fail "$repo main != anchored $new"
    STEP="ancestry"
    git -C "$src" merge-base --is-ancestor "$frozen" "$new" || fail "$repo: $new is not a fast-forward of frozen $frozen"
    STEP="fetch"
    cp "$anc/refs-$repo.txt" "$out/inputs/refs-$repo.txt"
    if ! diff <(git -C "$src" for-each-ref refs/tags --format='%(objectname) %(refname)' | sort) \
              <(grep -P '\trefs/tags/' "$out/inputs/refs-$repo.txt" | awk -F'\t' '{print $1" "$2}' | sort) > "$ev/$prod.tagdrift.txt"; then
      fail "tag set of $repo differs from the anchored listing (see evidence/$prod.tagdrift.txt)"
    fi
    git -C "$src" for-each-ref refs/tags --format='%(refname) %(objecttype) %(objectname) %(*objectname)' > "$ev/$prod.tags-old.txt"
    printf '%s\t%s\t%s\t%s\n' "$prod" "$dir" "$repo" "$new" >> "$out/inputs/frozen.tsv"
    STEP="inventory"
    py "$hist/inventory.py" "$out/inputs/refs-$repo.txt" "$prod" "$new" "$ev/$prod.refs.tsv"
    STEP="lfs"
    py "$CHECK" lfs "$src" "$hist" "$prod" "$frozen" > "$ev/$prod.lfs.txt"
  done < "$anc/anchors.tsv"

  # step 3: re-filter with the committed callbacks, crosswalk, stability
  while IFS=$'\t' read -r prod dir repo frozen new; do
    STEP="filter"
    local work="$out/work/$prod.git"
    cp -a "$out/src/$prod.git" "$work"
    ( cd "$work" && python3 -I "$FR" --force --quiet \
        --to-subdirectory-filter "$dir" --tag-rename ":$prod/" \
        --commit-callback "$hist/callbacks/$prod.commit-callback.py" --preserve-commit-hashes \
        --prune-empty never --prune-degenerate never )
    py "$hist/mkcrosswalk.py" "$out/src/$prod.git" "$work" "$prod" "$ev"
    STEP="crosswalk"
    py "$CHECK" xwalk "$hist" "$ev" "$prod" > "$ev/$prod.xwalk.txt"
    STEP="tags"
    py "$CHECK" tagsgate "$hist" "$ev" "$prod" "$anc/approved-tags.tsv" > "$ev/$prod.tagsgate.txt"
    STEP="crosswalk"
    local imported tip_old tip_new
    imported="$(newest_import "$out/shadow.git" "$repo" "$dir")" || fail "no unique newest import merge for $repo on Shadow main"
    tip_old="$(git -C "$out/shadow.git" rev-parse "$imported^2")"
    [ "$(awk -F'\t' -v s="$frozen" '$1==s{print $2}' "$hist/crosswalk/$prod.tsv")" = "$tip_old" ] \
      || fail "$prod: committed crosswalk of frozen $frozen != Shadow import parent $tip_old"
    tip_new="$(git -C "$work" rev-parse refs/heads/main)"
    git -C "$work" merge-base --is-ancestor "$tip_old" "$tip_new" \
      || fail "$prod: Shadow's imported tip $tip_old is not an ancestor of the re-filtered tip $tip_new"
    printf '%s\t%s\t%s\n' "$prod" "$tip_old" "$tip_new" >> "$ev/filtered-tips.tsv"
  done < "$anc/anchors.tsv"

  # step 4: incremental --no-ff merges in a clone of Shadow main
  STEP="merge"
  local cand="$out/c"
  git clone -q "$out/shadow.git" "$cand"
  git -C "$cand" config core.autocrlf false
  while IFS=$'\t' read -r prod dir repo frozen new; do
    # Tags fetched without '+': an existing tag name with a different target is refused (tag collision).
    # Every product, so an approved new tag is imported even when its main did not move. All new tags passed the gate.
    git -C "$cand" fetch -q --no-tags "$out/work/$prod.git" "refs/tags/$prod/*:refs/tags/$prod/*" 2> "$ev/merge-$prod.fetch.txt" \
      || fail "$prod: tag collision while fetching re-filtered tags (evidence/merge-$prod.fetch.txt)"
    if [ "$new" = "$frozen" ]; then echo "$prod unchanged ($new)" >> "$ev/merge-log.txt"; continue; fi
    git -C "$cand" fetch -q --no-tags "$out/work/$prod.git" "+refs/heads/main:refs/imports/$prod" 2>> "$ev/merge-$prod.fetch.txt"
    if ! (cd "$cand" && pin git merge -q --no-ff --no-edit --no-gpg-sign \
            -m "Re-import $repo history ($dir) ${frozen:0:12}..${new:0:12}" "refs/imports/$prod") > "$ev/merge-$prod.txt" 2>&1; then
      git -C "$cand" diff --name-only --diff-filter=U >> "$ev/merge-$prod.txt" || true
      git -C "$cand" merge --abort || true
      fail "$prod: merge did not complete cleanly (evidence/merge-$prod.txt)"
    fi
    local outside
    outside="$(git -c core.quotepath=false -C "$cand" diff --no-renames --name-only HEAD^1 HEAD | awk -v d="$dir/" 'index($0,d)!=1' || true)"
    [ -z "$outside" ] || fail "$prod merge changes paths outside $dir/: $(echo "$outside" | head -3 | tr '\n' ' ')"
    [ "$(git -C "$cand" rev-parse "HEAD:$dir")" = "$(git -C "$out/src/$prod.git" rev-parse "$new^{tree}")" ] \
      || fail "$prod: candidate $dir tree != source $new^{tree}"
    [ "$(git -C "$cand" rev-parse HEAD^2)" = "$(git -C "$out/work/$prod.git" rev-parse refs/heads/main)" ] \
      || fail "$prod: merge second parent is not the re-filtered tip"
    echo "$prod merged $(git -C "$cand" rev-parse HEAD)" >> "$ev/merge-log.txt"
  done < "$anc/anchors.tsv"
  git -C "$cand" for-each-ref --format='%(refname)' refs/imports | while read -r r; do git -C "$cand" update-ref -d "$r"; done
  STEP="overlay"
  python3 "$CHECK" overlay "$cand" HEAD "${dirs[@]}" > "$ev/overlay-after.tsv"
  cmp -s "$ev/overlay-before.tsv" "$ev/overlay-after.tsv" || fail "overlay changed (diff evidence/overlay-before.tsv overlay-after.tsv)"
  while IFS=$'\t' read -r prod dir repo frozen new; do
    [ "$(git -C "$cand" rev-parse "HEAD:$dir")" = "$(git -C "$out/src/$prod.git" rev-parse "$new^{tree}")" ] \
      || fail "final candidate $dir tree != source $new^{tree}"
  done < "$anc/anchors.tsv"

  # step 7: commits, refs and file report
  git -C "$cand" log --reverse --format='%H%x09%T%x09%P%x09%s' "$ssha..HEAD" > "$ev/new-commits.tsv"
  diff <(git -C "$out/shadow.git" for-each-ref --format='%(refname) %(objectname)' refs/heads/main refs/tags) \
       <(git -C "$cand" for-each-ref --format='%(refname) %(objectname)' refs/heads/main refs/tags) > "$ev/refs-diff.txt" || true
  git -C "$cand" diff --no-renames --name-status "$ssha" HEAD > "$ev/files-report.tsv"

  # step 5: project-graph checks on the materialized candidate (worktree, short path)
  STEP="pgraph"
  local pg="$cand/tools/project-graph" rc=0 bad=""
  (cd "$pg" && python3 -m unittest discover -s tests) > "$ev/pgraph-unittest.txt" 2>&1 || bad+=" unittest"
  (cd "$pg" && python3 -m pgraph classify-tree --repo ../.. --rev HEAD) > "$ev/pgraph-classify-tree.json" 2>&1 || bad+=" classify-tree"
  (cd "$pg" && python3 -m pgraph privileges --repo ../..) > "$ev/pgraph-privileges.json" 2>&1 || bad+=" privileges"
  (cd "$pg" && python3 -m pgraph boundary --repo ../.. --rev HEAD) > "$ev/pgraph-boundary.json" 2>&1 || bad+=" boundary"
  python3 "$CHECK" cijobs "$cand" HEAD > "$ev/pgraph-cijobs.json" 2>&1 || bad+=" cijobs"
  [ -z "$bad" ] || fail "project-graph checks failed:$bad"

  # step 4/7 incremental invariants (tools/history/manifest.py only verifies a fresh build.sh output)
  STEP="incremental"
  py "$CHECK" incremental "$out/shadow.git" "$cand" "$anc" "$ev" "$hist" "$PIN_NAME <$PIN_EMAIL>" "$PIN_DATE" > "$ev/incremental.txt"

  write_manifest "$anc" "$out" "$ssha"
  printf 'OK\nall steps passed; manifest sha256 %s\n%s\n' "$(cut -d' ' -f1 "$out/manifest.sha256")" "$(pyyaml_precondition "$cand")" > "$OUT_REPORT"
  echo "DRY RUN OK: $out"
}

# PyYAML drift is a recorded live-run precondition (owner ruling), not a failure: only yaml.__version__ differs 6.0.1..6.0.3.
pyyaml_precondition() {
  local have pinned
  have="$(python3 -c 'import yaml; print(yaml.__version__)')"
  pinned="$(grep -oP '^PyYAML==\K[0-9.]+' "$1/tools/project-graph/requirements.txt" || echo unknown)"
  if [ "$have" = "$pinned" ]; then echo "PyYAML $have matches the requirements.txt pin"
  else echo "LIVE-RUN PRECONDITION: PyYAML $have != requirements.txt pin $pinned (owner ruling or pinned install required)"; fi
}

write_manifest() {
  local anc="$1" out="$2" ssha="$3" ev="$2/evidence" cand="$2/c" m="$2/manifest.txt"
  put() { printf '%s\t%s\n' "$1" "$2" >> "$m"; }
  : > "$m"
  put pin.git "$(git --version)"
  put pin.python "$(python3 -c 'import sys; print(sys.version.split()[0])')"
  put pin.pyyaml "$(python3 -c 'import yaml; print(yaml.__version__)')"
  put pin.filter-repo.version "$(python3 -I "$FR" --version)"
  put pin.filter-repo.sha256 "$PIN_FR_SHA256"
  put pin.identity "$PIN_NAME <$PIN_EMAIL> $PIN_DATE"
  put script.sha256.reimport-dryrun.sh "$(sha256sum "$HERE/reimport-dryrun.sh" | cut -d' ' -f1)"
  put script.sha256.rt760_check.py "$(sha256sum "$CHECK" | cut -d' ' -f1)"
  put anchors.sha256sums "$(sha256sum "$anc/SHA256SUMS" | cut -d' ' -f1)"
  put shadow.main "$ssha"
  put shadow.main-tree "$(git -C "$out/shadow.git" rev-parse "main^{tree}")"
  while IFS=$'\t' read -r prod dir repo frozen new; do
    put "$prod.frozen" "$frozen"
    put "$prod.new" "$new"
    put "$prod.commits-added" "$(git -C "$out/src/$prod.git" rev-list --count "$frozen..$new")"
    put "$prod.source-tree" "$(git -C "$out/src/$prod.git" rev-parse "$new^{tree}")"
    put "$prod.filtered-tip" "$(awk -F'\t' -v p="$prod" '$1==p{print $3}' "$ev/filtered-tips.tsv")"
    put "$prod.candidate-subtree($dir)" "$(git -C "$cand" rev-parse "HEAD:$dir")"
    while IFS=$'\t' read -r k v; do put "$prod.$k" "$v"; done < "$ev/$prod.xwalk.txt"
    put "$prod.crosswalk.sha256" "$(sha256sum "$ev/$prod.crosswalk.tsv" | cut -d' ' -f1)"
    put "$prod.tags.sha256" "$(sha256sum "$ev/$prod.tags.tsv" | cut -d' ' -f1)"
    put "$prod.refs-inventory.sha256" "$(sha256sum "$ev/$prod.refs.tsv" | cut -d' ' -f1)"
  done < "$anc/anchors.tsv"
  local i=0
  while IFS=$'\t' read -r c t p s; do i=$((i+1)); put "candidate.commit.$i" "$c tree=$t parents=$p"; done < "$ev/new-commits.tsv"
  put candidate.head "$(git -C "$cand" rev-parse HEAD)"
  put candidate.tree "$(git -C "$cand" rev-parse "HEAD^{tree}")"
  put candidate.ref-count "$(git -C "$cand" for-each-ref refs/heads/main refs/tags | wc -l)"
  put candidate.refs-diff.sha256 "$(sha256sum "$ev/refs-diff.txt" | cut -d' ' -f1)"
  put candidate.overlay.sha256 "$(sha256sum "$ev/overlay-after.tsv" | cut -d' ' -f1)"
  put candidate.files "$(awk -F'\t' '{n[substr($1,1,1)]++} END{printf "A=%d M=%d D=%d T=%d", n["A"], n["M"], n["D"], n["T"]}' "$ev/files-report.tsv")"
  put candidate.files-report.sha256 "$(sha256sum "$ev/files-report.tsv" | cut -d' ' -f1)"
  put pgraph.ci-job-missing "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(d["ci_job_missing"]))' "$ev/pgraph-cijobs.json")"
  put approved-tags.sha256 "$( [ -f "$anc/approved-tags.tsv" ] && sha256sum "$anc/approved-tags.tsv" | cut -d' ' -f1 || echo none)"
  while IFS=$'\t' read -r prod dir repo frozen new; do
    while IFS=$'\t' read -r k v; do put "$prod.gate.$k" "$v"; done < "$ev/$prod.tagsgate.txt"
  done < "$anc/anchors.tsv"
  while IFS=$'\t' read -r k v; do put "incremental.$k" "$v"; done < "$ev/incremental.txt"
  put precondition.pyyaml "$(pyyaml_precondition "$cand")"
  (cd "$out" && sha256sum manifest.txt > manifest.sha256)
}

# --- open Shadow branches / PRs: informational, outside the reproducibility manifest -----------------------
branch_report() {
  local anc="$1" out="$2" cand="$2/c" rep="$2/evidence/branches-report.tsv"
  printf 'ref\tanchored_sha\tcontains_shadow_main\tmerge_tree_vs_candidate\n' > "$rep"
  git -C "$cand" fetch -q --no-tags "$SHADOW_URL" '+refs/heads/*:refs/anchored/heads/*' '+refs/pull/*/head:refs/anchored/pull/*' || true
  grep -P '\t(refs/heads/|refs/pull/\d+/head$)' "$anc/shadow-refs.txt" | while IFS=$'\t' read -r sha ref; do
    [ "$ref" = refs/heads/main ] && continue
    if ! git -C "$cand" cat-file -e "$sha^{commit}" 2>/dev/null; then printf '%s\t%s\tunknown\tNOT_FETCHED\n' "$ref" "$sha" >> "$rep"; continue; fi
    local anc_main="no" mt="clean"
    git -C "$cand" merge-base --is-ancestor "$(cut -f2 "$anc/shadow.tsv")" "$sha" && anc_main="yes"
    git -C "$cand" merge-tree --write-tree HEAD "$sha" > /dev/null 2>&1 || mt="CONFLICT"
    printf '%s\t%s\t%s\t%s\n' "$ref" "$sha" "$anc_main" "$mt" >> "$rep"
  done
}

cmd_repro() {
  local anc="$1" root="$2"
  STEP="setup"
  [ ! -e "$root" ] || fail "$root exists"
  mkdir -p "$root"
  OUT_REPORT="$root/RESULT.txt"
  STEP="run"
  "$SELF" run "$anc" "$root/a" || fail "run a failed (a/RESULT.txt)"
  "$SELF" run "$anc" "$root/b" || fail "run b failed (b/RESULT.txt)"
  STEP="repro"
  diff "$root/a/manifest.txt" "$root/b/manifest.txt" > "$root/repro-diff.txt" || fail "manifests differ (repro-diff.txt)"
  STEP="setup"
  branch_report "$anc" "$root/a" || echo "WARN: branch report incomplete" >&2
  printf 'OK\nreproducible: run a and b manifests identical, sha256 %s\n' "$(cut -d' ' -f1 "$root/a/manifest.sha256")" > "$OUT_REPORT"
  cat "$OUT_REPORT"
}

# --- selftest: offline, frozen mirrors + one synthetic commit on POS ------------------------------------------
cmd_selftest() {
  local root="$1"
  STEP="setup"
  [ ! -e "$root" ] || fail "$root exists"
  mkdir -p "$root/srcs"
  root="$(cd "$root" && pwd)"
  local shadow_local="${SHADOW_LOCAL:-}" selftest_src="${SELFTEST_SRC:-}"
  [ -d "$shadow_local" ] || fail "SHADOW_LOCAL is not set to a local Shadow repository"
  [ -d "$selftest_src" ] || fail "SELFTEST_SRC is not set to a directory of <Repo>.git mirrors"
  while IFS=$'\t' read -r prod dir repo frozen; do
    [ -d "$selftest_src/$repo.git" ] || fail "SELFTEST_SRC has no $repo.git"
    cp -a "$selftest_src/$repo.git" "$root/srcs/$repo.git"
    git -C "$root/srcs/$repo.git" symbolic-ref HEAD refs/heads/main
    [ "$(git -C "$root/srcs/$repo.git" rev-parse refs/heads/main)" = "$frozen" ] || fail "$repo main in SELFTEST_SRC is not at frozen $frozen"
  done < <(git -C "$shadow_local" show origin/main:tools/history/frozen.tsv)
  # Synthetic local-only commits on two products (two sequential merges); Admin-Console also gets a new lightweight tag.
  local repo wt="$root/synthetic"
  for repo in Admin-Console POS; do
    git clone -q -b main "$root/srcs/$repo.git" "$wt"
    echo "RT-760 selftest synthetic change for $repo (local only)" > "$wt/rt760-selftest.txt"
    git -C "$wt" add rt760-selftest.txt
    (cd "$wt" && PIN_DATE="2026-10-20T00:00:00Z" pin git commit -q --no-gpg-sign -m "test: RT-760 selftest synthetic commit (#1)")
    git -C "$wt" push -q origin main
    rm -rf "$wt"
  done
  local ac="$root/srcs/Admin-Console.git" bc="$root/srcs/Backend-Core.git" tagc
  git -C "$ac" update-ref "refs/tags/admin-console-$(git -C "$ac" rev-parse --short=12 main)" "$(git -C "$ac" rev-parse main)"
  # Backend-Core: main unchanged, one new tag on an off-main commit (tag-only lineage, exercises tag import + LFS scan).
  tagc="$(cd "$root" && PIN_DATE="2026-10-20T00:00:00Z" pin git -C "$bc" commit-tree -p main -m "test: RT-760 tag-only synthetic commit" "main^{tree}")"
  git -C "$bc" update-ref "refs/tags/backend-core-${tagc:0:12}" "$tagc"
  SRC_BASE="$root/srcs" SHADOW_URL="$shadow_local" PIN_DATE="2026-10-20T00:00:00Z" "$SELF" anchors "$root/anchors"
  # SYNTHETIC owner approval for the two synthetic tags only. A live run never writes this file; the owner does.
  printf 'admin-console\trefs/tags/admin-console-%s\t%s\nbackend-core\trefs/tags/backend-core-%s\t%s\n' \
    "$(git -C "$ac" rev-parse --short=12 main)" "$(git -C "$ac" rev-parse main)" "${tagc:0:12}" "$tagc" > "$root/anchors/approved-tags.tsv"
  SRC_BASE="$root/srcs" SHADOW_URL="$shadow_local" "$SELF" repro "$root/anchors" "$root/r"
}

case "${1:-}" in
  anchors)  [ $# -eq 2 ] || fail "usage: $0 anchors ANCHOR_DIR"; check_pins; cmd_anchors "$2" ;;
  run)      [ $# -eq 3 ] || fail "usage: $0 run ANCHOR_DIR OUT_DIR"; cmd_run "$2" "$3" ;;
  repro)    [ $# -eq 3 ] || fail "usage: $0 repro ANCHOR_DIR OUT_ROOT"; cmd_repro "$2" "$3" ;;
  selftest) [ $# -eq 2 ] || fail "usage: $0 selftest OUT_ROOT"; check_pins; cmd_selftest "$2" ;;
  *) grep -E '^#   reimport-dryrun.sh' "$0" | sed 's/^# *//'; exit 2 ;;
esac
