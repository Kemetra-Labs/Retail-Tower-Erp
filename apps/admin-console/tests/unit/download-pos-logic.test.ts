import { describe, expect, test } from "vitest";
import {
  type LatestResult,
  formatSizeMb,
  groupSha,
  mapNetworkFailure,
  mapOutcome,
} from "../../src/devices/downloadPosLogic";

const URL_SENTINEL = "https://bucket.s3.eu-central-1.amazonaws.com/POS.exe?X-Amz-Signature=SECRET";
const SHA = "ab12cd34".repeat(8);

const available = {
  available: true,
  version: "0.3.7",
  sha256: SHA,
  sizeBytes: 185_500_000,
  fileName: "POS-Pulse-Setup-0.3.7.exe",
  expectedPublisher: "CN=Kemetra POS PILOT",
  downloadUrl: URL_SENTINEL,
  expiresAt: "2026-11-09T20:00:00Z",
};

const res = (status: number, data?: unknown, error?: unknown, retryAfter?: number): LatestResult =>
  ({ status, data, error, retryAfter }) as LatestResult;
const err = (code: string, requestId = "req-1") => ({
  error: { code, message: "x", request_id: requestId },
});

describe("mapOutcome (RT-1304 spec 6)", () => {
  test("S2: available:true keeps display facts and hands the URL out separately", () => {
    const { state, url } = mapOutcome(res(200, available));
    expect(url).toBe(URL_SENTINEL);
    expect(state).toEqual({
      kind: "issued",
      facts: {
        version: "0.3.7",
        fileName: "POS-Pulse-Setup-0.3.7.exe",
        sizeBytes: 185_500_000,
        sha256: SHA,
        expectedPublisher: "CN=Kemetra POS PILOT",
      },
    });
    expect(JSON.stringify(state)).not.toContain("SECRET");
    expect(JSON.stringify(state)).not.toContain("expiresAt");
  });

  test("S3: available:false is one state with no reason", () => {
    expect(mapOutcome(res(200, { available: false }))).toEqual({ state: { kind: "unavailable" } });
    expect(mapOutcome(res(200, { available: false, reason: "not_allowlisted" })).state).toEqual({
      kind: "unavailable",
    });
  });

  test("a 200 that is neither shape never reads as success or as unavailable (S8)", () => {
    for (const bad of [
      { available: true, version: "1" },
      { ...available, sha256: "short" },
      { ...available, downloadUrl: "" },
      { ...available, downloadUrl: "http://insecure.example/x" },
      {},
      null,
      "nope",
    ]) {
      expect(mapOutcome(res(200, bad)).state.kind).toBe("failure");
    }
  });

  test("S4 session, S5 not-found, S6 support session (both codes)", () => {
    expect(mapOutcome(res(401, undefined, err("unauthorized"))).state).toEqual({
      kind: "session",
      requestId: "req-1",
    });
    expect(mapOutcome(res(404, undefined, err("not_found"))).state.kind).toBe("not-found");
    for (const code of ["support_session_required", "support_session_expired"]) {
      expect(mapOutcome(res(403, undefined, err(code))).state).toEqual({
        kind: "support-session",
        requestId: "req-1",
      });
    }
  });

  test("S7: 429 carries the clamped wait; S8: 400 and 500; never S3 copy", () => {
    expect(mapOutcome(res(429, undefined, err("rate_limited"), 30)).state).toEqual({
      kind: "rate-limited",
      seconds: 30,
    });
    expect(mapOutcome(res(429)).state).toEqual({ kind: "rate-limited", seconds: 30 });
    for (const status of [400, 500, 502]) {
      expect(mapOutcome(res(status, undefined, err("system_failure"))).state).toEqual({
        kind: "failure",
        requestId: "req-1",
      });
    }
  });

  test("S9: a request that got no answer", () => {
    expect(mapNetworkFailure()).toEqual({ state: { kind: "network" } });
  });
});

describe("display helpers", () => {
  test("groupSha splits 64 hex into 8 groups of 8", () => {
    const grouped = groupSha(SHA).split(" ");
    expect(grouped).toHaveLength(8);
    expect(grouped.every((g) => g.length === 8)).toBe(true);
    expect(grouped.join("")).toBe(SHA);
  });
  test("formatSizeMb is decimal MB with one decimal and Western digits", () => {
    expect(formatSizeMb(185_500_000)).toBe("185.5 MB");
    expect(formatSizeMb(176_900_000)).toBe("176.9 MB");
    expect(formatSizeMb(0)).toBe("0.0 MB");
  });
});
