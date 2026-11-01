/**
 * RT-473 S2 — tenant branding over HTTP against real Postgres (Testcontainers,
 * every migration incl. 0076, the NOBYPASSRLS `app_test` pool), the real module
 * graph (`TenantContextGuard`, `RolesGuard`, `PosDeviceAuthGuard`) and the
 * `logoUploadPassthrough` that main.ts registers before the body parsers. Only
 * cookie authentication is faked: a header names the session (RT-192 / RT-387).
 *
 * tenant-branding.openapi.yaml, every operation:
 *   - POS read: "no logo" is 200 `logo: null`; ETag / If-None-Match → 304;
 *     strict query; device token only;
 *   - Console read / preview / save / remove, the documented check order
 *     (422 → preview mismatch 409 → replay 200 → revision 409 → write), the
 *     raw body under any Content-Type (type by magic bytes only), 413, 400;
 *   - revision across remove and re-save (no ABA), the per-tenant lock on two
 *     concurrent first saves, one audit row per write and none on a replay;
 *   - isolation: tenant B can neither read nor replace tenant A's logo, and a
 *     tenant-B device reads only tenant B; a wrong role is the same 404;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { brandingEtag } from "../../src/tenant-branding/branding.projections";
import { logoUploadPassthrough } from "../../src/tenant-branding/logo-body";
import { LOGO_MAX_PENDING_JOBS } from "../../src/tenant-branding/logo-config";
import { logoJobs, processLogo } from "../../src/tenant-branding/logo-pipeline";
import { TenantBrandingModule } from "../../src/tenant-branding/tenant-branding.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  logoAudits,
  SES_MANAGER,
  SES_OWNER_B,
  seedBrandingFixture,
  storedCounts,
  tenantName,
  TOKEN_A,
  TOKEN_B,
  USER_OWNER_ALL,
} from "./__support__/branding-fixture";
import { logoPng, NAVY, RECT, svg } from "./__support__/logo-images";

const h = scopedHttpHarness({
  label: "RT-473 tenant-branding",
  contractId: "tenant-branding.openapi",
  module: TenantBrandingModule,
  seed: seedBrandingFixture,
  beforeInit: (app) => app.use(logoUploadPassthrough),
});
const skip = (): boolean => h.skipped();

const logoPath = (tenantId: string): string => `/api/v1/tenants/${tenantId}/logo`;
const previewPath = (tenantId: string): string => `${logoPath(tenantId)}/preview`;
const DEVICE_READ = "/api/pos/v1/tenant/branding";
const REPLACED = "tenant.logo.replaced";
const REMOVED = "tenant.logo.removed";

const LOGO_1 = logoPng(1024, 256);
const LOGO_2 = logoPng(1024, 300, { colour: [120, 20, 20, 255] });
const LOGO_B1 = logoPng(800, 400, { colour: NAVY });
const LOGO_B2 = logoPng(900, 400, { colour: NAVY });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

let version1 = "";
let version2 = "";

/** The raw bytes under `contentType`: superagent would otherwise JSON- or form-encode a Buffer for those types. */
function upload(req: request.Test, contentType = "application/octet-stream"): request.Test {
  return req.set("Content-Type", contentType).serialize((body: unknown) => body as string);
}

beforeAll(async () => {
  // Computed here (not by an earlier test) so one failing test cannot cascade.
  version1 = (await processLogo(LOGO_1)).version;
  version2 = (await processLogo(LOGO_2)).version;
});

function preview(session: string | null, bytes: Buffer, contentType?: string, tenantId = TENANT_A): request.Test {
  return upload(h.post(previewPath(tenantId), session, bytes), contentType);
}

function save(
  session: string | null,
  bytes: Buffer,
  query: { preview_version?: string; expected_revision?: number | string },
  tenantId = TENANT_A,
): request.Test {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString();
  return upload(h.put(`${logoPath(tenantId)}?${qs}`, session, bytes));
}

function remove(session: string | null, expectedRevision: number | string, tenantId = TENANT_A): request.Test {
  return h.del(`${logoPath(tenantId)}?expected_revision=${expectedRevision}`, session);
}

function deviceRead(token: string, headers: Record<string, string> = {}): request.Test {
  let req = h.get(DEVICE_READ, null).set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req;
}

function expectError(res: request.Response, status: number, code: string, schema = "Error"): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms(schema, res.body);
}

function expectNotFound(res: request.Response): void {
  expectError(res, 404, "not_found");
}

describe("before any logo", () => {
  it("the POS read is 200 with logo: null, revision 0 and the FR-18 ETag", async () => {
    if (skip()) return;
    const res = await deviceRead(TOKEN_A).expect(200);
    h.conforms("TenantBranding", res.body);
    const name = await tenantName(h.env().admin, TENANT_A);
    expect(res.body).toEqual({ tenant_display_name: name, revision: 0, logo: null });
    expect(res.headers["etag"]).toBe(brandingEtag(name, 0));
    expect(res.headers["cache-control"]).toBe("no-cache, private");
  });

  it("answers 304 with no body for the same If-None-Match", async () => {
    if (skip()) return;
    const first = await deviceRead(TOKEN_A).expect(200);
    const res = await deviceRead(TOKEN_A, { "If-None-Match": first.headers["etag"] as string }).expect(304);
    expect(res.text).toBe("");
    expect(res.headers["etag"]).toBe(first.headers["etag"]);
    expect(res.headers["cache-control"]).toBe("no-cache, private");
  });

  it("refuses a malformed If-None-Match and any query key with 400", async () => {
    if (skip()) return;
    expectError(await deviceRead(TOKEN_A, { "If-None-Match": 'W/"abc"' }), 400, "validation_error");
    expectError(await h.get(DEVICE_READ, null, { tenant_id: TENANT_B }).set("Authorization", `Bearer ${TOKEN_A}`), 400, "validation_error");
  });

  it("is 401 without a device token, and for a dashboard session", async () => {
    if (skip()) return;
    expect((await h.get(DEVICE_READ, null)).status).toBe(401);
    expect((await h.get(DEVICE_READ, SES_OWNER_ALL)).status).toBe(401);
  });

  it("the Console read is the same body", async () => {
    if (skip()) return;
    const res = await h.get(logoPath(TENANT_A), SES_OWNER_ALL).expect(200);
    h.conforms("TenantBranding", res.body);
    expect(res.body).toMatchObject({ revision: 0, logo: null });
  });
});

describe("Console access", () => {
  it("is 401 with no session (a bearer alone included)", async () => {
    if (skip()) return;
    expect((await h.get(logoPath(TENANT_A), null)).status).toBe(401);
    expect((await h.get(logoPath(TENANT_A), null).set("Authorization", `Bearer ${TOKEN_A}`)).status).toBe(401);
    expect((await preview(null, LOGO_1)).status).toBe(401);
  });

  it("is the same 404 for another tenant and for a role other than owner / tenant_admin", async () => {
    if (skip()) return;
    expectNotFound(await h.get(logoPath(TENANT_B), SES_OWNER_ALL));
    expectNotFound(await h.get(logoPath(TENANT_A), SES_OWNER_B));
    expectNotFound(await h.get(logoPath(TENANT_A), SES_MANAGER));
    expectNotFound(await preview(SES_MANAGER, LOGO_1));
    expectNotFound(await preview(SES_OWNER_B, LOGO_1));
    expectNotFound(await remove(SES_MANAGER, 0));
  });

  it("is 400 for a malformed tenant_id or an unknown query key", async () => {
    if (skip()) return;
    expectError(await h.get(logoPath("not-a-uuid"), SES_OWNER_ALL), 400, "validation_error");
    expectError(await h.get(logoPath(TENANT_A), SES_OWNER_ALL, { x: 1 }), 400, "validation_error");
  });

  it("admits a tenant_admin", async () => {
    if (skip()) return;
    await h.get(logoPath(TENANT_A), SES_ADMIN_SPEC).expect(200);
  });
});

describe("preview", () => {
  it("renders under any Content-Type: the type comes from the magic bytes only", async () => {
    if (skip()) return;
    const expected = (await processLogo(LOGO_1)).version;
    for (const type of ["application/octet-stream", "image/png", "image/svg+xml", "application/json", "application/x-www-form-urlencoded", "text/plain"]) {
      const res = await preview(SES_OWNER_ALL, LOGO_1, type);
      expect({ type, status: res.status }).toEqual({ type, status: 200 });
      h.conforms("LogoPreview", res.body);
      expect((res.body as { version: string }).version).toBe(expected);
    }
    expect(expected).toBe(version1);
  });

  it("returns the 8 screen renditions and the 203-dpi receipt rendition", async () => {
    if (skip()) return;
    const res = await preview(SES_OWNER_ALL, LOGO_1).expect(200);
    const body = res.body as { screen: unknown[]; receipt: { width_px: number; height_px: number; dpi: number } };
    expect(body.screen).toHaveLength(8);
    expect(body.receipt.dpi).toBe(203);
    expect(body.receipt.width_px).toBeLessThanOrEqual(383);
    expect(body.receipt.height_px).toBeLessThanOrEqual(119);
  });

  it("accepts SVG bytes declared image/png", async () => {
    if (skip()) return;
    await preview(SES_OWNER_ALL, svg(RECT), "image/png").expect(200);
  });

  it("refuses JPEG bytes declared image/png with 422 file_type_not_allowed", async () => {
    if (skip()) return;
    expectError(await preview(SES_OWNER_ALL, JPEG, "image/png"), 422, "file_type_not_allowed", "LogoRejectedError");
  });

  it("names the refused SVG construct and echoes nothing of the file", async () => {
    if (skip()) return;
    const res = await preview(SES_OWNER_ALL, svg(`<script>alert("secret-marker")</script>`), "image/svg+xml");
    expectError(res, 422, "svg_unsafe_content", "LogoRejectedError");
    expect((res.body as { error: { details: unknown } }).error.details).toEqual({ construct: "script" });
    expect(res.text).not.toContain("secret-marker");
  });

  it("is 400 for an empty body or a query key, 413 over 1 MiB", async () => {
    if (skip()) return;
    expectError(await preview(SES_OWNER_ALL, Buffer.alloc(0)), 400, "validation_error");
    expectError(await upload(h.post(`${previewPath(TENANT_A)}?x=1`, SES_OWNER_ALL, LOGO_1)), 400, "validation_error");
    expectError(await preview(SES_OWNER_ALL, Buffer.alloc(1024 * 1024 + 1, 1)), 413, "file_too_large");
  });

  it("stores and audits nothing", async () => {
    if (skip()) return;
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 0, renditions: 0 });
    expect(await logoAudits(h.env().admin, TENANT_A, REPLACED)).toEqual([]);
  });
});

describe("a busy logo renderer (RT-1041)", () => {
  /** Holds every slot of the per-process logo queue until `release()`. */
  function holdQueue(): { release: () => Promise<void> } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = Array.from({ length: LOGO_MAX_PENDING_JOBS }, () => logoJobs.run(() => gate));
    return {
      release: async () => {
        open();
        await Promise.all(held);
      },
    };
  }

  function expectRendererBusy(res: request.Response): void {
    expectError(res, 429, "rate_limited", "RateLimitedError");
    // The renderer's own 429, not the jobOrPreview rate limit's.
    expect((res.body as { error: { message: string } }).error.message).toBe("The image renderer is busy. Retry shortly.");
    expect(res.headers["retry-after"]).toBe("8");
    expect(res.headers["cache-control"]).toBe("no-store");
  }

  it("answers preview and save with 429 rate_limited and Retry-After, storing nothing, then serves again", async () => {
    if (skip()) return;
    const queue = holdQueue();
    try {
      expectRendererBusy(await preview(SES_OWNER_ALL, LOGO_1));
      expectRendererBusy(await save(SES_OWNER_ALL, LOGO_1, { preview_version: version1, expected_revision: 0 }));
    } finally {
      await queue.release();
    }
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 0, renditions: 0 });
    expect(await logoAudits(h.env().admin, TENANT_A, REPLACED)).toEqual([]);
    await preview(SES_OWNER_ALL, LOGO_1).expect(200);
  });
});

describe("save", () => {
  it("is 400 without preview_version or expected_revision, or with a malformed one", async () => {
    if (skip()) return;
    expectError(await save(SES_OWNER_ALL, LOGO_1, { expected_revision: 0 }), 400, "validation_error");
    expectError(await save(SES_OWNER_ALL, LOGO_1, { preview_version: version1 }), 400, "validation_error");
    expectError(await save(SES_OWNER_ALL, LOGO_1, { preview_version: version1, expected_revision: -1 }), 400, "validation_error");
  });

  it("checks the pipeline (422) before the preview version (409)", async () => {
    if (skip()) return;
    const res = await save(SES_OWNER_ALL, JPEG, { preview_version: version1, expected_revision: 0 });
    expectError(res, 422, "file_type_not_allowed", "LogoRejectedError");
  });

  it("refuses bytes that no longer produce preview_version with 409 logo_preview_mismatch", async () => {
    if (skip()) return;
    expectError(await save(SES_OWNER_ALL, LOGO_2, { preview_version: version1, expected_revision: 0 }), 409, "logo_preview_mismatch");
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 0, renditions: 0 });
  });

  it("saves the first logo: revision 1, one replaced audit, 1 logo and 9 renditions", async () => {
    if (skip()) return;
    const res = await save(SES_OWNER_ALL, LOGO_1, { preview_version: version1, expected_revision: 0 }).expect(200);
    h.conforms("TenantBrandingSaved", res.body);
    expect(res.body).toMatchObject({ revision: 1, logo: { version: version1 } });
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 1, renditions: 9 });
    expect(await logoAudits(h.env().admin, TENANT_A, REPLACED)).toEqual([
      { actor_user_id: USER_OWNER_ALL, target_id: TENANT_A, metadata: { from_version: null, to_version: version1 } },
    ]);
  });

  it("replays the same bytes as 200 with no audit, even with a stale expected_revision", async () => {
    if (skip()) return;
    const res = await save(SES_OWNER_ALL, LOGO_1, { preview_version: version1, expected_revision: 0 }).expect(200);
    expect(res.body).toMatchObject({ revision: 1, logo: { version: version1 } });
    expect(await logoAudits(h.env().admin, TENANT_A, REPLACED)).toHaveLength(1);
  });

  it("refuses a replace from a stale revision with 409 logo_changed_concurrently, changing nothing", async () => {
    if (skip()) return;
    expect((await preview(SES_OWNER_ALL, LOGO_2).expect(200)).body.version).toBe(version2);
    expectError(await save(SES_OWNER_ALL, LOGO_2, { preview_version: version2, expected_revision: 0 }), 409, "logo_changed_concurrently");
    const now = await h.get(logoPath(TENANT_A), SES_OWNER_ALL).expect(200);
    expect(now.body).toMatchObject({ revision: 1, logo: { version: version1 } });
  });

  it("replaces from the current revision: revision 2 and {from_version, to_version}", async () => {
    if (skip()) return;
    const res = await save(SES_ADMIN_SPEC, LOGO_2, { preview_version: version2, expected_revision: 1 }).expect(200);
    expect(res.body).toMatchObject({ revision: 2, logo: { version: version2 } });
    const audits = await logoAudits(h.env().admin, TENANT_A, REPLACED);
    expect(audits.at(-1)?.metadata).toEqual({ from_version: version1, to_version: version2 });
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 1, renditions: 9 });
  });

  it("the POS sees the new logo with a new ETag; the old ETag gets a 200", async () => {
    if (skip()) return;
    const name = await tenantName(h.env().admin, TENANT_A);
    const res = await deviceRead(TOKEN_A, { "If-None-Match": brandingEtag(name, 0) }).expect(200);
    h.conforms("TenantBranding", res.body);
    expect(res.headers["etag"]).toBe(brandingEtag(name, 2));
    const consoleRead = await h.get(logoPath(TENANT_A), SES_OWNER_ALL).expect(200);
    expect(res.body).toEqual(consoleRead.body);
  });
});

describe("tenant isolation", () => {
  it("tenant B can neither read nor replace tenant A's logo", async () => {
    if (skip()) return;
    expectNotFound(await h.get(logoPath(TENANT_A), SES_OWNER_B));
    expectNotFound(await save(SES_OWNER_B, LOGO_1, { preview_version: version1, expected_revision: 2 }, TENANT_A));
    expectNotFound(await remove(SES_OWNER_B, 2, TENANT_A));
    const a = await h.get(logoPath(TENANT_A), SES_OWNER_ALL).expect(200);
    expect(a.body).toMatchObject({ revision: 2, logo: { version: version2 } });
  });

  it("a tenant-B device and owner see only tenant B (no logo)", async () => {
    if (skip()) return;
    expect((await deviceRead(TOKEN_B).expect(200)).body).toMatchObject({ revision: 0, logo: null });
    expect((await h.get(logoPath(TENANT_B), SES_OWNER_B).expect(200)).body).toMatchObject({ revision: 0, logo: null });
  });

  it("two concurrent first saves at revision 0: exactly one wins, the other is 409", async () => {
    if (skip()) return;
    const v1 = (await processLogo(LOGO_B1)).version;
    const v2 = (await processLogo(LOGO_B2)).version;
    const results = await Promise.all([
      save(SES_OWNER_B, LOGO_B1, { preview_version: v1, expected_revision: 0 }, TENANT_B),
      save(SES_OWNER_B, LOGO_B2, { preview_version: v2, expected_revision: 0 }, TENANT_B),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await deviceRead(TOKEN_B).expect(200)).body).toMatchObject({ revision: 1 });
    expect(await logoAudits(h.env().admin, TENANT_B, REPLACED)).toHaveLength(1);
  });
});

describe("remove", () => {
  it("refuses a stale expected_revision with 409, deleting nothing", async () => {
    if (skip()) return;
    expectError(await remove(SES_OWNER_ALL, 1), 409, "logo_changed_concurrently");
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 1, renditions: 9 });
  });

  it("removes the logo and its renditions: logo null, revision 3, one removed audit", async () => {
    if (skip()) return;
    const res = await remove(SES_OWNER_ALL, 2).expect(200);
    h.conforms("TenantBrandingRemoved", res.body);
    expect(res.body).toMatchObject({ revision: 3, logo: null });
    expect(await storedCounts(h.env().admin, TENANT_A)).toEqual({ logos: 0, renditions: 0 });
    expect((await logoAudits(h.env().admin, TENANT_A, REMOVED)).map((a) => a.metadata)).toEqual([{ from_version: version2 }]);
  });

  it("is idempotent with no logo: 200, revision unchanged, no audit, whatever expected_revision says", async () => {
    if (skip()) return;
    expect((await remove(SES_OWNER_ALL, 0).expect(200)).body).toMatchObject({ revision: 3, logo: null });
    expect(await logoAudits(h.env().admin, TENANT_A, REMOVED)).toHaveLength(1);
  });

  it("the POS falls back to the name: logo null with the revision-3 ETag", async () => {
    if (skip()) return;
    const name = await tenantName(h.env().admin, TENANT_A);
    const res = await deviceRead(TOKEN_A).expect(200);
    expect(res.body).toEqual({ tenant_display_name: name, revision: 3, logo: null });
    expect(res.headers["etag"]).toBe(brandingEtag(name, 3));
  });

  it("re-saving the identical bytes after removal is a new revision (no ABA)", async () => {
    if (skip()) return;
    const res = await save(SES_OWNER_ALL, LOGO_2, { preview_version: version2, expected_revision: 3 }).expect(200);
    expect(res.body).toMatchObject({ revision: 4, logo: { version: version2 } });
    expect((await logoAudits(h.env().admin, TENANT_A, REPLACED)).at(-1)?.metadata).toEqual({ from_version: null, to_version: version2 });
  });
});
