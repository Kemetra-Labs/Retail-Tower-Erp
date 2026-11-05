import type { ManagerApprovalBridgeAPI } from '../../../shared/operator/manager-approval';
import type { SaleVoidBridgeAPI } from '../../../shared/sale-void/types';
import {
  windowRecentSalesBridge,
  type RecentSalesBridge,
} from '../../sale-lookup/recent-sales-bridge';

/** RT-530 — the two bridges the void screen uses: the void domain and the manager approval. */
export interface VoidBridges {
  saleVoid: SaleVoidBridgeAPI;
  approval: ManagerApprovalBridgeAPI;
  /** RT-1192: today's sales for the list and the short number; absent = neither. */
  sales?: RecentSalesBridge;
}

/** `window.api` as the void screen needs it; null when the preload has no void namespace. */
export function windowVoidBridges(): VoidBridges | null {
  const api = (
    window as unknown as {
      api?: { saleVoid?: SaleVoidBridgeAPI; approval?: ManagerApprovalBridgeAPI };
    }
  ).api;
  if (api?.saleVoid === undefined || api.approval === undefined) return null;
  const sales = windowRecentSalesBridge();
  return {
    saleVoid: api.saleVoid,
    approval: api.approval,
    ...(sales === null ? {} : { sales }),
  };
}
