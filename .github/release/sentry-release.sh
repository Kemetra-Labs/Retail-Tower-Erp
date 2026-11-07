#!/usr/bin/env bash
# RT-1241: Sentry release + deploy evidence for a lab deploy. Sentry is evidence only (RT-617): every
# problem here is ONE visible warning and exit 0, so this script can never fail or block a deploy.
#
# Usage: sentry-release.sh <backend-core|admin-console|erpnext-connector> <release> <release-sha> <ledger.json>
#   release      the exact name the runtime SDK reports: vX.Y.Z (backend-core), SHA12 (the other two)
#   release-sha  the 40-hex commit the release was built from
#   ledger.json  the live ledger; nothing is sent unless its .outcome is "deployed"
#
# Steps, all with the pinned sentry-cli below:
#   releases new -> releases set-commits -> releases finalize -> deploys new -e staging
#
# Environment (set by the workflow step):
#   SENTRY_AUTH_TOKEN  from the GitHub environment secret; never printed. Unset: skip with one warning.
#   SENTRY_CLI_BIN     test hook: use this binary instead of downloading the pinned one.
#   GITHUB_REPOSITORY  owner/name of the repository the commits are read from.
#
# Commits: `set-commits --auto` when the checkout is at the release commit (it reads HEAD); otherwise the
# explicit `--commit <repo>@<sha>`, which Sentry resolves through the same GitHub integration (sentry-cli
# documents that without a start commit the range is taken from the previous release; the first live run
# shows the real commit count). If both fail the release stays without commits and the
# warning says so; there is no silent no-op.
set -uo pipefail

SENTRY_CLI_VERSION="3.8.2"
CLI_BINARY_SHA256="c958865f9d4000183509ea21b1f04925d5390de6d8d87386b9e69f2b305070c3" # sentry-cli-Linux-x86_64
export SENTRY_URL="https://de.sentry.io"
export SENTRY_ORG="kemetra"

warn() { echo "::warning::Sentry release (RT-1241): $*"; }

main() {
  local product="${1:-}" release="${2:-}" sha="${3:-}" ledger="${4:-}"
  case "$product" in backend-core | admin-console | erpnext-connector) ;; *) warn "unknown product '$product'; skipped"; return 0 ;; esac
  [[ "$release" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+|[0-9a-f]{12})$ ]] || { warn "release '$release' is neither vX.Y.Z nor SHA12; skipped"; return 0; }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { warn "release commit '$sha' is not a full SHA; skipped"; return 0; }
  # The ledger is the proof of a finished deploy; a failed or held run records nothing in Sentry.
  if [ -z "$ledger" ] || [ "$(jq -r '.outcome // ""' "$ledger" 2>/dev/null)" != "deployed" ]; then
    echo "Sentry release: the deploy outcome is not 'deployed'; nothing recorded."
    return 0
  fi
  if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
    warn "SENTRY_AUTH_TOKEN is not set on this environment; no release or deploy was recorded for $release."
    return 0
  fi
  export SENTRY_PROJECT="$product"

  local cli
  cli="$(install_cli)" || { warn "could not install the pinned sentry-cli $SENTRY_CLI_VERSION; nothing recorded for $release."; return 0; }

  local repo="${GITHUB_REPOSITORY:-Kemetra-Labs/Retail-Tower-Erp}"
  run_cli "$cli" releases new "$release" || { warn "releases new $release failed (token scopes or project?); nothing more recorded."; return 0; }

  local head=""
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ "$head" = "$sha" ] && run_cli "$cli" releases set-commits "$release" --auto; then
    :
  elif run_cli "$cli" releases set-commits "$release" --commit "$repo@$sha"; then
    :
  else
    warn "set-commits failed for $release (GitHub integration or token scope?); the release has NO commits."
  fi

  run_cli "$cli" releases finalize "$release" || warn "releases finalize $release failed."
  if run_cli "$cli" deploys new --release "$release" -e staging; then
    echo "Sentry release: $release recorded with a staging deploy (project $product)."
  else
    warn "deploys new for $release failed; no deploy was recorded."
  fi
  return 0
}

# Runs sentry-cli with its output kept: the token is only in the environment, never in an argument.
run_cli() {
  local cli="$1"; shift
  timeout 40 "$cli" "$@" 2>&1 | sed 's/^/  sentry-cli: /'
  return "${PIPESTATUS[0]}"
}

# Prints the binary path: the test hook, or the pinned release asset checked against its SHA-256.
install_cli() {
  if [ -n "${SENTRY_CLI_BIN:-}" ]; then echo "$SENTRY_CLI_BIN"; return 0; fi
  local dir="${RUNNER_TEMP:-/tmp}/sentry-cli-$SENTRY_CLI_VERSION" url
  url="https://github.com/getsentry/sentry-cli/releases/download/$SENTRY_CLI_VERSION/sentry-cli-Linux-x86_64"
  mkdir -p "$dir" || return 1
  curl -fsSL --retry 2 --max-time 30 -o "$dir/sentry-cli" "$url" || return 1
  echo "$CLI_BINARY_SHA256  $dir/sentry-cli" | sha256sum -c - >&2 || { rm -f "$dir/sentry-cli"; return 1; }
  chmod +x "$dir/sentry-cli" && echo "$dir/sentry-cli"
}

main "$@"
exit 0
