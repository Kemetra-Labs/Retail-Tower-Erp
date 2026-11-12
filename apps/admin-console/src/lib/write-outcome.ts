/**
 * RT-1338: the small helpers every Console write classifier needs, shared by the brands and
 * offers screens. Pure; no client, no React. The server's words never show: callers pick a catalog
 * key from the status and the machine `error.code`, and show the request id as a support handle.
 */

interface ErrorEnvelope {
  error?: { code?: string; request_id?: string } | string;
}

/** What every generated-client wrapper returns on a write: the HTTP status and the error body. */
export interface WrapperResult {
  status: number;
  error?: unknown;
}

function inner(error: unknown): { code?: string; request_id?: string } | undefined {
  const body = (error as ErrorEnvelope | undefined)?.error;
  return typeof body === "object" ? body : undefined;
}

/** `error.code` of the envelope, when there is one. */
export function errorCodeOf(error: unknown): string | undefined {
  return inner(error)?.code;
}

/** `error.request_id` of the envelope, when there is one. */
export function errorRequestIdOf(error: unknown): string | undefined {
  return inner(error)?.request_id;
}

/** A fresh Idempotency-Key (a v4 UUID, inside the contract's 16 to 128 printable ASCII). */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * One Idempotency-Key per intended action (the voucher-cancel pattern). A retry after a lost
 * answer, a 425, a 429 or a 5xx reuses the key and replays the stored answer; a terminal answer,
 * or a different body for the same slot, takes a new key (a same-key different-body call is 409
 * `idempotency_key_conflict`).
 */
export class KeyedAttempt {
  private current: { fingerprint: string; key: string } | undefined;

  /** The key for this body: the held one while the body is unchanged, else a fresh one. */
  keyFor(fingerprint: string): string {
    if (this.current?.fingerprint !== fingerprint) {
      this.current = { fingerprint, key: newIdempotencyKey() };
    }
    return this.current.key;
  }

  /** The action reached a terminal answer: the next one is a new action. */
  settle(): void {
    this.current = undefined;
  }
}
