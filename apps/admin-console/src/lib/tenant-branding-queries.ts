/**
 * RT-474 data layer: typed wrappers over the generated `apiClient` for the four
 * Console operations of the tenant-branding contract (RT-473 S1 #761, runtime
 * S2 #204, released in `backend-core/v0.3.3`):
 *
 *   - `consoleGetTenantLogo`:     GET    /api/v1/tenants/{tenant_id}/logo
 *   - `consolePreviewTenantLogo`: POST   /api/v1/tenants/{tenant_id}/logo/preview
 *   - `consolePutTenantLogo`:     PUT    /api/v1/tenants/{tenant_id}/logo
 *   - `consoleDeleteTenantLogo`:  DELETE /api/v1/tenants/{tenant_id}/logo
 *
 * Boundary: the POS read in the same document (`posGetTenantBranding`) is not
 * wrapped. Every image check is Backend-Core's; nothing here inspects the file.
 *
 * Upload body: the contract takes the raw file bytes under any Content-Type and
 * says Admin-Console sends `application/octet-stream`. openapi-fetch would
 * JSON-encode a body by default, so the upload passes the File through
 * unchanged. Each wrapper returns `{ status, data?, error?, retryAfter }`; the
 * console 429 carries `Retry-After` (RT-574). Cookie transport is on the
 * generated client.
 */
import { apiClient } from "@/generated/client";
import type { TenantBrandingSchema } from "@/generated/schema";

type Schemas = TenantBrandingSchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

export type TenantBranding = Schemas["TenantBranding"];
export type TenantLogo = Schemas["TenantLogo"];
export type LogoPreview = Schemas["LogoPreview"];
export type LogoWarning = Schemas["LogoWarning"];
export type LogoRejectionCode = Schemas["LogoRejectionCode"];
export type ScreenRendition = Schemas["ScreenRendition"];
export type ReceiptRendition = Schemas["ReceiptRendition"];
export type ScreenSlot = ScreenRendition["slot"];

/** The contract's raw-body upload: the File itself, never a serialized copy. */
const RAW_UPLOAD = {
  bodySerializer: (file: unknown) => file as Blob,
  headers: { "Content-Type": "application/octet-stream" },
};

function result<T>(r: { data?: T; error?: unknown; response: Response }) {
  return {
    status: r.response.status,
    data: r.data,
    error: r.error,
    retryAfter: r.response.headers.get("retry-after"),
  };
}

/** GET the tenant's branding: display name, `revision`, and the logo or `null`. */
export async function consoleGetTenantLogo(tenantId: string) {
  return result(
    await apiClient.GET("/api/v1/tenants/{tenant_id}/logo", {
      params: { path: { tenant_id: tenantId } },
    }),
  );
}

/** Validate and render the file without storing it. `signal` cancels a superseded preview. */
export async function consolePreviewTenantLogo(tenantId: string, file: Blob, signal?: AbortSignal) {
  return result(
    await apiClient.POST("/api/v1/tenants/{tenant_id}/logo/preview", {
      params: { path: { tenant_id: tenantId } },
      body: file,
      ...RAW_UPLOAD,
      signal,
    }),
  );
}

export interface LogoSaveParams {
  /** The `version` the preview of these exact bytes returned. */
  previewVersion: string;
  /** The branding `revision` the admin saw (OD-15). */
  expectedRevision: number;
}

/** Save or replace the logo with the previewed bytes. */
export async function consolePutTenantLogo(
  tenantId: string,
  file: Blob,
  { previewVersion, expectedRevision }: LogoSaveParams,
) {
  return result(
    await apiClient.PUT("/api/v1/tenants/{tenant_id}/logo", {
      params: {
        path: { tenant_id: tenantId },
        query: { preview_version: previewVersion, expected_revision: expectedRevision },
      },
      body: file,
      ...RAW_UPLOAD,
    }),
  );
}

/** Remove the logo; the POS falls back to the tenant name. */
export async function consoleDeleteTenantLogo(
  tenantId: string,
  { expectedRevision }: Pick<LogoSaveParams, "expectedRevision">,
) {
  return result(
    await apiClient.DELETE("/api/v1/tenants/{tenant_id}/logo", {
      params: { path: { tenant_id: tenantId }, query: { expected_revision: expectedRevision } },
    }),
  );
}
