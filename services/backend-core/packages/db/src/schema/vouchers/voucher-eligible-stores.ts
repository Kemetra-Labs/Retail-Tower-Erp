/**
 * `voucher_eligible_stores` — the stores a voucher is valid in (0091, Jira
 * RT-1107; plan `docs/planning/rt-922-voucher-issuance.md` section 5.4).
 *
 * `(tenant_id, voucher_id, store_id)`, primary key over all three. Rows exist
 * only when the voucher has `applies_to_all_stores = false`; the database
 * cannot enforce that across tables, so the runtime owns it. Two composite FKs
 * (`(tenant_id, voucher_id) → vouchers (tenant_id, id)` and
 * `(tenant_id, store_id) → stores (tenant_id, id)`, both ON DELETE RESTRICT)
 * are defined in 0091's SQL so neither side can cross tenants.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT tenant policies only (the eligible set
 * is fixed at issue). §XIV: BUSINESS-CLASS — three opaque ids, no PII, no money.
 */
import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

export const voucherEligibleStores = pgTable(
  "voucher_eligible_stores",
  {
    tenantId: uuid("tenant_id").notNull(),
    voucherId: uuid("voucher_id").notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "voucher_eligible_stores_pkey", columns: [t.tenantId, t.voucherId, t.storeId] }),
    index("idx_voucher_eligible_stores_tenant_store").on(t.tenantId, t.storeId),
  ],
);

export type VoucherEligibleStoreRow = typeof voucherEligibleStores.$inferSelect;
export type NewVoucherEligibleStoreRow = typeof voucherEligibleStores.$inferInsert;
