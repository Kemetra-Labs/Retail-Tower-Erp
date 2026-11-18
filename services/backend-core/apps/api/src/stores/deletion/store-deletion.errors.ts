/**
 * Store deletion refusals — RT-1439 (`stores.openapi.yaml` 1.3.0-draft).
 *
 * The 409 names the FIRST blocker (the contract's order) as `error.code` and lists every
 * blocker in `error.details.blockers`. Messages are generic: no id, name or count in them.
 */
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";

import {
  STORE_DELETION_BLOCKER_MESSAGES,
  type StoreDeletionBlocker,
} from "./store-deletion.facts";

const PREVIEW_STALE = "preview_stale";
const REAUTH_REQUIRED = "reauth_required";
const STORE_DELETION_OWNER_ONLY = "store_deletion_owner_only";

/** The non-disclosing 404 (a role outside the contract, another tenant's store, an unknown or deleted id). */
export function storeNotFound(): NotFoundException {
  return new NotFoundException("Not Found");
}

/** 409: at least one guard holds. `blockers` must not be empty. */
export function storeDeletionBlocked(blockers: readonly StoreDeletionBlocker[]): ConflictException {
  const first = blockers[0];
  if (first === undefined) throw new Error("storeDeletionBlocked: no blocker");
  return new ConflictException({
    code: first.code,
    message: STORE_DELETION_BLOCKER_MESSAGES[first.code],
    details: { blockers: blockers.map((b) => ({ code: b.code, count: b.count })) },
  });
}

/** 409: the previewed state changed; the client reads the preview again. */
export function previewStale(): ConflictException {
  return new ConflictException({
    code: PREVIEW_STALE,
    message: "The store changed since it was previewed. Read the preview again.",
  });
}

/** 403: the grant is missing, expired, used, or for another session, store or purpose (one answer for every cause). */
export function reauthRequired(): ForbiddenException {
  return new ForbiddenException({
    code: REAUTH_REQUIRED,
    message: "Re-enter your password to continue.",
  });
}

export function storeDeletionOwnerOnly(): ForbiddenException {
  return new ForbiddenException({
    code: STORE_DELETION_OWNER_ONLY,
    message: "Only the tenant owner can delete a store.",
  });
}
