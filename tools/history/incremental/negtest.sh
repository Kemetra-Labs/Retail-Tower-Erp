#!/bin/bash
# RT-760 fail-closed checks for reimport-dryrun.sh. Offline: reuses the selftest output in $NEG_ROOT/st
# (st/srcs mirrors with synthetic commits and tags, st/anchors, and the passing run st/r/a). Run
# "reimport-dryrun.sh selftest $NEG_ROOT/st" first. Re-created from the RT-760 script (see PINS.tsv): the
# machine-specific paths became NEG_ROOT and SHADOW_LOCAL; FILTER_REPO must be set for the dry-run script.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "${FILTER_REPO:-}" ] || { echo "set FILTER_REPO to the pinned git-filter-repo" >&2; exit 2; }
FILTER_REPO="$(realpath "$FILTER_REPO")"; export FILTER_REPO   # absolute before the cd below
[ -d "${SHADOW_LOCAL:-}" ] || { echo "set SHADOW_LOCAL to the local Shadow repository used by the selftest" >&2; exit 2; }
SHADOW_LOCAL="$(realpath "$SHADOW_LOCAL")"
cd "${NEG_ROOT:?set NEG_ROOT to the directory that holds st/ (the selftest output)}" || exit 2
[ -d st/srcs ] && [ -d st/anchors ] && [ -d st/r/a ] || { echo "NEG_ROOT/st is not a selftest output" >&2; exit 2; }
rm -rf neg && mkdir neg
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x
SH="${SHADOW_LOCAL:?set SHADOW_LOCAL to the local Shadow repository used by the selftest}"
ENVS=(SHADOW_URL="$SH" PIN_DATE=2026-10-20T00:00:00Z)
APPROVED="$PWD/st/anchors/approved-tags.tsv"

anchors() {  # name srcs
  env SRC_BASE="$PWD/neg/$2" "${ENVS[@]}" "$HERE/reimport-dryrun.sh" anchors "neg/a-$1" > /dev/null 2>&1
}
run() {  # name srcs
  local rc=0
  env SRC_BASE="$PWD/neg/$2" "${ENVS[@]}" "$HERE/reimport-dryrun.sh" run "neg/a-$1" "neg/o-$1" > /dev/null 2>&1 || rc=$?
  echo "== $1 exit=$rc"; cat "neg/o-$1/RESULT.txt"
}
attempt() { anchors "$1" "$2"; run "$1" "$2"; }

# N1: an existing Backend-Core tag now points somewhere else (tag collision)
cp -a st/srcs neg/n1
t=$(git -C neg/n1/Backend-Core.git for-each-ref refs/tags --format='%(refname)' | head -1)
git -C neg/n1/Backend-Core.git update-ref "$t" "$(git -C neg/n1/Backend-Core.git rev-parse main~3)"
attempt tag-moved n1

# N2: POS main rewritten, frozen commit no longer an ancestor
cp -a st/srcs neg/n2
p=neg/n2/POS.git
git -C $p update-ref refs/heads/main "$(git -C $p commit-tree "main~2^{tree}" -p main~2 -m rewritten)"
attempt non-ff n2

# N3: new main commit adds an LFS pointer
cp -a st/srcs neg/n3
git clone -q -b main neg/n3/POS.git neg/w3
printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize 1\n' 0 > neg/w3/big.bin
git -C neg/w3 add big.bin && git -C neg/w3 commit -q -m lfs && git -C neg/w3 push -q origin main
attempt lfs-main n3

# N4: anchors edited after capture
cp -a st/anchors neg/a-tamper
echo x >> neg/a-tamper/anchors.tsv
"$HERE/reimport-dryrun.sh" run neg/a-tamper neg/o-tamper > /dev/null 2>&1
echo "== tamper exit=$?"; cat neg/o-tamper/RESULT.txt

# N5: new tags present, no approval file (anchors must never create one)
ln -s "$PWD/st/srcs" neg/n5
anchors unapproved n5
echo "== anchors-writes-no-approval: $([ -e neg/a-unapproved/approved-tags.tsv ] && echo FAIL-file-created || echo OK-no-file)"
run unapproved n5

# N6: approval file lists a tag that does not exist (stale approval)
ln -s "$PWD/st/srcs" neg/n6
anchors stale n6
cp "$APPROVED" neg/a-stale/approved-tags.tsv
printf 'pos\trefs/tags/pos-000000000000\t%040d\n' 0 >> neg/a-stale/approved-tags.tsv
run stale n6

# N7: approval names the right tag but the wrong source commit
ln -s "$PWD/st/srcs" neg/n7
anchors wrong-target n7
sed -E '/^admin-console/ s/\t[0-9a-f]{40}$/\t1111111111111111111111111111111111111111/' "$APPROVED" > neg/a-wrong-target/approved-tags.tsv
run wrong-target n7

# N8: malformed approval line
ln -s "$PWD/st/srcs" neg/n8
anchors malformed n8
printf 'admin-console refs/tags/x deadbeef\n' > neg/a-malformed/approved-tags.tsv
run malformed n8

# N9: LFS pointer reachable only from a new tag (not from main)
cp -a st/srcs neg/n9
b=neg/n9/Backend-Core.git
blob=$(printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize 1\n' 0 | git -C $b hash-object -w --stdin)
tree=$(printf '100644 blob %s\tbig.bin\n' "$blob" | git -C $b mktree)
c=$(git -C $b commit-tree "$tree" -p main -m "lfs on a tag")
git -C $b update-ref "refs/tags/backend-core-${c:0:12}" "$c"
attempt lfs-tag n9

# N10-N14: incremental verifier against tampered copies of the passing candidate st/r/a
inc() {  # name ; candidate in neg/inc-<name>/c
  local d="neg/inc-$1"
  local rc=0
  python3 "$HERE/rt760_check.py" incremental "$d/shadow.git" "$d/c" "$d/anc" "$d/evidence" "$d/at-shadow/tools/history" \
    "Retail Tower history import <history-import@kemetra.invalid>" "2026-10-20T00:00:00Z" > /dev/null 2> "$d.err" || rc=$?
  echo "$rc" > "$d.rc"
  echo "== incremental-$1 exit=$rc $(grep -m1 FAIL "$d.err")"
}
mkinc() { cp -a st/r/a "neg/inc-$1"; cp -a st/anchors "neg/inc-$1/anc"; }
mkinc baseline; inc baseline
mkinc extra-tag; git -C neg/inc-extra-tag/c tag pos/unapproved-tag HEAD; inc extra-tag
mkinc new-root; r=$(git -C neg/inc-new-root/c commit-tree "$(git -C neg/inc-new-root/c mktree < /dev/null)" -m orphan)
  git -C neg/inc-new-root/c update-ref refs/tags/pos/orphan "$r"; inc new-root
mkinc extra-commit; ( cd neg/inc-extra-commit/c && echo x >> CODEOWNERS && git commit -q -am "overlay edit" ); inc extra-commit
mkinc identity; ( cd neg/inc-identity/c && m2=$(git rev-parse HEAD^2) && git reset -q --hard HEAD^ && \
  git merge -q --no-ff --no-edit -m "$(git -C ../../../st/r/a/c log -1 --format=%s HEAD)" "$m2" ); inc identity
# N15: an existing (committed) crosswalk mapping is remapped -> xwalk and incremental must both fail
mkinc remap
sed -i -E '2s/^([0-9a-f]{40})\t[0-9a-f]{40}/\1\t2222222222222222222222222222222222222222/' neg/inc-remap/evidence/admin-console.crosswalk.tsv
rc=0; python3 "$HERE/rt760_check.py" xwalk neg/inc-remap/at-shadow/tools/history neg/inc-remap/evidence admin-console > /dev/null 2> neg/inc-remap.xwalk.err || rc=$?
echo "$rc" > neg/inc-remap.xwalk.rc
echo "== xwalk-remap exit=$rc $(grep -m1 FAIL neg/inc-remap.xwalk.err)"
inc remap
# N16: an extra crosswalk row mapping to an already-reachable commit -> only the commit count can catch it
mkinc count
printf '%040d\t%s\t\n' 3 "$(git -C neg/inc-count/c rev-parse HEAD^2)" >> neg/inc-count/evidence/pos.crosswalk.tsv
inc count
mkinc overlay-anchor; sed -i -E '1s/\t[0-9a-f]{40}\t/\t0000000000000000000000000000000000000000\t/' neg/inc-overlay-anchor/anc/overlay.tsv; inc overlay-anchor

# --- assertions: every case must fail (or pass, for the baseline) at the intended boundary --------------------
FAILS=0; TOTAL=0
miss() { echo "ASSERT FAIL: $*"; FAILS=$((FAILS+1)); }
expect_step() {  # case boundary: the dry run must stop there, with a RESULT.txt saying so
  TOTAL=$((TOTAL+1))
  grep -qx "first failing boundary: $2" "neg/o-$1/RESULT.txt" 2>/dev/null || miss "$1: expected first failing boundary '$2'"
}
expect_inc() {  # err-file rc-file pattern: the check must exit non-zero with a FAIL line containing the pattern
  TOTAL=$((TOTAL+1))
  [ "$(cat "$2" 2>/dev/null)" != 0 ] || miss "$1: expected a non-zero exit"
  grep -q "^FAIL: .*$3" "$1" 2>/dev/null || miss "$1: expected a FAIL line containing '$3'"
}
expect_step tag-moved crosswalk
expect_step non-ff ancestry
expect_step lfs-main lfs
expect_step tamper anchors
expect_step unapproved tags
expect_step stale tags
expect_step wrong-target tags
expect_step malformed tags
expect_step lfs-tag lfs
TOTAL=$((TOTAL+1)); [ ! -e neg/a-unapproved/approved-tags.tsv ] || miss "anchors created an approved-tags.tsv"
TOTAL=$((TOTAL+1)); { [ "$(cat neg/inc-baseline.rc)" = 0 ] && [ ! -s neg/inc-baseline.err ]; } || miss "incremental baseline must pass cleanly"
expect_inc neg/inc-extra-tag.err neg/inc-extra-tag.rc "ref set mismatch"
expect_inc neg/inc-new-root.err neg/inc-new-root.rc "parentless commits changed"
expect_inc neg/inc-extra-commit.err neg/inc-extra-commit.rc "first-parent chain has"
expect_inc neg/inc-identity.err neg/inc-identity.rc "identity not pinned"
expect_inc neg/inc-remap.xwalk.err neg/inc-remap.xwalk.rc "existing commits missing or re-hashed"
expect_inc neg/inc-remap.err neg/inc-remap.rc "committed crosswalk mapping missing or changed"
expect_inc neg/inc-count.err neg/inc-count.rc "commit count"
expect_inc neg/inc-overlay-anchor.err neg/inc-overlay-anchor.rc "candidate overlay differs from the anchored overlay manifest"
echo "negtest: $TOTAL assertions, $FAILS failed"
[ "$FAILS" -eq 0 ]
