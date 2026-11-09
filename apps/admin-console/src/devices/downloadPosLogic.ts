/**
 * RT-1304 pure mapper for the Download POS page. No React, no fetch.
 *
 * Each contract outcome maps to exactly one state of the spec's matrix (S2..S9). The
 * Console can only prove that a link was ISSUED (the 200): it cannot see the download
 * start or finish, so nothing here is ever styled as "downloaded".
 *
 * `downloadUrl` is a bearer capability. `mapOutcome` returns it beside the display state,
 * never inside it, so a caller can hand it to the browser and keep only the state.
 * `expiresAt` is dropped: the page never shows a countdown (server clock vs client clock).
 */
import type { LatestPilotReleaseResult } from "@/lib/pilot-release-queries";
import { requestIdOf } from "./deviceLogic";

export type LatestResult = LatestPilotReleaseResult;

/** What the ledger shows after a link was issued. */
export interface ReleaseFacts {
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  expectedPublisher: string;
}

export type DownloadState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "issued"; facts: ReleaseFacts }
  | { kind: "unavailable" }
  | { kind: "session"; requestId?: string }
  | { kind: "not-found" }
  | { kind: "support-session"; requestId?: string }
  | { kind: "rate-limited"; seconds: number }
  | { kind: "failure"; requestId?: string }
  /** A 200 the page cannot trust, or a hand-off that failed: a link MAY have been issued. */
  | { kind: "not-started" }
  | { kind: "network" };

export interface Outcome {
  state: DownloadState;
  /** Present only for `issued`; goes straight to the hand-off, never into state. */
  url?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const RATE_LIMIT_FALLBACK_SECONDS = 30;

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A 200 is trusted only when it is exactly one of the two contract shapes. */
function fromOk(data: unknown): Outcome {
  const body = (data ?? null) as Record<string, unknown> | null;
  if (body?.available === false) return { state: { kind: "unavailable" } };
  if (
    body?.available === true &&
    str(body.version) &&
    str(body.fileName) &&
    str(body.expectedPublisher) &&
    typeof body.sizeBytes === "number" &&
    typeof body.sha256 === "string" &&
    SHA256.test(body.sha256) &&
    typeof body.downloadUrl === "string" &&
    body.downloadUrl.startsWith("https://")
  ) {
    return {
      state: {
        kind: "issued",
        facts: {
          version: body.version,
          fileName: body.fileName,
          sizeBytes: body.sizeBytes,
          sha256: body.sha256,
          expectedPublisher: body.expectedPublisher,
        },
      },
      url: body.downloadUrl,
    };
  }
  return { state: { kind: "not-started" } };
}

export function mapOutcome(res: LatestResult): Outcome {
  const requestId = requestIdOf(res.error);
  switch (res.status) {
    case 200:
      return fromOk(res.data);
    case 401:
      return { state: { kind: "session", requestId } };
    case 403:
      return { state: { kind: "support-session", requestId } };
    case 404:
      return { state: { kind: "not-found" } };
    case 429:
      return {
        state: { kind: "rate-limited", seconds: res.retryAfter ?? RATE_LIMIT_FALLBACK_SECONDS },
      };
    default:
      return { state: { kind: "failure", requestId } };
  }
}

/** S9: the request never got an answer. */
export function mapNetworkFailure(): Outcome {
  return { state: { kind: "network" } };
}

/** SHA-256 for display: groups of eight, space separated (copy writes the raw hex). */
export function groupSha(hex: string): string {
  return hex.match(/.{1,8}/g)?.join(" ") ?? hex;
}

/** Decimal megabytes with one decimal and Western digits (`176.9 MB`). */
export function formatSizeMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
