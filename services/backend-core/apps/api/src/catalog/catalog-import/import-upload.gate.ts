/**
 * RT-1505 (spec 049 §8.5, the RT-1284 / RT-1295 rule for a large body): the
 * concurrency bound of the import upload. At most `max` authorized uploads read
 * and parse a body at once (each holds up to 5 MiB, and an XLSX is inflated and
 * parsed on top); one more is refused at once, BEFORE its body is read, with
 * the contract's retryable `429 rate_limited` (declared on every cookieAuth
 * operation) and `Retry-After`: a capacity refusal, not a refusal of the file.
 * Only an authorized caller reaches the gate (the route's guards run first, on
 * headers alone), so an unauthenticated caller can never hold a slot.
 */

/** How many uploads may read and parse a body at once. */
export const IMPORT_UPLOAD_MAX_CONCURRENT = 4;

/** `Retry-After` (seconds) on a refused upload. */
export const IMPORT_UPLOAD_RETRY_AFTER_SECONDS = 5;

/** DI token of the gate, so a test can give it a smaller bound. */
export const IMPORT_UPLOAD_GATE = Symbol.for("api.catalogImport.uploadGate");

export class ImportUploadGate {
  private inFlight = 0;

  constructor(private readonly max: number = IMPORT_UPLOAD_MAX_CONCURRENT) {}

  /** A release function (idempotent) when a slot is free, else `null`. */
  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.max) return null;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }

  /** Slots in use (for tests). */
  active(): number {
    return this.inFlight;
  }
}
