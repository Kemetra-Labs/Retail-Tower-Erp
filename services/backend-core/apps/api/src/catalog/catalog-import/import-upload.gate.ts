/**
 * RT-1505 (spec 049 §8.5, the RT-1284 / RT-1295 rule for a large body): the
 * capacity bound of the import upload. An authorized upload holds a slot from
 * before its body is read until its parse and write are DONE (not only until
 * the response ends: a client that aborts mid-parse must not free the slot
 * while the server still works, security review of PR #761, M4). One more
 * upload is refused at once, BEFORE its body is read, with the contract's
 * retryable `429 rate_limited` (declared on every cookieAuth operation) and
 * `Retry-After`: a capacity refusal, not a refusal of the file.
 *
 * Two bounds: at most `max` uploads in the process (each holds up to 5 MiB and,
 * for an XLSX, is inflated and parsed on the main thread), and at most ONE per
 * tenant (a tenant has one open batch, so a second concurrent upload could only
 * lose; this also stops one tenant from taking every slot). A body that is not
 * received within `bodyDeadlineMs` is dropped, so a slow sender cannot hold a
 * slot for the server's request timeout. Only an authorized caller reaches the
 * gate (the route's guards run first, on headers alone), so an unauthenticated
 * caller can never hold a slot.
 */

/** How many uploads may read and parse a body at once, process-wide. */
export const IMPORT_UPLOAD_MAX_CONCURRENT = 4;

/** `Retry-After` (seconds) on a refused upload. */
export const IMPORT_UPLOAD_RETRY_AFTER_SECONDS = 5;

/** The time a body may take to arrive, in milliseconds. */
const IMPORT_UPLOAD_BODY_DEADLINE_MS = 30_000;

/** DI token of the gate, so a test can give it smaller bounds. */
export const IMPORT_UPLOAD_GATE = Symbol.for("api.catalogImport.uploadGate");

/**
 * One held slot. It is released when the response has ended AND the handler's
 * work, if it started, is done. The handler calls `begin()` before its work and
 * `end()` in a `finally`; `begin()` is false when the slot is already released
 * (the client went away before the handler ran), and the handler then does no
 * work.
 */
export class ImportUploadSlot {
  private pending = 1;
  private released = false;
  private responseDone = false;

  constructor(private readonly onRelease: () => void) {}

  /** The handler is about to work. False when the slot is already released: do nothing. */
  begin(): boolean {
    if (this.released) return false;
    this.pending += 1;
    return true;
  }

  /** The handler's work is over (success or failure). */
  end(): void {
    this.drop();
  }

  /** The response finished or the connection closed (idempotent: both events call it). */
  responseEnded(): void {
    if (this.responseDone) return;
    this.responseDone = true;
    this.drop();
  }

  private drop(): void {
    this.pending -= 1;
    if (this.pending === 0 && !this.released) {
      this.released = true;
      this.onRelease();
    }
  }
}

export class ImportUploadGate {
  private inFlight = 0;
  private readonly tenants = new Set<string>();

  constructor(
    private readonly max: number = IMPORT_UPLOAD_MAX_CONCURRENT,
    readonly bodyDeadlineMs: number = IMPORT_UPLOAD_BODY_DEADLINE_MS,
  ) {}

  /** A slot when one is free, for the process and for the tenant; else `null`. */
  tryAcquire(tenantId: string): ImportUploadSlot | null {
    if (this.inFlight >= this.max || this.tenants.has(tenantId)) return null;
    this.inFlight += 1;
    this.tenants.add(tenantId);
    return new ImportUploadSlot(() => {
      this.inFlight -= 1;
      this.tenants.delete(tenantId);
    });
  }

  /** Slots in use (for tests). */
  active(): number {
    return this.inFlight;
  }
}
