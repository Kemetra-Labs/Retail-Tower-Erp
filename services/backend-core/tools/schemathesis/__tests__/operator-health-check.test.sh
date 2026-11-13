#!/usr/bin/env bash
# RT-1387: run.sh passes --suppress-health-check=filter_too_much to the Schemathesis
# run in operator mode only (RT-1382: #563 added `voucher` to a refund-tender enum, the
# Hypothesis filter_too_much health check then stopped recordCreditSaleReversal early and
# the job reported "could not run"). Gate and report keep every health check.
#
# A fake `docker` on PATH records every call; nothing real is started. It runs ops.py on
# the host against the bind-mount source, like root-path.test.sh.
#
# Usage: bash tools/schemathesis/__tests__/operator-health-check.test.sh
# Needs python3 with PyYAML. Not wired into CI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$HERE/../../.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PY="$(command -v python3 || command -v python)"
FLAG="--suppress-health-check=filter_too_much"
fails=0

mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
contracts="" cfg=""
shift # `docker run`; the second `run` below is the Schemathesis command
while [[ $# -gt 0 ]]; do
  case "$1" in
    -v) case "$2" in
          *:/contracts:*) contracts="${2%:/contracts:*}" ;;
          *:/cfg:*) cfg="${2%:/cfg:*}" ;;
        esac; shift 2 ;;
    /cfg/ops.py) exec "$FAKE_PY" "$cfg/ops.py" "$contracts" "$3" ;;
    -c) echo 200; exit 0 ;; # session and envelope probes
    run) printf 'Test cases:\n    3 generated, 3 passed\n'; exit 0 ;;
    *) shift ;;
  esac
done
exit 0
FAKE
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" FAKE_PY="$PY" FAKE_DOCKER_LOG="$TMP/docker.log" FUZZ_OUT="$TMP/out"
mkdir -p "$FUZZ_OUT"
printf x >"$FUZZ_OUT/cookie-owner"
printf x >"$FUZZ_OUT/cookie-platform"
printf x >"$FUZZ_OUT/envelope-operator"

# check <mode> <want: with|without>: the Schemathesis `run` calls of that mode carry the flag or not.
check() {
  local mode="$1" want="$2" runs with_flag without_flag
  : >"$FAKE_DOCKER_LOG"
  bash "$SRC/tools/schemathesis/run.sh" "$mode" >/dev/null 2>&1 || {
    echo "FAIL  $mode: run.sh exited non-zero"
    fails=$((fails + 1))
    return
  }
  runs="$(grep -E ' run /contracts/' "$FAKE_DOCKER_LOG" || true)"
  [[ -n "$runs" ]] || { echo "FAIL  $mode: no Schemathesis run was recorded"; fails=$((fails + 1)); return; }
  with_flag="$(grep -c -- "$FLAG" <<<"$runs" || true)"
  without_flag="$(grep -vc -- "$FLAG" <<<"$runs" || true)"
  if [[ "$want" == with && "$without_flag" -eq 0 ]] || [[ "$want" == without && "$with_flag" -eq 0 ]]; then
    echo "ok    $mode: $want $FLAG"
  else
    echo "FAIL  $mode: want $want $FLAG ($with_flag run(s) with it, $without_flag without)"
    fails=$((fails + 1))
  fi
}

check operator with
check gate without
check report without

if [[ "$fails" -gt 0 ]]; then
  echo "$fails operator-health-check case(s) failed"
  exit 1
fi
echo "all operator-health-check cases passed"
