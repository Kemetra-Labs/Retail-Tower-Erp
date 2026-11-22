/**
 * RT-1498 close slice — is the server's return status read available? (the RT-1548 rollout gates)
 *
 * The status read answers 404 while `POS_RETURNS_ENABLED` or its own default-off rollout gate
 * `POS_RETURN_STATUS_READ_ENABLED` is off (and for a sale out of scope). A close needs the read, so the
 * close is offered only while the LAST probe was answered with a verdict. Fail closed: before any probe
 * (a fresh process) and after a 404 the answer is "not available". A fault that says nothing about the
 * route (a 5xx, a timeout, a 401/403, an unreadable body) leaves the last answer as it was.
 *
 * The state is in memory and per process: the close itself re-reads the status fresh and refuses on
 * anything but an affirmative `not_recorded`, so a stale "available" can never close a return; it can
 * only offer an approval that the close then refuses.
 */
import type { StatusReadOutcome } from './returns-status-client.js';

export interface StatusReadAvailability {
  /** True only when the last status read was answered with a verdict. */
  isAvailable(): boolean;
  /** Record what a status read answered. */
  note(outcome: StatusReadOutcome): void;
}

export function createStatusReadAvailability(): StatusReadAvailability {
  let available = false;
  return {
    isAvailable: () => available,
    note(outcome) {
      if (outcome.kind === 'recorded' || outcome.kind === 'not_recorded') available = true;
      else if (outcome.kind === 'unavailable') available = false;
    },
  };
}
