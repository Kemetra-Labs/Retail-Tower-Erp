/**
 * TenantBrandingService — RT-473 S2: the runtime of tenant-branding.openapi.yaml
 * (spec 039).
 *
 * Every database call runs in ONE transaction under the caller's tenant
 * (`runWithTenantContext` on the NOBYPASSRLS domain pool). The tenant comes
 * from the session (Console) or the device row (POS), never the request.
 *
 * The image pipeline runs BEFORE any transaction, so no connection or lock is
 * held while an upload is decoded and rendered.
 *
 * Save, in the contract's order (FR-14, FR-14a):
 *   1. the full pipeline on the body (422);
 *   2. computed version ≠ `preview_version` → 409 `logo_preview_mismatch`;
 *   then, under the per-tenant lock:
 *   3. stored version = computed version → 200, no audit (idempotent replay);
 *   4. revision ≠ `expected_revision` → 409 `logo_changed_concurrently`;
 *   5. upsert, revision + 1, `tenant.logo.replaced`.
 * Remove: no logo → 200 (current branding, no audit); revision mismatch → 409;
 * delete, revision + 1, `tenant.logo.removed`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { insertLogoRemoved, insertLogoReplaced, type LogoAudit } from "./branding-audit";
import {
  brandingEtag,
  toBrandingBody,
  toPreviewBody,
  type LogoPreviewBody,
  type TenantBrandingBody,
} from "./branding.projections";
import { BrandingRepository } from "./branding.repository";
import { processLogo } from "./logo-pipeline";

export type LogoConflictCode = "logo_preview_mismatch" | "logo_changed_concurrently";

/** A save or remove precondition failed (→ 409 with `code`); nothing was changed. */
export class LogoConflictError extends Error {
  constructor(readonly code: LogoConflictCode) {
    super(code);
    this.name = "LogoConflictError";
  }
}

export interface WriteInput extends LogoAudit {
  readonly expectedRevision: number;
}

@Injectable()
export class TenantBrandingService {
  private readonly repo = new BrandingRepository();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** `posGetTenantBranding` / `consoleGetTenantLogo`: the same body on both surfaces. */
  read(tenantId: string): Promise<TenantBrandingBody> {
    return this.inTenant(tenantId, (client) => this.body(client, tenantId));
  }

  /**
   * `posGetTenantBranding`: the ETag comes from the name and revision alone
   * (FR-18), so an unchanged poll (`304`) never loads the rendition bytes.
   */
  deviceRead(tenantId: string, ifNoneMatch: string | undefined): Promise<{ etag: string; body: TenantBrandingBody | null }> {
    return this.inTenant(tenantId, async (client) => {
      const head = await this.repo.head(client, tenantId);
      if (head.name === null) throw new Error("tenant branding: the tenant row is not visible in its own context");
      const etag = brandingEtag(head.name, head.revision);
      if (ifNoneMatch === etag) return { etag, body: null };
      return { etag, body: toBrandingBody(head.name, head.revision, await this.repo.logo(client, tenantId)) };
    });
  }

  /** `consolePreviewTenantLogo`: validates and renders; stores and audits nothing. */
  async preview(bytes: Buffer): Promise<LogoPreviewBody> {
    return toPreviewBody(await processLogo(bytes));
  }

  /** `consolePutTenantLogo`. */
  async save(input: WriteInput, bytes: Buffer, previewVersion: string): Promise<TenantBrandingBody> {
    const logo = await processLogo(bytes);
    if (logo.version !== previewVersion) throw new LogoConflictError("logo_preview_mismatch");
    return this.inTenant(input.tenantId, async (client) => {
      await this.repo.lock(client, input.tenantId);
      const stored = await this.repo.storedVersion(client, input.tenantId);
      if (stored === logo.version) return this.body(client, input.tenantId);
      if ((await this.repo.revision(client, input.tenantId)) !== input.expectedRevision) {
        throw new LogoConflictError("logo_changed_concurrently");
      }
      await this.repo.upsert(client, input.tenantId, logo);
      await this.repo.bumpRevision(client, input.tenantId);
      await insertLogoReplaced(client, input, stored, logo.version);
      return this.body(client, input.tenantId);
    });
  }

  /** `consoleDeleteTenantLogo`. */
  remove(input: WriteInput): Promise<TenantBrandingBody> {
    return this.inTenant(input.tenantId, async (client) => {
      await this.repo.lock(client, input.tenantId);
      const stored = await this.repo.storedVersion(client, input.tenantId);
      if (stored === null) return this.body(client, input.tenantId);
      if ((await this.repo.revision(client, input.tenantId)) !== input.expectedRevision) {
        throw new LogoConflictError("logo_changed_concurrently");
      }
      await this.repo.delete(client, input.tenantId);
      await this.repo.bumpRevision(client, input.tenantId);
      await insertLogoRemoved(client, input, stored);
      return this.body(client, input.tenantId);
    });
  }

  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, work);
  }

  private async body(client: PoolClient, tenantId: string): Promise<TenantBrandingBody> {
    const name = await this.repo.displayName(client, tenantId);
    if (name === null) throw new Error("tenant branding: the tenant row is not visible in its own context");
    return toBrandingBody(name, await this.repo.revision(client, tenantId), await this.repo.logo(client, tenantId));
  }
}
