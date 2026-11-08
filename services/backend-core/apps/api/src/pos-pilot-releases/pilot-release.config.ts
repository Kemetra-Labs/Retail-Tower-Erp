/**
 * RT-1292: configuration of the POS pilot release lane. Pure: it reads an
 * environment object and answers either an enabled configuration or the reason
 * the lane is disabled. A disabled lane makes the resolver answer
 * `available:false` (fail closed), never an error.
 *
 * | Variable                               | Meaning |
 * |----------------------------------------|---------|
 * | `POS_PILOT_RELEASE_PUBLISHER`          | The pilot Authenticode publisher pin. Unset or blank disables the lane. |
 * | `POS_PILOT_RELEASE_BUCKET`             | The private bucket that holds pilot releases. Unset or blank disables the lane. |
 * | `POS_PILOT_RELEASE_URL_TTL_SECONDS`    | Presigned URL lifetime, integer 1 … 900, default 300. Anything else disables the lane: it is never clamped. |
 * | `POS_RELEASE_PRODUCTION_PUBLISHER`     | The production pin (RT-1260), read only to refuse a pilot pin that equals it. |
 *
 * The pilot pin must differ from the production pin and carry neither lab
 * marker, so a lab or production certificate subject can never satisfy the
 * pilot lane.
 */

export const DEFAULT_URL_TTL_SECONDS = 300;
export const MAX_URL_TTL_SECONDS = 900;

/** Subject markers of the lab certificate (`apps/pos/scripts/lab/lab-sign-lib.cjs`). */
const LAB_MARKERS: readonly string[] = ["LAB TEST", "NOT FOR PRODUCTION"];

type PilotReleaseConfigRefusal = "pin_unset" | "pin_invalid" | "bucket_unset" | "ttl_invalid";

export type PilotReleaseConfig =
  | {
      readonly enabled: true;
      readonly publisher: string;
      readonly bucket: string;
      readonly urlTtlSeconds: number;
    }
  | { readonly enabled: false; readonly reason: PilotReleaseConfigRefusal };

type Env = Readonly<Record<string, string | undefined>>;

const INTEGER = /^[0-9]+$/;

function carriesLabMarker(pin: string): boolean {
  const upper = pin.toUpperCase();
  return LAB_MARKERS.some((marker) => upper.includes(marker));
}

function sameSubject(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parseTtl(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_URL_TTL_SECONDS;
  const text = raw.trim();
  if (!INTEGER.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= MAX_URL_TTL_SECONDS ? value : null;
}

export function resolvePilotReleaseConfig(env: Env): PilotReleaseConfig {
  const pin = (env["POS_PILOT_RELEASE_PUBLISHER"] ?? "").trim();
  if (pin === "") return { enabled: false, reason: "pin_unset" };
  const production = (env["POS_RELEASE_PRODUCTION_PUBLISHER"] ?? "").trim();
  if (carriesLabMarker(pin) || (production !== "" && sameSubject(pin, production))) {
    return { enabled: false, reason: "pin_invalid" };
  }
  const bucket = (env["POS_PILOT_RELEASE_BUCKET"] ?? "").trim();
  if (bucket === "") return { enabled: false, reason: "bucket_unset" };
  const ttl = parseTtl(env["POS_PILOT_RELEASE_URL_TTL_SECONDS"]);
  if (ttl === null) return { enabled: false, reason: "ttl_invalid" };
  return { enabled: true, publisher: pin, bucket, urlTtlSeconds: ttl };
}
