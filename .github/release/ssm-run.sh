#!/usr/bin/env bash
# Runs ONE owner-created SSM document on the single Online lab node of a host (RT-1031), the same
# send, poll and strict-output logic deploy-lab.yml, deploy-console-lab.yml and deploy-erp-lab.yml
# each carry inline. deploy-system-lab.yml calls it once per document, so the four runs behave alike.
#
# Inputs (environment, set by the workflow step; none is a secret):
#   LABEL        backup | backend | console | erp (names the files below)
#   HOST         lab-01 | lab-02 | lab-03 (the node is found by its owner-set tags Environment=lab, Host=<HOST>)
#   DOCUMENT     the SSM document name (RT-...)
#   PARAMS       a file holding the document's parameters as JSON
#   LIMIT        seconds to poll, INTERVAL seconds between polls
#   RESULT_RE    the extended regex a stdout line must match to be kept: the raw output never reaches the log
#   DONE_LINE    the exact line that proves the document completed, or
#   DONE_RE      the extended regex such a line matches (exactly one of the two is set)
#   LIVE        the directory for the result files; RUN_ID, JIRA_KEY for the command comment
#
# Writes $LIVE/$LABEL.status (the SSM status), $LIVE/$LABEL.lines (the kept lines) and, only when the
# document ended Success and printed its completion line, $LIVE/$LABEL.ok. On any failure it records the reason
# in $LIVE/failure.txt and exits 1, so the step stops the job (D3: stop at the first failure).
set -euo pipefail

: "${LABEL:?}" "${HOST:?}" "${DOCUMENT:?}" "${PARAMS:?}" "${LIMIT:?}" "${INTERVAL:?}" "${RESULT_RE:?}" "${LIVE:?}" "${RUN_ID:?}" "${JIRA_KEY:?}"
DONE_LINE="${DONE_LINE:-}"
DONE_RE="${DONE_RE:-}"
mkdir -p "$LIVE"
fail() { echo "::error::$LABEL: $*"; echo "$LABEL: $*" > "$LIVE/failure.txt"; exit 1; }

[ -n "$DONE_LINE" ] || [ -n "$DONE_RE" ] || fail "no completion line or pattern given"
[ -z "$DONE_LINE" ] || [ -z "$DONE_RE" ] || fail "give DONE_LINE or DONE_RE, not both"

[[ "$LABEL" =~ ^(backup|backend|console|erp)$ ]] || fail "unknown label"
[[ "$HOST" =~ ^lab-0[123]$ ]] || fail "unknown host"
[[ "$DOCUMENT" =~ ^RT-[A-Za-z]+$ ]] || fail "unknown document"
[[ "$LIMIT" =~ ^[0-9]+$ && "$INTERVAL" =~ ^[0-9]+$ ]] || fail "LIMIT and INTERVAL must be whole seconds"
[ -f "$PARAMS" ] || fail "no parameters file"

# One Online managed node. DescribeInstanceInformation refuses a tag filter mixed with any other
# filter key, so the Online check is a client-side query.
NODE="$(aws ssm describe-instance-information \
  --filters "Key=tag:Environment,Values=lab" "Key=tag:Host,Values=$HOST" \
  --query "InstanceInformationList[?PingStatus=='Online'].InstanceId" --output text)" || fail "describe-instance-information failed"
[[ "$NODE" =~ ^mi-[0-9a-f]{17}$ ]] || fail "no single Online SSM node tagged Environment=lab, Host=$HOST"

CMD="$(aws ssm send-command --instance-ids "$NODE" --document-name "$DOCUMENT" --document-version '$DEFAULT' \
  --parameters "file://$PARAMS" --timeout-seconds 600 --comment "deploy-system-lab $LABEL run $RUN_ID $JIRA_KEY" \
  --query Command.CommandId --output text)" || fail "send-command was refused"
[[ "$CMD" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "no command ID"
echo "$LABEL: command $CMD on $NODE"

STATUS=Pending
DEADLINE=$(( $(date +%s) + LIMIT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep "$INTERVAL"
  STATUS="$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$NODE" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in Success | Failed | Cancelled | TimedOut | Undeliverable | Terminated) break ;; *) ;; esac
done
echo "$STATUS" > "$LIVE/$LABEL.status"
# The raw output never reaches the log: only lines matching the strict pattern are kept.
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$NODE" \
  --query StandardOutputContent --output text 2>/dev/null \
  | grep -E "$RESULT_RE" > "$LIVE/$LABEL.lines" || true
cat "$LIVE/$LABEL.lines"
[ "$STATUS" = Success ] || fail "the document ended $STATUS"
if [ -n "$DONE_LINE" ]; then
  grep -qxF "$DONE_LINE" "$LIVE/$LABEL.lines" || fail "the document did not report completion ($DONE_LINE)"
else
  grep -qE "$DONE_RE" "$LIVE/$LABEL.lines" || fail "the document did not report completion"
fi
: > "$LIVE/$LABEL.ok"
