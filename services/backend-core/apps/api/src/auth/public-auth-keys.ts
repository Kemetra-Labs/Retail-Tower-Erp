/**
 * RT-625 (precondition P2) — rate-limit identifiers for the public-auth
 * buckets keyed by client IP and by (email, client IP).
 *
 * Every caller that builds or clears one of these keys goes through this
 * module: the sign-in buckets, the password-reset request buckets and the
 * reset-confirm clear (D2). A key built inline anywhere else would differ
 * and silently miss its counter. RT-1043 swaps the encoding for an HMAC at
 * this one point.
 *
 *   - IPv4 is keyed by the full address.
 *   - IPv6 is keyed by its /64 prefix: one host normally holds a whole /64,
 *     so a per-address key would let it pose as unlimited clients.
 *   - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the IPv4 address, so one client
 *     never gets two keys.
 *   - A value that is not an IP (`"unknown"` from a request with no socket
 *     address) is passed through unchanged.
 *   - The pair identifier is length-prefixed: IPv6 contains `:`, so a raw
 *     `email:ip` concatenation could map two different pairs to one key.
 */
import { isIP } from "node:net";

/**
 * The account dimension: the email exactly as the shared `Email` schema
 * normalizes it (trimmed, lowercased). A body email is already in this form;
 * an email read from the database is put into it here.
 */
export function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

/** The client-IP dimension (see the module header). */
export function clientIpKey(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return ip;
  const hextets = expandIpv6(address);
  if (isIpv4Mapped(hextets)) return ipv4FromHextets(hextets[6]!, hextets[7]!);
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
}

/**
 * The (email, client IP) dimension: `<length of the email>:<email>|<ip key>`.
 * The length prefix fixes where the email ends, so no two pairs share a key.
 */
export function emailIpPairKey(email: string, ip: string): string {
  const account = accountKey(email);
  return `${account.length}:${account}|${clientIpKey(ip)}`;
}

/** The eight 16-bit groups of a valid IPv6 address (no zone id). */
function expandIpv6(address: string): number[] {
  let text = address;
  // An embedded dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is the
  // last two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = rest === undefined ? headGroups : [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  return groups.map((g) => parseInt(g, 16));
}

function isIpv4Mapped(hextets: readonly number[]): boolean {
  return hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
}

function ipv4FromHextets(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
