/**
 * The English catalog (the second locale). Every module is typed against its
 * Arabic counterpart, and the whole is typed against the Arabic key set, so a
 * missing English string is a compile error.
 */
import type { ar } from "./ar";
import { aiManagerSales } from "./en/aiManagerSales";
import { aiPlan } from "./en/aiPlan";
import { audit } from "./en/audit";
import { auth } from "./en/auth";
import { branding } from "./en/branding";
import { brands } from "./en/brands";
import { cashPolicy } from "./en/cashPolicy";
import { catalog } from "./en/catalog";
import { catalogImport } from "./en/catalogImport";
import { common } from "./en/common";
import { counts } from "./en/counts";
import { devices } from "./en/devices";
import { downloadPos } from "./en/downloadPos";
import { erp } from "./en/erp";
import { forceActions } from "./en/forceActions";
import { inventory } from "./en/inventory";
import { metrics } from "./en/metrics";
import { money } from "./en/money";
import { offers } from "./en/offers";
import { operators } from "./en/operators";
import { overview } from "./en/overview";
import { platform } from "./en/platform";
import { posPilot } from "./en/posPilot";
import { postingHealth } from "./en/postingHealth";
import { postingRepair } from "./en/postingRepair";
import { productRecon } from "./en/productRecon";
import { saleQuarantine } from "./en/saleQuarantine";
import { saleSync } from "./en/saleSync";
import { sales } from "./en/sales";
import { salesByStore } from "./en/salesByStore";
import { salesDaily } from "./en/salesDaily";
import { shell } from "./en/shell";
import { shift } from "./en/shift";
import { stock } from "./en/stock";
import { storeDeletion } from "./en/storeDeletion";
import { tenants } from "./en/tenants";
import { trackedSelling } from "./en/trackedSelling";
import { tracking } from "./en/tracking";
import { transfers } from "./en/transfers";
import { vouchers } from "./en/vouchers";
import type { MessagesOf } from "./types";

export const EN_MODULES = {
  common,
  shell,
  platform,
  auth,
  tenants,
  operators,
  audit,
  stock,
  shift,
  money,
  overview,
  erp,
  productRecon,
  devices,
  forceActions,
  storeDeletion,
  downloadPos,
  posPilot,
  sales,
  saleSync,
  saleQuarantine,
  postingRepair,
  postingHealth,
  cashPolicy,
  inventory,
  counts,
  transfers,
  aiPlan,
  aiManagerSales,
  branding,
  catalog,
  catalogImport,
  metrics,
  salesDaily,
  salesByStore,
  tracking,
  trackedSelling,
  vouchers,
  brands,
  offers,
};

export const en: MessagesOf<typeof ar> = {
  ...common,
  ...shell,
  ...platform,
  ...auth,
  ...tenants,
  ...operators,
  ...audit,
  ...stock,
  ...shift,
  ...money,
  ...overview,
  ...erp,
  ...productRecon,
  ...devices,
  ...forceActions,
  ...storeDeletion,
  ...downloadPos,
  ...posPilot,
  ...sales,
  ...saleSync,
  ...saleQuarantine,
  ...postingRepair,
  ...postingHealth,
  ...cashPolicy,
  ...inventory,
  ...counts,
  ...transfers,
  ...aiPlan,
  ...aiManagerSales,
  ...branding,
  ...catalog,
  ...catalogImport,
  ...metrics,
  ...salesDaily,
  ...salesByStore,
  ...tracking,
  ...trackedSelling,
  ...vouchers,
  ...brands,
  ...offers,
};
