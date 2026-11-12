/**
 * RT-1348 (RT-1345 S3, D3) — the Backend-Core origin a pairing is bound to.
 *
 * The terminal records the normalized origin of the API address it paired
 * against (`terminal_assignment.api_origin`). Started against another origin it
 * reports `invalid / other_server` and never sends the device token there.
 *
 * Only the ORIGIN is compared (`scheme://host[:port]`, lower case, default port
 * dropped). A path prefix is the same server, and a trailing slash or letter
 * case must not look like another server. An origin is not a secret.
 */

/**
 * The origin of `baseUrl`, or null when it is not an http(s) URL (then the
 * terminal has no origin it can compare, which never reads as a match).
 */
export function normalizeApiOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * True when a stored origin exists and is not the current one. Nothing stored
 * (a legacy pairing, or no pairing) is never "another server"; a stored origin
 * against an unusable current origin cannot match, so it is.
 */
export function isOtherServer(stored: string | null | undefined, current: string | null): boolean {
  return typeof stored === 'string' && stored !== current;
}
