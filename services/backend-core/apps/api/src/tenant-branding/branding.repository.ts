/**
 * Persistence of the tenant logo branding (RT-473 S2 on `0076_tenant_logo_branding`).
 *
 * Every method takes the caller's tenant-scoped client (`runWithTenantContext`
 * on the NOBYPASSRLS domain pool): all three tables are FORCE RLS by tenant,
 * and each statement also names the tenant explicitly.
 *
 * Writes serialize per tenant on a transaction-level advisory lock (FR-14a):
 * it covers two first uploads at revision 0 (no row to lock yet) and needs no
 * table lock or grant beyond the session's own, the same mechanism as the
 * cash-variance policy publish. The spec names `SELECT … FOR UPDATE` on the
 * tenant's `tenants` row; that needs UPDATE on `tenants`, which the domain
 * role does not hold, and the lock gives the same serialization.
 */
import type { PoolClient } from "pg";

import { PIPELINE_VERSION, SCALES, SLOTS, type Scale, type Slot } from "./logo-config";
import type { LogoWarning, ProcessedLogo } from "./logo-pipeline";
import type { StoredLogo } from "./branding.projections";

interface LogoRow {
  version: string;
  presentation_card: boolean;
  warnings: LogoWarning[];
  updated_at: Date;
}

interface RenditionRow {
  kind: Slot | "receipt";
  scale: number;
  width_px: number;
  height_px: number;
  dpi: number | null;
  png: Buffer;
}

const SLOT_ORDER: readonly string[] = SLOTS;

/**
 * The advisory-lock key every tenant logo write takes (save, remove and any
 * future OD-8 re-render job MUST use this same key to serialize with them).
 */
export function tenantLogoLockKey(tenantId: string): string {
  return `tenant_logo:${tenantId.toLowerCase()}`;
}

export class BrandingRepository {
  /** Serialises every logo write of the tenant until COMMIT. */
  async lock(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [tenantLogoLockKey(tenantId)]);
  }

  /** `tenants.name` (OD-10), or null when the tenant is not visible. */
  async displayName(client: PoolClient, tenantId: string): Promise<string | null> {
    const r = await client.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1::uuid`, [tenantId]);
    return r.rows[0]?.name ?? null;
  }

  /** The tenant's branding revision; 0 when never written. */
  async revision(client: PoolClient, tenantId: string): Promise<number> {
    const r = await client.query<{ revision: string }>(
      `SELECT revision::text AS revision FROM tenant_branding_revisions WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return r.rows[0] === undefined ? 0 : Number(r.rows[0].revision);
  }

  /** Moves the revision up by one (creating it at 1); returns the new value. */
  async bumpRevision(client: PoolClient, tenantId: string): Promise<number> {
    const r = await client.query<{ revision: string }>(
      `INSERT INTO tenant_branding_revisions (tenant_id, revision) VALUES ($1::uuid, 1)
       ON CONFLICT (tenant_id) DO UPDATE
         SET revision = tenant_branding_revisions.revision + 1, updated_at = now()
       RETURNING revision::text AS revision`,
      [tenantId],
    );
    return Number(r.rows[0]!.revision);
  }

  /** The display name and revision only: enough for the FR-18 ETag, without the image bytes. */
  async head(client: PoolClient, tenantId: string): Promise<{ name: string | null; revision: number }> {
    return { name: await this.displayName(client, tenantId), revision: await this.revision(client, tenantId) };
  }

  /** The stored version, or null when no logo is stored. */
  async storedVersion(client: PoolClient, tenantId: string): Promise<string | null> {
    const r = await client.query<{ version: string }>(`SELECT version FROM tenant_logos WHERE tenant_id = $1::uuid`, [tenantId]);
    return r.rows[0]?.version ?? null;
  }

  /** The stored logo with its renditions, or null. */
  async logo(client: PoolClient, tenantId: string): Promise<StoredLogo | null> {
    const head = await client.query<LogoRow>(
      `SELECT version, presentation_card, warnings, updated_at FROM tenant_logos WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const row = head.rows[0];
    if (row === undefined) return null;
    const r = await client.query<RenditionRow>(
      `SELECT kind, scale, width_px, height_px, dpi, png FROM tenant_logo_renditions WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const receipt = r.rows.find((x) => x.kind === "receipt");
    const screen = r.rows
      .filter((x) => x.kind !== "receipt")
      .sort((a, b) => SLOT_ORDER.indexOf(a.kind) - SLOT_ORDER.indexOf(b.kind) || a.scale - b.scale);
    if (receipt === undefined || receipt.dpi === null || screen.length !== SLOTS.length * SCALES.length) {
      throw new Error("tenant logo renditions are incomplete");
    }
    return {
      version: row.version,
      presentationCard: row.presentation_card,
      warnings: row.warnings,
      updatedAt: row.updated_at,
      screen: screen.map((s) => ({ slot: s.kind as Slot, scale: s.scale as Scale, width: s.width_px, height: s.height_px, png: s.png })),
      receipt: { width: receipt.width_px, height: receipt.height_px, dpi: receipt.dpi, png: receipt.png },
    };
  }

  /** Inserts or replaces the tenant's logo and all nine renditions. */
  async upsert(client: PoolClient, tenantId: string, logo: ProcessedLogo): Promise<void> {
    await client.query(
      `INSERT INTO tenant_logos
         (tenant_id, version, pipeline_version, master_png, master_width, master_height, presentation_card, warnings)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[])
       ON CONFLICT (tenant_id) DO UPDATE SET
         version = EXCLUDED.version, pipeline_version = EXCLUDED.pipeline_version,
         master_png = EXCLUDED.master_png, master_width = EXCLUDED.master_width,
         master_height = EXCLUDED.master_height, presentation_card = EXCLUDED.presentation_card,
         warnings = EXCLUDED.warnings, updated_at = now()`,
      [
        tenantId,
        logo.version,
        PIPELINE_VERSION,
        logo.master.png,
        logo.master.width,
        logo.master.height,
        logo.presentationCard,
        [...logo.warnings],
      ],
    );
    const rows = [
      ...logo.screen.map((s) => ({ kind: s.slot, scale: s.scale, width: s.width, height: s.height, dpi: null, png: s.png })),
      { kind: "receipt", scale: 1, width: logo.receipt.width, height: logo.receipt.height, dpi: logo.receipt.dpi, png: logo.receipt.png },
    ];
    await client.query(
      `INSERT INTO tenant_logo_renditions (tenant_id, kind, scale, width_px, height_px, dpi, png)
       SELECT $1::uuid, r.kind, r.scale, r.width_px, r.height_px, r.dpi, r.png
         FROM unnest($2::text[], $3::smallint[], $4::int[], $5::int[], $6::smallint[], $7::bytea[])
           AS r(kind, scale, width_px, height_px, dpi, png)
       ON CONFLICT (tenant_id, kind, scale) DO UPDATE SET
         width_px = EXCLUDED.width_px, height_px = EXCLUDED.height_px, dpi = EXCLUDED.dpi, png = EXCLUDED.png`,
      [
        tenantId,
        rows.map((r) => r.kind),
        rows.map((r) => r.scale),
        rows.map((r) => r.width),
        rows.map((r) => r.height),
        rows.map((r) => r.dpi),
        rows.map((r) => r.png),
      ],
    );
  }

  /** Deletes the tenant's logo; its renditions go with it (ON DELETE CASCADE). */
  async delete(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(`DELETE FROM tenant_logos WHERE tenant_id = $1::uuid`, [tenantId]);
  }
}
