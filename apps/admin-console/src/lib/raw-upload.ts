/**
 * The raw-body upload every Console file route shares (RT-474 logo, RT-1509 product import).
 *
 * The contracts take the raw file bytes under any Content-Type and say Admin-Console sends
 * `application/octet-stream`. openapi-fetch would JSON-encode a body by default, so a file upload
 * passes the Blob through unchanged and sets the content type. Extracted from
 * `tenant-branding-queries.ts` (not copied) so the two uploads cannot drift.
 */

/** Spread into an openapi-fetch call: the File itself, never a serialized copy. */
export const RAW_UPLOAD = {
  bodySerializer: (file: unknown) => file as Blob,
  headers: { "Content-Type": "application/octet-stream" },
};

/** What every wrapper returns: the status, the body or error, the 429 / 425 `Retry-After` and the replay flag. */
export function rawResult<T>(r: { data?: T; error?: unknown; response: Response }) {
  return {
    status: r.response.status,
    data: r.data,
    error: r.error,
    retryAfter: r.response.headers.get("retry-after"),
    /** `Idempotent-Replayed: true`: the server answered from a stored result (RT-1509). */
    replayed: r.response.headers.get("idempotent-replayed") === "true",
  };
}
