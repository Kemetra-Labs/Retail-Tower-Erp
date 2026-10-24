#!/bin/bash
# Local Docker proof that a published mirror is installable and upgradable by bench (RT-712 acceptance).
# Usage: bench-proof.sh 15|16 SOURCE_CHECKOUT BASE_SHA FROZEN_MIRROR_BARE WORKDIR
#   SOURCE_CHECKOUT  a THROWAWAY clone of the monorepo carrying two source tags on connector commits:
#                    erpnext-connector/v0.1.0 and erpnext-connector/v0.2.0 (v0.2.0 a descendant of v0.1.0)
#   BASE_SHA         source commit whose subtree is FROZEN_MIRROR_BARE's main (publish.py --base)
#   FROZEN_MIRROR_BARE  bare clone of the frozen live Connector repo; it is COPIED, never pushed to
# Everything is local: containers frappe/erpnext:v$1 + mariadb + redis on a private network, removed at the end.
# The mirror is mounted into the container, served by `git daemon` and cloned by `bench get-app git://...` (a real clone, like a remote URL).
# Test-only credentials below belong to the disposable containers.
set -uo pipefail
V="$1"; BASE="$3"
# native (C:/...) paths so git, python and docker agree on Windows; plain paths elsewhere
np() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
SRC="$(np "$2")"; FROZEN="$(np "$4")"; W="$(np "$5")"
HERE="$(np "$(cd "$(dirname "$0")" && pwd)")"
export MSYS_NO_PATHCONV=1 GIT_TERMINAL_PROMPT=0
N="rt712-v$V"; MIR="$W/ERPNext-Connector.git"; APP=retail_tower_erpnext_connector
PUB=(python "$HERE/publish.py" --mirror "$MIR" --source-repo Kemetra/Retail-Tower-Shadow --source-dir "$SRC")
BENCH_DIR=/home/frappe/frappe-bench
step() { echo; echo "=== [v$V] $*"; }
dx() { docker exec -u frappe -w $BENCH_DIR -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' "$N-bench" bash -c "$1"; }
cleanup() { docker rm -f "$N-bench" "$N-db" "$N-redis" >/dev/null 2>&1; docker network rm "$N" >/dev/null 2>&1; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

step "stage mirror v0.1.0 only (source-ref = tag), then start containers"
rm -rf "$MIR"; git clone -q --bare "$FROZEN" "$MIR"
"${PUB[@]}" --base "$BASE" --source-ref erpnext-connector/v0.1.0 || fail publish-v1
cleanup
docker network create "$N" >/dev/null
docker run -d --name "$N-db" --network "$N" -e MARIADB_ROOT_PASSWORD=root mariadb:11.8 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
docker run -d --name "$N-redis" --network "$N" redis:7-alpine >/dev/null
docker run -d --name "$N-bench" --network "$N" -v "$W:/w" --entrypoint bash "frappe/erpnext:v$V" -c "sleep infinity" >/dev/null
sleep 20
dx "bench --version; python --version; node --version; bench version | tr '\n' ' '"

# bench treats a local path as a repo to link, not clone; a git:// URL goes through the real clone path
dx "(nohup git daemon --reuseaddr --base-path=/w --export-all --listen=127.0.0.1 /w >/tmp/gd.log 2>&1 &) ; sleep 2; git ls-remote git://127.0.0.1/ERPNext-Connector.git main" || fail git-daemon

step "scratch site with ERPNext"
dx "bench set-config -g db_host $N-db && bench set-config -g redis_cache redis://$N-redis:6379 && \
    bench set-config -g redis_queue redis://$N-redis:6379 && bench set-config -g redis_socketio redis://$N-redis:6379 && \
    bench new-site rt712.local --mariadb-root-password root --admin-password admin --install-app erpnext --set-default --mariadb-user-host-login-scope=% 2>&1 | tail -5" \
  || fail new-site

step "1. pinned install: bench get-app --branch v0.1.0 + install-app + migrate"
dx "bench get-app git://127.0.0.1/ERPNext-Connector.git --branch v0.1.0 2>&1 | tail -6 && \
    bench --site rt712.local install-app $APP 2>&1 | tail -3 && bench --site rt712.local migrate 2>&1 | tail -3 && \
    bench --site rt712.local list-apps && git -C apps/$APP describe --tags --exact-match && git -C apps/$APP log -1 --format='HEAD %h %s' && ls apps/$APP | head -20" \
  || fail pinned-install

step "2. reinstall (uninstall + install) and drop app for the update proof"
dx "bench --site rt712.local uninstall-app $APP --yes --no-backup 2>&1 | tail -2 && \
    bench --site rt712.local install-app $APP 2>&1 | tail -2 && bench --site rt712.local list-apps | grep $APP && \
    bench --site rt712.local uninstall-app $APP --yes --no-backup 2>&1 | tail -1 && bench remove-app $APP 2>&1 | tail -2" \
  || fail reinstall

step "3. branch install at v0.1.0 tip, then publish v0.2.0 and bench update (fast-forward)"
dx "bench get-app git://127.0.0.1/ERPNext-Connector.git --branch main 2>&1 | tail -3 && bench --site rt712.local install-app $APP 2>&1 | tail -2 && \
    git -C apps/$APP rev-parse HEAD > /tmp/head_before && cat /tmp/head_before &&     git -C apps/$APP remote -v && git -C apps/$APP status -sb | head -2" || fail branch-install
"${PUB[@]}" --base "$BASE" || fail publish-v2
# `bench update` runs `git pull` per app. The stock frappe/erpnext image ships frappe and erpnext WITHOUT .git, so the CLI
# aborts on them (not on the connector). Try the CLI, record its output, then run the very same per-app step it performs.
dx "git -C apps/$APP fetch -q upstream && echo behind=\$(git -C apps/$APP rev-list --count HEAD..upstream/main);     bench update --pull --apps $APP --no-backup 2>&1 | grep -vE '^\s*(\^|File|return|raise)' | tail -12;     echo \"HEAD after bench update CLI: \$(git -C apps/$APP rev-parse --short HEAD)\"" || true
dx "[ \$(git -C apps/$APP rev-parse HEAD) != \$(git -C apps/$APP rev-parse upstream/main) ] && git -C apps/$APP pull --ff-only upstream main 2>&1 | tail -4;     git -C apps/$APP rev-parse HEAD > /tmp/head_after && cat /tmp/head_after &&     git -C apps/$APP merge-base --is-ancestor \$(cat /tmp/head_before) \$(cat /tmp/head_after) && echo 'ANCESTOR: old HEAD is an ancestor of new HEAD (fast-forward, no reset)' &&     [ \$(cat /tmp/head_before) != \$(cat /tmp/head_after) ] && echo 'HEAD MOVED' && git -C apps/$APP reflog -4 &&     git -C apps/$APP fetch -q --tags upstream && git -C apps/$APP describe --tags --exact-match &&     bench --site rt712.local migrate 2>&1 | tail -3 && bench --site rt712.local list-apps | grep $APP"   || fail bench-update

step "4. tree equality of the checked-out app vs the monorepo subtree at the tagged source commit"
SRC_TREE="$(git -C "$SRC" rev-parse "erpnext-connector/v0.2.0^{commit}:integrations/erpnext-connector")"
BENCH_TREE="$(dx "git -C apps/$APP rev-parse HEAD^{tree}" | tr -d '\r')"
echo "source subtree $SRC_TREE / bench checkout tree $BENCH_TREE"
[ "$SRC_TREE" = "$BENCH_TREE" ] && echo "TREE-EQUAL" || fail tree-mismatch
echo "RESULT v$V: PASS"
