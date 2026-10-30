/**
 * RT-970 Overview v2 reads. Each is an existing operation through its typed
 * wrapper (no new contract), keyed under `["overview", …]` with the tenant and
 * active store, read on load, scope change and Refresh only (NG-7).
 *
 * - `useGlanceSummary`: ONE `consoleGetSalesSummary` read over `glanceWindow`;
 *   the KPI strip, pipeline steps ② and ③ and the trend chart all use it.
 * - `useActiveDevices`: one page of `consoleListDevices` (`trust_state=active`):
 *   the credentials the console knows to be active. The contract records no
 *   last activity, so nothing here claims a device is online.
 * - `useRecentSales`: the newest five of `consoleListSales`, which needs a
 *   store (`store_id` is required), so tenant-wide it is not read.
 *
 * A 403/404 hides what it feeds (§6.2); a failure is an error with its request
 * id, never a zero.
 */
import { canReadDevices } from "@/devices/deviceLogic";
import { consoleListDevices } from "@/lib/device-queries";
import { type SaleItem, consoleListSales } from "@/lib/sale-queries";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { consoleGetSalesSummary } from "@/lib/sales-summary-queries";
import { addDays } from "@/sales-daily/dailyLogic";
import { canReadSales } from "@/sales/saleLogic";
import { glanceWindow } from "./glanceLogic";
import { type PageCount, pageCount } from "./overviewLogic";
import { asSalesSummary } from "./salesTodayLogic";
import type { OverviewSession } from "./useOverviewPanels";
import { type PanelState, itemsOf, overviewKey, readResult, usePanelQuery } from "./usePanelQuery";

/** The server returns at most this many stores per page (contract maximum). */
const SUMMARY_PAGE_SIZE = 50;
/** One page of active devices; a further page reads as "at least N". */
const DEVICE_PAGE_SIZE = 50;
/** The recent sales the Overview lists. */
export const RECENT_SALES = 5;

function storeQuery(session: OverviewSession): { store_id?: string } {
  return session.activeStoreId ? { store_id: session.activeStoreId } : {};
}

export function useGlanceSummary(
  session: OverviewSession,
  nowMs: number,
): PanelState<SalesSummary> {
  const window = glanceWindow(nowMs);
  const query = { ...storeQuery(session), ...window, page_size: SUMMARY_PAGE_SIZE };
  return usePanelQuery({
    key: [...overviewKey("glance", session), window.from, window.to],
    gate: canReadSales(session.role) ? "run" : "skip",
    read: async () => readResult(await consoleGetSalesSummary(query), asSalesSummary),
  });
}

export function useActiveDevices(session: OverviewSession): PanelState<PageCount> {
  return usePanelQuery({
    key: overviewKey("devices", session),
    gate: canReadDevices(session.role) ? "run" : "skip",
    read: async () =>
      readResult(
        await consoleListDevices({
          trust_state: "active",
          page_size: DEVICE_PAGE_SIZE,
          ...storeQuery(session),
        }),
        (data) => {
          const items = itemsOf(data);
          const cursor = (data as { nextCursor?: unknown } | undefined)?.nextCursor;
          return items
            ? pageCount(items.length, typeof cursor === "string" ? cursor : null)
            : undefined;
        },
      ),
  });
}

export interface RecentSalesPage {
  sales: SaleItem[];
  /** The store's current zone, for showing times (the page's own field). */
  timeZone: string;
}

export type RecentSalesState = PanelState<RecentSalesPage> | { status: "needs-store" };

function recentPage(data: unknown): RecentSalesPage | undefined {
  const items = itemsOf(data);
  const timeZone = (data as { storeTimezone?: unknown } | undefined)?.storeTimezone;
  if (!items || typeof timeZone !== "string") return undefined;
  return { sales: items.slice(0, RECENT_SALES) as SaleItem[], timeZone };
}

/**
 * The newest sales of the active store over the last 31 business days (the
 * contract's bound), newest first as the server orders them.
 */
export function useRecentSales(session: OverviewSession, nowMs: number): RecentSalesState {
  const storeId = session.activeStoreId;
  const allowed = canReadSales(session.role);
  const to = glanceWindow(nowMs).to;
  const from = addDays(to, -30);
  const state = usePanelQuery({
    key: [...overviewKey("recent-sales", session), from, to],
    gate: allowed && storeId ? "run" : "skip",
    read: async () =>
      readResult(
        await consoleListSales({ store_id: storeId ?? "", from, to, page_size: RECENT_SALES }),
        recentPage,
      ),
  });
  if (allowed && !storeId) return { status: "needs-store" };
  return state;
}
