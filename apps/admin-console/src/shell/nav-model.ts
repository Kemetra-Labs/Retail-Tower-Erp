import { canReadBrands } from "@/brands/brandLogic";
import { canReadCatalog } from "@/catalog/catalogLogic";
import type { IconNameFor } from "@/components/icons/Icon";
import { canReadDevices } from "@/devices/deviceLogic";
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import type { MessageKey } from "@/i18n";
import { canReadInventory } from "@/inventory/inventoryLogic";
import { canReadOffers } from "@/offers/offerLogic";
import { canReadPayers } from "@/payers/payerAccess";
import { canUseProductReconciliation } from "@/product-reconciliation/productReconLogic";
import { canOpenAnyReport } from "@/reports/reportsLogic";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { canReadSales } from "@/sales/saleLogic";
import { canReadShiftCloses } from "@/shift-closes/shiftCloseLogic";
import { canReadStockDiscrepancies } from "@/stock-discrepancies/stockDiscrepancyLogic";
import { showTrackingNav } from "@/tracking/trackingLogic";
import { canReadUnknownItems } from "@/unknown-items/unknownItemAccess";
import { canReadVouchers } from "@/vouchers/voucherLogic";

/**
 * The shell's destinations (RT-969, Shell v3). One model feeds the sidebar, the
 * compact-shell drawer (RT-825) and the Ctrl K navigator, so none of them can
 * offer a destination the others don't, or one the role can't open.
 *
 * RT-270 (UX-09): a destination is listed only once it is built. Role-gated
 * entries mirror the API's roles (RT-178, RT-18, RT-560, RT-371, RT-421,
 * RT-587, RT-724, RT-726, RT-727, RT-728, RT-765); the nav is not an
 * authorization decision. The groups follow the owner-approved canvas: daily
 * operations without a heading, then Integration, then Management.
 */

/** Nav glyphs all sit on the md (20) grid (RT-263 doc 25 §2 rule 7). */
export type NavIcon = IconNameFor<"md">;

export interface NavEntry {
  readonly label: MessageKey;
  readonly to: string;
  readonly icon: NavIcon;
  /** Active only on an exact match (the Overview index). */
  readonly end?: boolean;
}

export interface NavGroup {
  readonly id: string;
  /** No heading for the first, daily-operations group. */
  readonly heading?: MessageKey;
  readonly entries: readonly NavEntry[];
}

/** What the shell knows about the tenant beyond the role (server signals). */
export interface NavSignals {
  /** `getTenantTrackingSummary`; undefined while unknown (TR-6). */
  readonly hasTrackedProducts?: boolean;
  /** `getTrackedSellingSetting` answered on; undefined or false hides tracking (OD-T4). */
  readonly trackedSellingOn?: boolean;
}

type Gate = (role: string | null | undefined, signals: NavSignals) => boolean;
const always: Gate = () => true;

interface GatedEntry extends NavEntry {
  readonly canRead: Gate;
}

interface GatedGroup {
  readonly id: string;
  readonly heading?: MessageKey;
  readonly entries: readonly GatedEntry[];
}

const TENANT_NAV: readonly GatedGroup[] = [
  {
    // RT-1291 (RT-1289 F1): the former unheaded first group, split in two. Entries
    // keep their old relative order; only the grouping and the headings are new.
    id: "daily",
    heading: "shell.nav.section.daily",
    entries: [
      { label: "shell.nav.overview", to: "/", icon: "dashboard", end: true, canRead: always },
      // RT-587 (spec 012 FR-012, OD-556-3): sales search and sale detail.
      { label: "sales.nav.label", to: "/sales", icon: "sale", canRead: canReadSales },
      {
        label: "shell.nav.shiftCloses",
        to: "/shift-closes",
        icon: "cash",
        canRead: canReadShiftCloses,
      },
      // RT-1020: the reports index (the daily report, the review screens and
      // the proposed reports). Listed only for a role that can open one.
      { label: "reports.nav.label", to: "/reports", icon: "audit", canRead: canOpenAnyReport },
      // RT-371: the device registry, for the roles the RT-365 API lets read it.
      { label: "devices.nav.label", to: "/devices", icon: "terminal", canRead: canReadDevices },
    ],
  },
  {
    id: "stock",
    heading: "shell.nav.section.stock",
    entries: [
      // RT-765 (RT-752 AC 2): the catalog items; their child routes keep it selected.
      {
        label: "catalog.nav.label",
        to: "/catalog/products",
        icon: "product",
        canRead: canReadCatalog,
      },
      {
        label: "shell.nav.unknownItems",
        to: "/unknown-items",
        icon: "unknownItem",
        canRead: canReadUnknownItems,
      },
      // RT-1338: the flat brands that classify the items (and that offers can target).
      { label: "brands.nav.label", to: "/catalog/brands", icon: "product", canRead: canReadBrands },
      // RT-728: the read-only movement ledger, locations and on-hand.
      {
        label: "inventory.nav.label",
        to: "/inventory",
        icon: "inventory",
        canRead: canReadInventory,
      },
      // RT-455 (TR-1, TR-6): tracking holds and recalls, listed only once the
      // tenant's tracking summary says it has tracked products (967, 968) and
      // its tracked-selling switch is on (part 1, OD-T4).
      {
        label: "tracking.nav.label",
        to: "/tracking",
        icon: "inventory",
        canRead: (role, signals) =>
          showTrackingNav(role, signals.hasTrackedProducts, signals.trackedSellingOn),
      },
      {
        label: "shell.nav.stockDiscrepancies",
        to: "/stock-discrepancies",
        icon: "inventory",
        canRead: canReadStockDiscrepancies,
      },
    ],
  },
  {
    // RT-557 OD-2 (RT-560): ERP connection, its repair queue (RT-726) and product
    // reconciliation (RT-727) share one Integration heading; the audit log joins
    // them on the canvas.
    id: "integration",
    heading: "erp.nav.section",
    entries: [
      {
        label: "erp.nav.label",
        to: "/erp-connection",
        icon: "connection",
        canRead: canReadErpStatus,
      },
      {
        label: "saleSync.nav.label",
        to: "/sales-needing-repair",
        icon: "sale",
        canRead: canUseSaleSyncOps,
      },
      {
        label: "productRecon.nav.label",
        to: "/product-reconciliation",
        icon: "product",
        canRead: canUseProductReconciliation,
      },
      { label: "shell.nav.audit", to: "/audit", icon: "audit", canRead: always },
    ],
  },
  {
    id: "management",
    heading: "shell.nav.section.management",
    entries: [
      { label: "shell.nav.stores", to: "/stores", icon: "store", canRead: always },
      { label: "shell.nav.operators", to: "/operators", icon: "people", canRead: always },
      { label: "shell.nav.tenants", to: "/tenants", icon: "tenant", canRead: always },
      // RT-421: the 017 payer accounts, owner / tenant_admin only.
      { label: "payers.nav.label", to: "/payer-accounts", icon: "cash", canRead: canReadPayers },
      // RT-1109: promotional vouchers, owner / tenant_admin only (decision 2A).
      { label: "vouchers.nav.label", to: "/vouchers", icon: "cash", canRead: canReadVouchers },
      // RT-1338: automatic offers (RT-286): owner / tenant_admin manage, store_manager reads and pauses.
      { label: "offers.nav.label", to: "/offers", icon: "cash", canRead: canReadOffers },
    ],
  },
];

/** RT-781: inside a support session the shell lists no tenant destination. */
const SESSION_NAV: readonly NavGroup[] = [
  {
    id: "platform",
    entries: [{ label: "platform.nav.tenants", to: "/platform/tenants", icon: "tenant" }],
  },
];

/**
 * The platform console's destinations (RT-780). RT-1329 adds the POS pilot page
 * here only: the tenant shell's in-session nav (SESSION_NAV) stays unchanged.
 */
export const PLATFORM_NAV: readonly NavGroup[] = [
  {
    id: "platform",
    entries: [
      { label: "platform.nav.tenants", to: "/platform/tenants", icon: "tenant" },
      { label: "platform.nav.posPilot", to: "/platform/pos-pilot", icon: "terminal" },
    ],
  },
];

/** The tenant shell's groups for a role; a group left with no entry is dropped. */
export function tenantNav(
  role: string | null | undefined,
  inSession: boolean,
  signals: NavSignals = {},
): NavGroup[] {
  if (inSession) return [...SESSION_NAV];
  return TENANT_NAV.map((group) => ({
    id: group.id,
    heading: group.heading,
    entries: group.entries
      .filter((entry) => entry.canRead(role, signals))
      .map(({ canRead: _gate, ...entry }) => entry),
  })).filter((group) => group.entries.length > 0);
}
