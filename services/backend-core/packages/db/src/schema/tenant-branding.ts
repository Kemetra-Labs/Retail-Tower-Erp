/**
 * Tenant logo branding — RT-473 S2 (spec 039, OD-1; `0076_tenant_logo_branding.sql`,
 * [GATED]). Contract: `tenant-branding.openapi.yaml` (RT-473 S1).
 *
 *   - `tenant_branding_revisions`: the per-tenant monotonic write counter
 *     (FR-14a). No row = revision 0; kept across logo removal; every update
 *     moves it up by exactly one (trigger).
 *   - `tenant_logos`: one logo per tenant (D-1): the normalized master PNG,
 *     its content version (FR-13), presentation and warnings.
 *   - `tenant_logo_renditions`: 8 screen renditions + 1 receipt rendition,
 *     deleted with their logo.
 *
 * Only server re-encoded PNGs are stored; never the upload or an SVG. All
 * three are tenant-RLS-forced; the CHECKs, policies and trigger live in the
 * SQL migration.
 */
import { boolean, customType, integer, bigint, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const tenantBrandingRevisions = pgTable("tenant_branding_revisions", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "restrict" }),
  revision: bigint("revision", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantLogos = pgTable("tenant_logos", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "restrict" }),
  version: text("version").notNull(),
  pipelineVersion: text("pipeline_version").notNull(),
  masterPng: bytea("master_png").notNull(),
  masterWidth: integer("master_width").notNull(),
  masterHeight: integer("master_height").notNull(),
  presentationCard: boolean("presentation_card").notNull(),
  warnings: text("warnings").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantLogoRenditions = pgTable(
  "tenant_logo_renditions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantLogos.tenantId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    scale: smallint("scale").notNull(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    dpi: smallint("dpi"),
    png: bytea("png").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.scale] })],
);

export type TenantLogoRow = typeof tenantLogos.$inferSelect;
export type TenantLogoRenditionRow = typeof tenantLogoRenditions.$inferSelect;
