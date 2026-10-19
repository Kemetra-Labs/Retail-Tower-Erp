#!/bin/bash
# Deterministic history import for Kemetra/Retail-Tower-Shadow (RT-710, G1 + R4).
# Usage: build.sh OUT_DIR   (OUT_DIR must not exist). Needs $GH_TOKEN only for the fetch via GIT_ASKPASS.
# Output is non-authoritative and regenerated from frozen.tsv; never edit by hand.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"
FR="${FILTER_REPO:-$HOME/rt710/tools/git-filter-repo}"
[ ! -e "$OUT" ] || { echo "FAIL: $OUT exists"; exit 2; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0 TZ=UTC LC_ALL=C.UTF-8
export GIT_ASKPASS="${GIT_ASKPASS:-$HOME/rt710/askpass.sh}"
PIN_NAME="Retail Tower history import"
PIN_EMAIL="history-import@kemetra.invalid"
PIN_DATE="2026-10-19T00:00:00Z"
pin() { GIT_AUTHOR_NAME="$PIN_NAME" GIT_AUTHOR_EMAIL="$PIN_EMAIL" GIT_AUTHOR_DATE="$PIN_DATE" \
        GIT_COMMITTER_NAME="$PIN_NAME" GIT_COMMITTER_EMAIL="$PIN_EMAIL" GIT_COMMITTER_DATE="$PIN_DATE" "$@"; }

mkdir -p "$OUT"/{src,work,evidence}
SHADOW="$OUT/shadow"

# --- 1. fetch frozen sources (main + tags only), assert no drift, build ref inventory -----------
while IFS=$'\t' read -r prod dir repo sha; do
  src="$OUT/src/$prod.git"
  git init -q --bare "$src"
  # The frozen commit is fetched by SHA, so a moving live main cannot change the inputs; tags must match the freeze listing.
  git -C "$src" fetch -q --no-tags "https://github.com/Kemetra/$repo.git" \
      "+$sha:refs/heads/main" '+refs/tags/*:refs/tags/*'
  got="$(git -C "$src" rev-parse refs/heads/main)"
  [ "$got" = "$sha" ] || { echo "FAIL: fetched main $got != frozen $sha ($repo)"; exit 3; }
  if ! diff <(git -C "$src" for-each-ref refs/tags --format='%(objectname) %(refname)' | sort) \
            <(grep -P '\trefs/tags/' "$HERE/inputs/refs-$repo.txt" | awk -F'\t' '{print $1" "$2}' | sort) > /dev/null; then
    echo "FAIL: tag set of $repo differs from the freeze listing"; exit 3
  fi
  live="$(git ls-remote "https://github.com/Kemetra/$repo.git" refs/heads/main | cut -f1)"
  echo "$repo frozen=$sha live-main-now=$live" >> "$OUT/evidence/drift-note.txt"
  git -C "$src" for-each-ref refs/tags --format='%(refname) %(objecttype) %(objectname) %(*objectname)' > "$OUT/evidence/$prod.tags-old.txt"
  python3 "$HERE/inventory.py" "$HERE/inputs/refs-$repo.txt" "$prod" "$sha" "$OUT/evidence/$prod.refs.tsv"
done < "$HERE/frozen.tsv"

# --- 2. filter each product into its subdirectory ----------------------------------------------
while IFS=$'\t' read -r prod dir repo sha; do
  work="$OUT/work/$prod.git"
  cp -a "$OUT/src/$prod.git" "$work"
  cb="$OUT/work/$prod.commit-callback.py"
  cat > "$cb" <<EOF
import re
msg = commit.message
msg = re.sub(rb"(?<![\w/&#:.-])#(\d{1,5})(?!\w)", rb"Kemetra/$repo#\1", msg)
body = msg.rstrip(b"\n")
paras = body.split(b"\n\n")
is_trailers = len(paras) > 1 and all(re.match(rb"^[A-Za-z][A-Za-z0-9-]*: ", l) for l in paras[-1].split(b"\n"))
commit.message = body + (b"\n" if is_trailers else b"\n\n") + b"Original-Commit: " + commit.original_id + b"\n"
EOF
  ( cd "$work" && python3 "$FR" --force --quiet \
      --to-subdirectory-filter "$dir" --tag-rename ":$prod/" \
      --commit-callback "$cb" --preserve-commit-hashes \
      --prune-empty never --prune-degenerate never )
  python3 "$HERE/mkcrosswalk.py" "$OUT/src/$prod.git" "$work" "$prod" "$OUT/evidence"
done < "$HERE/frozen.tsv"

# --- 3. combine: empty root, fixed-order unrelated merges, overlay ---------------------------------
git init -q -b main "$SHADOW"
cd "$SHADOW"
git config core.autocrlf false
pin git commit -q --allow-empty --no-gpg-sign -m "Root: Retail Tower history import (empty)"
while IFS=$'\t' read -r prod dir repo sha; do
  git fetch -q --no-tags "$OUT/work/$prod.git" "+refs/heads/main:refs/imports/$prod" "+refs/tags/*:refs/tags/*"
  pin git merge -q --no-ff --no-edit --no-gpg-sign --allow-unrelated-histories \
      -m "Import $repo history ($dir) at $sha" "refs/imports/$prod"
done < "$HERE/frozen.tsv"
git for-each-ref --format='%(refname)' refs/imports | while read -r r; do git update-ref -d "$r"; done

mkdir -p tools/history/crosswalk tools/history/refs tools/history/callbacks
cp "$HERE"/build.sh "$HERE"/frozen.tsv "$HERE"/inventory.py "$HERE"/mkcrosswalk.py "$HERE"/manifest.py "$HERE"/scan.py tools/history/
cp "$HERE/README.md" tools/history/README.md
cp "$HERE/inputs/repo-ids.tsv" tools/history/repo-ids.tsv
cp "$OUT"/evidence/*.crosswalk.tsv tools/history/crosswalk/ 2>/dev/null || true
for f in "$OUT"/evidence/*.crosswalk.tsv; do b="$(basename "$f" .crosswalk.tsv)"; mv "tools/history/crosswalk/$(basename "$f")" "tools/history/crosswalk/$b.tsv"; done
cat "$OUT"/evidence/*.tags.tsv | sort > tools/history/crosswalk/tags.tsv
for f in "$OUT"/evidence/*.refs.tsv; do cp "$f" "tools/history/refs/$(basename "$f" .refs.tsv).tsv"; done
cp "$OUT"/work/*.commit-callback.py tools/history/callbacks/
git add -A tools/history
pin git commit -q --no-gpg-sign -m "Add history-import tooling, crosswalk and ref inventory (non-authoritative shadow)"
cd "$HERE"

# --- 4. verify + manifest -----------------------------------------------------------------------------
python3 "$HERE/scan.py" "$SHADOW" > "$OUT/evidence/scan-report.txt"
python3 "$HERE/manifest.py" "$OUT" "$HERE" "$FR" "$PIN_NAME" "$PIN_EMAIL" "$PIN_DATE" > "$OUT/manifest.txt"
sha256sum "$OUT/manifest.txt" | tee "$OUT/manifest.sha256"
echo "BUILD OK: $OUT"
