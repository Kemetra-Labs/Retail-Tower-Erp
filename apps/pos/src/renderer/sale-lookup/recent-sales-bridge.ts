import type { SalesBridgeAPI } from '../../shared/bridge-api';

/**
 * RT-1192 — the one member of `window.api.sales` these screens use: the main
 * read of today's sales on this terminal (RT-1189). No new bridge: the request
 * can name nothing but a short form, and main derives tenant, branch, terminal,
 * role and the Cairo day from the session.
 */
export type RecentSalesBridge = Pick<SalesBridgeAPI, 'listRecent'>;

/** Null when the preload has no `sales` namespace. */
export function windowRecentSalesBridge(): RecentSalesBridge | null {
  const sales = (window as unknown as { api?: { sales?: Partial<RecentSalesBridge> } }).api?.sales;
  if (sales?.listRecent === undefined) return null;
  return { listRecent: (req) => sales.listRecent?.(req) ?? Promise.reject(new Error('no sales')) };
}
