import { describe, expect, test } from "vitest";

/**
 * RT-1329: the pure rules behind the Platform Console "POS pilot" page. The
 * release state, which rows offer Activate, the allowlist name join and the Add
 * picker, and the outcome of each write (statuses and codes of
 * `pos-pilot-releases.openapi.yaml`).
 */
import {
  activateOutcome,
  addOutcome,
  addableTenants,
  allowlistRows,
  canActivate,
  evidenceHref,
  releaseState,
  removeOutcome,
  shortSha,
} from "@/platform/pilot/pilotLogic";

const release = (over: Record<string, unknown> = {}) => ({
  releaseId: "0190f000-0000-7000-8000-00000000a001",
  version: "0.1.3",
  sha256: "ab".repeat(32),
  sizeBytes: 104_857_600,
  publisher: "CN=Kemetra Pilot",
  signingClass: "pilot" as const,
  attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/42",
  sourceSha: "c".repeat(40),
  approved: true,
  approvedBy: "kemetra-owner",
  approvedAt: "2026-11-10T10:00:00Z",
  promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/123",
  artifactVersionId: "v1",
  registeredAt: "2026-11-10T10:05:00Z",
  withdrawnAt: null,
  withdrawnBy: null,
  activatedAt: null,
  activatedByUserId: null,
  ...over,
});

describe("releaseState", () => {
  test("registered: not activated and not withdrawn", () => {
    expect(releaseState(release())).toBe("registered");
  });
  test("current: activated and not withdrawn", () => {
    expect(releaseState(release({ activatedAt: "2026-11-11T09:00:00Z" }))).toBe("current");
  });
  test("withdrawn wins over activated", () => {
    expect(
      releaseState(
        release({ activatedAt: "2026-11-11T09:00:00Z", withdrawnAt: "2026-11-11T10:00:00Z" }),
      ),
    ).toBe("withdrawn");
  });
});

describe("canActivate", () => {
  test("an approved, registered release can be activated", () => {
    expect(canActivate(release())).toBe(true);
  });
  test("not when it is not approved", () => {
    expect(canActivate(release({ approved: false }))).toBe(false);
  });
  test("not when it is withdrawn", () => {
    expect(canActivate(release({ withdrawnAt: "2026-11-11T10:00:00Z" }))).toBe(false);
  });
  test("not when it is already current", () => {
    expect(canActivate(release({ activatedAt: "2026-11-11T09:00:00Z" }))).toBe(false);
  });
});

describe("shortSha and evidenceHref", () => {
  test("shortSha keeps the first 12 characters", () => {
    expect(shortSha("0123456789abcdef".repeat(4))).toBe("0123456789ab");
  });
  test("only an https GitHub URL becomes a link", () => {
    expect(evidenceHref("https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/1")).toBe(
      "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/1",
    );
    expect(evidenceHref("javascript:alert(1)")).toBeUndefined();
    expect(evidenceHref("https://github.com/someone-else/repo/actions/runs/1")).toBeUndefined();
    expect(evidenceHref("http://github.com/x")).toBeUndefined();
    expect(evidenceHref("https://evil.example/github.com/")).toBeUndefined();
    expect(evidenceHref("not a url")).toBeUndefined();
  });
});

const T1 = "0190f000-0000-7000-8000-0000000000d1";
const T2 = "0190f000-0000-7000-8000-0000000000d2";
const T3 = "0190f000-0000-7000-8000-0000000000d3";
const directory = [
  { id: T1, slug: "delta", name: "Delta Markets" },
  { id: T2, slug: "nile", name: "Nile Pharma" },
  { id: T3, slug: "rayan", name: "Rayan Trading" },
];
const pilot = (tenantId: string, addedAt = "2026-11-11T08:00:00Z") => ({
  tenantId,
  addedAt,
  addedByUserId: "0190f000-0000-7000-8000-0000000000aa",
});

describe("allowlistRows", () => {
  test("joins names from the platform tenant list", () => {
    expect(allowlistRows([pilot(T2)], directory)).toEqual([
      { tenantId: T2, name: "Nile Pharma", slug: "nile", addedAt: "2026-11-11T08:00:00Z" },
    ]);
  });
  test("a tenant missing from the list keeps its id and no name", () => {
    expect(allowlistRows([pilot(T1)], [])).toEqual([
      { tenantId: T1, name: undefined, slug: undefined, addedAt: "2026-11-11T08:00:00Z" },
    ]);
  });
});

describe("addableTenants", () => {
  test("lists directory tenants not on the allowlist, sorted by name", () => {
    const unsorted = [directory[2], directory[0], directory[1]];
    expect(addableTenants(unsorted, [pilot(T1)]).map((t) => t.id)).toEqual([T2, T3]);
    expect(addableTenants(unsorted, []).map((t) => t.id)).toEqual([T1, T2, T3]);
  });
  test("an empty directory leaves nothing to add", () => {
    expect(addableTenants([], [])).toEqual([]);
  });
});

const res = (status: number, code?: string) => ({
  status,
  error: code ? { error: { code, message: "x", request_id: "req-1" } } : undefined,
});

describe("activateOutcome", () => {
  test.each([
    [res(200), "activated"],
    [res(409, "release_current_exists"), "currentExists"],
    [res(409, "release_withdrawn"), "withdrawn"],
    [res(409, "something_else"), "failed"],
    [res(404, "not_found"), "notFound"],
    [res(403, "forbidden"), "notPermitted"],
    [res(403, "origin_rejected"), "notPermitted"],
    [res(429, "rate_limited"), "rateLimited"],
    [res(500, "system_failure"), "failed"],
  ] as const)("%o is %s", (r, kind) => {
    expect(activateOutcome(r).kind).toBe(kind);
  });
  test("a failure carries its request id", () => {
    expect(activateOutcome(res(500, "system_failure")).requestId).toBe("req-1");
  });
});

describe("addOutcome", () => {
  test.each([
    [res(201), "added"],
    [res(200), "alreadyListed"],
    [res(404, "tenant_not_found"), "tenantNotFound"],
    [res(403, "origin_rejected"), "notPermitted"],
    [res(429, "rate_limited"), "rateLimited"],
    [res(400, "validation_error"), "failed"],
  ] as const)("%o is %s", (r, kind) => {
    expect(addOutcome(r).kind).toBe(kind);
  });
});

describe("removeOutcome", () => {
  test.each([
    [res(204), "removed"],
    [res(403, "forbidden"), "notPermitted"],
    [res(429, "rate_limited"), "rateLimited"],
    [res(500), "failed"],
  ] as const)("%o is %s", (r, kind) => {
    expect(removeOutcome(r).kind).toBe(kind);
  });
});
