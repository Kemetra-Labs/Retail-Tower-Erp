/**
 * PostingFeedReporter — RT-1325 (RT-1125 R-21).
 *
 * The posting feed's warn-log for rows it cannot offer: a row omitted because
 * its work item did not resolve (`null` build), and a row re-offered or
 * dead-lettered because its projection failed. Kept out of
 * `erpnext-posting.service.ts`, which reads the Connector's rejection
 * message and therefore writes to no log (RT-410 G4,
 * `rejection-message-handling.guard.spec.ts`). Only the work-item ref, its
 * kind, the error class name and the retry count are logged: no sale data.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";

import type { Logger } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "../../common/logging.interceptor";

@Injectable()
export class PostingFeedReporter {
  constructor(@Optional() @Inject(ROOT_LOGGER) private readonly log?: Pick<Logger, "warn">) {}

  /** A `null` build: left out of the page, the row stays pending (historical omission). */
  omitted(workItemRef: string, kind: string): void {
    this.log?.warn(
      { work_item_ref: workItemRef, kind },
      "posting feed: work item omitted (its sale, lines or reversal event did not resolve); the row stays pending",
    );
  }

  /** A projection failure: left out of the page and re-offered under the retry budget. */
  reoffered(workItemRef: string, error: string, retryCount: number): void {
    this.log?.warn(
      { work_item_ref: workItemRef, error, retry_count: retryCount },
      "posting feed: posting row could not be built; left out of this page and re-offered under the retry budget",
    );
  }

  /** A projection failure with the retry budget spent: dead-lettered. */
  deadLettered(workItemRef: string, error: string, retryCount: number): void {
    this.log?.warn(
      { work_item_ref: workItemRef, error, retry_count: retryCount },
      "posting feed: posting row could not be built and its retry budget is spent; dead-lettered as retry_budget_exhausted",
    );
  }
}
