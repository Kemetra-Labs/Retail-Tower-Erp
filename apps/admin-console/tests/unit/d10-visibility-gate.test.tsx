import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

const listAuditEvents = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return { ...actual, listAuditEvents: (...a: unknown[]) => listAuditEvents(...a) };
});

const listErpnextNegativeOnHandStores = vi.fn();
const listErpnextNegativeOnHand = vi.fn();
vi.mock("@/lib/stock-discrepancy-queries", () => ({
  listErpnextNegativeOnHandStores: (...a: unknown[]) => listErpnextNegativeOnHandStores(...a),
  listErpnextNegativeOnHand: (...a: unknown[]) => listErpnextNegativeOnHand(...a),
  triggerReconciliationRun: vi.fn(),
}));

const consoleListDevices = vi.fn();
const consoleGetDevice = vi.fn();
vi.mock("@/lib/device-queries", () => ({
  consoleListDevices: (...a: unknown[]) => consoleListDevices(...a),
  consoleGetDevice: (...a: unknown[]) => consoleGetDevice(...a),
}));

const consoleListDeviceHealth = vi.fn();
const consoleGetDeviceHealth = vi.fn();
vi.mock("@/lib/device-health-queries", () => ({
  consoleListDeviceHealth: (...a: unknown[]) => consoleListDeviceHealth(...a),
  consoleGetDeviceHealth: (...a: unknown[]) => consoleGetDeviceHealth(...a),
}));

const listStockLocations = vi.fn();
const listStoreMovements = vi.fn();
const getOnHand = vi.fn();
const listTrackingIdentities = vi.fn();
const listShipmentTransfers = vi.fn();
const getShipmentTransfer = vi.fn();
const listShipmentTransferReceipts = vi.fn();
vi.mock("@/lib/inventory-queries", () => ({
  listStockLocations: (...a: unknown[]) => listStockLocations(...a),
  listStoreMovements: (...a: unknown[]) => listStoreMovements(...a),
  getOnHand: (...a: unknown[]) => getOnHand(...a),
  listTrackingIdentities: (...a: unknown[]) => listTrackingIdentities(...a),
  listShipmentTransfers: (...a: unknown[]) => listShipmentTransfers(...a),
  getShipmentTransfer: (...a: unknown[]) => getShipmentTransfer(...a),
  listShipmentTransferReceipts: (...a: unknown[]) => listShipmentTransferReceipts(...a),
}));

const consoleGetSale = vi.fn();
const consoleListSales = vi.fn();
vi.mock("@/lib/sale-queries", () => ({
  consoleGetSale: (...a: unknown[]) => consoleGetSale(...a),
  consoleListSales: (...a: unknown[]) => consoleListSales(...a),
}));

const useStoreList = vi.fn();
vi.mock("@/stores/useStoreQueries", () => ({
  useStoreList: (...a: unknown[]) => useStoreList(...a),
  useStoreDetail: () => ({
    isLoading: false,
    result: {
      kind: "store",
      store: { id: STORE_ID, name: "Cairo Festival City", timezone: "Africa/Cairo" },
    },
  }),
}));

const useLowStock = vi.fn();
vi.mock("@/overview/LowStockPanel", () => ({
  useLowStock: (...a: unknown[]) => useLowStock(...a),
  LowStockPanel: () => null,
}));

vi.mock("@/sale-sync/SaleSyncSections", () => ({ SaleSyncSections: () => null }));
vi.mock("@/inventory/AvailabilitySection", () => ({ AvailabilitySection: () => null }));
vi.mock("@/inventory/StatusMoveSection", () => ({ StatusMoveSection: () => null }));

import { AuditSearch } from "@/audit/AuditSearch";
import { CountStatusPanel } from "@/count-sessions/CountStatusPanel";
import { DeviceList } from "@/devices/DeviceList";
import { DeviceOverview } from "@/devices/DeviceOverview";
import { ReleaseLedger } from "@/devices/DownloadPosPanels";
import { setLocale } from "@/i18n/locale";
import { InventoryProduct } from "@/inventory/InventoryProduct";
import { InventoryStore } from "@/inventory/InventoryStore";
import { InventoryTransfers } from "@/inventory/transfers/InventoryTransfers";
import type { CountSession } from "@/lib/count-session-queries";
import type { DeviceDetail } from "@/lib/device-queries";
import { createQueryClient } from "@/lib/query";
import type { SaleItem } from "@/lib/sale-queries";
import { RecentSales } from "@/overview/RecentSales";
import { SmartInsight } from "@/overview/SmartInsight";
import { DailyReport } from "@/sales-daily/DailyTables";
import { buildCsv } from "@/sales-daily/csvExport";
import { reportModel } from "@/sales-daily/dailyLogic";
import { SaleDetail } from "@/sales/SaleDetail";
import { SaleFilterBar } from "@/sales/SaleFilterBar";
import { StatusChips } from "@/sales/SaleParts";
import { SalesInsight } from "@/sales/SalesInsight";
import { emptyFilters } from "@/sales/saleFilters";
import { StockDiscrepancyStore } from "@/stock-discrepancies/StockDiscrepancyStore";
import { StockDiscrepancyStores } from "@/stock-discrepancies/StockDiscrepancyStores";
import { detail as deviceDetail, summary as deviceSummary } from "./device-fixtures";
import { detail as saleDetailFixture, item as saleItemFixture } from "./sale-fixtures";
import { EGP_USD_DAY, storeSummary } from "./sales-daily-fixtures";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
const TRANSFER_ID = "44444444-4444-4444-8444-444444444444";

function ctx(role: string) {
  return {
    context: {
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: { id: STORE_ID, name: "Cairo Festival City" },
      active_role_code: role,
      memberships: [{ tenant_id: "t1", store_access_kind: "all" }],
    },
  };
}

function wrap(ui: React.ReactNode, initialEntries: string[] = ["/"]) {
  const qc = createQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  useStoreList.mockReturnValue({
    isLoading: false,
    result: {
      kind: "rows",
      rows: [
        { id: STORE_ID, name: "Cairo Festival City", timezone: "Africa/Cairo" },
        { id: STORE_B, name: "Maadi", timezone: "Africa/Cairo" },
      ],
    },
  });
  useLowStock.mockReturnValue({ status: "ready", data: { criticalCount: 3 } });
});

afterEach(cleanup);

describe("D10 visibility gate — Home (SmartInsight & RecentSales)", () => {
  const summaryState = {
    status: "ready" as const,
    data: storeSummary(
      { ref: STORE_ID, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-15" },
      { from: "2026-10-15", to: "2026-10-15" },
      {
        "2026-10-15": {
          ...EGP_USD_DAY,
          syncStatus: { captured: 0, synced: 10, failedRetryable: 0, failedNeedsRepair: 2 },
          erpPosting: { posted: 8, pending: 0, failed: 3, unknown: 0 },
        },
      },
    ),
  };

  test("SmartInsight shows failed posting for owner, but skips to critical low stock for store_manager", () => {
    wrap(
      <SmartInsight
        session={{ tenantId: "t1", activeStoreId: STORE_ID, role: "owner" }}
        summary={summaryState}
      />,
    );
    expect(screen.getByText(/failed to post to ERPNext/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /repair/i })).toBeDefined();

    cleanup();
    wrap(
      <SmartInsight
        session={{ tenantId: "t1", activeStoreId: STORE_ID, role: "store_manager" }}
        summary={summaryState}
      />,
    );
    expect(screen.queryByText(/ERPNext|repair/i)).toBeNull();
    expect(screen.getByText(/critically low/i)).toBeDefined();
  });

  test("SmartInsight renders nothing for store_manager when no business item needs attention", () => {
    useLowStock.mockReturnValue({ status: "ready", data: { criticalCount: 0 } });
    const { container } = wrap(
      <SmartInsight
        session={{ tenantId: "t1", activeStoreId: STORE_ID, role: "store_manager" }}
        summary={summaryState}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("RecentSales hides ERPNext column when showErp=false and renders it when showErp=true", () => {
    const state = {
      status: "ready" as const,
      data: { sales: [saleItemFixture() as unknown as SaleItem], timeZone: "Africa/Cairo" },
    };
    wrap(<RecentSales state={state} showErp />);
    expect(screen.getByRole("columnheader", { name: "ERPNext" })).toBeDefined();

    cleanup();
    wrap(<RecentSales state={state} showErp={false} />);
    expect(screen.queryByRole("columnheader", { name: "ERPNext" })).toBeNull();
    expect(screen.getByText("R-0042")).toBeDefined();
  });
});

describe("D10 visibility gate — Sales (chips, filters, insight, detail)", () => {
  test("StatusChips keeps void and return chips while hiding sync and ERP chips when showSystem=false", () => {
    const sale = saleItemFixture({
      syncStatus: "synced",
      erpPostingState: "posted",
      voided: true,
      returnState: "partial",
    }) as unknown as SaleItem;
    wrap(<StatusChips sale={sale} showSystem />);
    expect(screen.getByText("Synced")).toBeDefined();
    expect(screen.getByText("Posted to ERPNext")).toBeDefined();
    expect(screen.getByText("Voided")).toBeDefined();
    expect(screen.getByText(/partial.*return|returned/i)).toBeDefined();

    cleanup();
    wrap(<StatusChips sale={sale} showSystem={false} />);
    expect(screen.queryByText("Synced")).toBeNull();
    expect(screen.queryByText("Posted to ERPNext")).toBeNull();
    expect(screen.getByText("Voided")).toBeDefined();
    expect(screen.getByText(/partial.*return|returned/i)).toBeDefined();
  });

  test("SaleFilterBar hides sync status and ERPNext filters when showSystem=false", () => {
    const stores = [{ id: STORE_ID, name: "Cairo Festival City", timezone: "Africa/Cairo" }];
    wrap(
      <SaleFilterBar
        applied={emptyFilters()}
        stores={stores}
        activeStoreId={STORE_ID}
        initialErrors={{}}
        showSystem
        onApply={() => {}}
        onClear={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));
    expect(screen.getByLabelText(/sync status/i)).toBeDefined();
    expect(screen.getByLabelText(/erpnext/i)).toBeDefined();

    cleanup();
    wrap(
      <SaleFilterBar
        applied={emptyFilters()}
        stores={stores}
        activeStoreId={STORE_ID}
        initialErrors={{}}
        showSystem={false}
        onApply={() => {}}
        onClear={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));
    expect(screen.queryByLabelText(/sync status/i)).toBeNull();
    expect(screen.queryByLabelText(/erpnext/i)).toBeNull();
    expect(screen.getByLabelText(/^void$/i)).toBeDefined();
    expect(screen.getByLabelText(/returns/i)).toBeDefined();
  });

  test("SalesInsight renders for owner and is hidden for store_manager", () => {
    const list = {
      rows: [saleItemFixture({ erpPostingState: "failed" }) as unknown as SaleItem],
      isLoading: false,
      ended: true,
      hasPages: true,
      hasMore: false,
      isFetchingNextPage: false,
      loadMore: () => {},
      retry: () => {},
      restart: () => {},
    };
    const ownerRole: string = "owner";
    const managerRole: string = "store_manager";
    wrap(<SalesInsight list={list} role={ownerRole} />);
    expect(screen.getByText(/failed to post to ERPNext/i)).toBeDefined();

    cleanup();
    const { container } = wrap(<SalesInsight list={list} role={managerRole} />);
    expect(container.textContent).toBe("");
  });

  test("SaleDetail hides ERPNext section, failure banner, and receivedAt for store_manager, shows for owner", async () => {
    consoleGetSale.mockResolvedValue({
      status: 200,
      data: saleDetailFixture({
        erpPosting: {
          sale: "failed",
          saleDocumentRef: null,
          reversal: null,
          reversalDocumentRef: null,
        },
      }),
    });

    activeContext.mockReturnValue(ctx("owner"));
    wrap(
      <Routes>
        <Route path="/sales/:saleRef" element={<SaleDetail />} />
      </Routes>,
      ["/sales/11111111-1111-4111-8111-111111111111"],
    );
    expect(await screen.findByRole("heading", { name: "ERPNext posting" })).toBeDefined();
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("Received by the server")).toBeDefined();

    cleanup();
    activeContext.mockReturnValue(ctx("store_manager"));
    wrap(
      <Routes>
        <Route path="/sales/:saleRef" element={<SaleDetail />} />
      </Routes>,
      ["/sales/11111111-1111-4111-8111-111111111111"],
    );
    expect(await screen.findByRole("heading", { name: "Sale" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "ERPNext posting" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Received by the server")).toBeNull();
  });
});

describe("D10 visibility gate — Reports (/sales-daily)", () => {
  const model = reportModel(
    storeSummary(
      { ref: STORE_ID, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-15" },
      { from: "2026-10-15", to: "2026-10-15" },
      { "2026-10-15": EGP_USD_DAY },
    ),
  );

  test("DailyReport hides syncStatus and erpPosting for store_manager while keeping shift closes and sales", () => {
    wrap(
      <DailyReport model={model} storeName="Cairo" storeId={STORE_ID} readStores={1} showSystem />,
    );
    expect(screen.getAllByText("Sale sync status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ERP posting state").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Shift closes").length).toBeGreaterThan(0);

    cleanup();
    wrap(
      <DailyReport
        model={model}
        storeName="Cairo"
        storeId={STORE_ID}
        readStores={1}
        showSystem={false}
      />,
    );
    expect(screen.queryByText("Sale sync status")).toBeNull();
    expect(screen.queryByText("ERP posting state")).toBeNull();
    expect(screen.getAllByText("Shift closes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Received sales").length).toBeGreaterThan(0);

    const csv = buildCsv(model, { locale: "en", storeName: "Cairo", includeSystemDetail: false });
    expect(csv).not.toContain("sync_captured");
    expect(csv).not.toContain("erp_posted");
    expect(csv).toContain("shift_closes_count");
  });
});

describe("D10 visibility gate — Inventory, Transfers, Count Sessions", () => {
  test("InventoryStore hides ERPNext column and ERPNext-book note for store_manager, shows for owner", async () => {
    listStockLocations.mockResolvedValue({
      status: 200,
      data: {
        items: [{ id: "loc-1", name: "Floor", code: "FLR", kind: "primary", isActive: true }],
      },
    });
    listStoreMovements.mockResolvedValue({
      status: 200,
      data: {
        items: [
          {
            id: "m1",
            occurredAt: "2026-10-15T10:00:00Z",
            movementType: "sale",
            tenantProductId: PRODUCT_ID,
            quantity: "-1",
            stockingUnit: "PCS",
            stockLocationId: "loc-1",
            inventoryStatus: "sellable",
            reason: null,
            integrationState: "posted",
          },
        ],
        nextCursor: null,
      },
    });

    activeContext.mockReturnValue(ctx("owner"));
    wrap(
      <Routes>
        <Route path="/inventory/stores/:storeId" element={<InventoryStore />} />
      </Routes>,
      [`/inventory/stores/${STORE_ID}`],
    );
    fireEvent.click(await screen.findByRole("button", { name: /show more details/i }));
    expect(screen.getByRole("columnheader", { name: /erpnext/i })).toBeDefined();
    expect(screen.getByText(/ERPNext book stock/i)).toBeDefined();

    cleanup();
    activeContext.mockReturnValue(ctx("store_manager"));
    wrap(
      <Routes>
        <Route path="/inventory/stores/:storeId" element={<InventoryStore />} />
      </Routes>,
      [`/inventory/stores/${STORE_ID}`],
    );
    fireEvent.click(await screen.findByRole("button", { name: /show more details/i }));
    expect(screen.queryByRole("columnheader", { name: /erpnext/i })).toBeNull();
    expect(screen.queryByText(/ERPNext book stock/i)).toBeNull();
  });

  test("InventoryProduct hides ERPNext book snapshot row for store_manager, shows for owner", async () => {
    getOnHand.mockResolvedValue({
      status: 200,
      data: {
        quantity: "12",
        sellableQuantity: "12",
        stockingUnit: "PCS",
        negativeBalance: false,
        statusQuantities: [{ inventoryStatus: "sellable", quantity: "12" }],
      },
    });
    listTrackingIdentities.mockResolvedValue({
      status: 200,
      data: { items: [], nextCursor: null },
    });

    activeContext.mockReturnValue(ctx("owner"));
    wrap(
      <Routes>
        <Route
          path="/inventory/stores/:storeId/products/:productId"
          element={<InventoryProduct />}
        />
      </Routes>,
      [`/inventory/stores/${STORE_ID}/products/${PRODUCT_ID}`],
    );
    expect(await screen.findByTestId("on-hand-erp-book")).toBeDefined();

    cleanup();
    activeContext.mockReturnValue(ctx("store_manager"));
    wrap(
      <Routes>
        <Route
          path="/inventory/stores/:storeId/products/:productId"
          element={<InventoryProduct />}
        />
      </Routes>,
      [`/inventory/stores/${STORE_ID}/products/${PRODUCT_ID}`],
    );
    expect(await screen.findByTestId("on-hand-quantity")).toBeDefined();
    expect(screen.queryByTestId("on-hand-erp-book")).toBeNull();
  });

  test("InventoryTransfers hides ERPNext posting columns in list and drawer for store_manager", async () => {
    const transfer = {
      id: TRANSFER_ID,
      sourceStoreId: STORE_ID,
      destinationStoreId: STORE_B,
      state: "dispatched",
      createdAt: "2026-10-15T09:00:00Z",
      receiptCount: 1,
      dispatchIntegrationState: "posted",
      lines: [
        {
          id: "l1",
          lineSeq: 1,
          tenantProductRef: PRODUCT_ID,
          trackingIdentityId: null,
          stockingUnit: "PCS",
          quantity: "5",
          dispatchedQuantity: "5",
          receivedQuantity: "2",
          shortClosedQuantity: "0",
          inTransitQuantity: "3",
        },
      ],
    };
    listShipmentTransfers.mockResolvedValue({
      status: 200,
      data: { items: [transfer], nextCursor: null },
    });
    getShipmentTransfer.mockResolvedValue({ status: 200, data: transfer });
    listShipmentTransferReceipts.mockResolvedValue({
      status: 200,
      data: {
        items: [
          {
            id: "r1",
            receivedAt: "2026-10-15T11:00:00Z",
            integrationState: "pending",
            note: null,
            lines: [{ lineId: "l1", quantity: "2", inventoryStatus: "sellable" }],
          },
        ],
        nextCursor: null,
      },
    });

    activeContext.mockReturnValue(ctx("store_manager"));
    wrap(<InventoryTransfers />, ["/inventory/transfers"]);
    const openBtn = await screen.findByRole("button", { name: /open transfer/i });
    expect(screen.queryByRole("columnheader", { name: /erpnext/i })).toBeNull();
    fireEvent.click(openBtn);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Receipts")).toBeDefined();
    expect(within(dialog).queryByText(/erpnext/i)).toBeNull();
  });

  test("CountStatusPanel hides ERPNext status banner when showSystem=false and shows when showSystem=true", () => {
    const session = {
      id: "c1",
      storeId: STORE_ID,
      state: "needs_attention",
      openedAt: "2026-10-15T08:00:00Z",
      openedBy: "u1",
      scope: { productIds: [PRODUCT_ID] },
      lateEventFindingCount: 0,
    } as unknown as CountSession;

    wrap(<CountStatusPanel session={session} index={1} showSystem />);
    expect(screen.getByTestId("count-erp-status")).toBeDefined();

    cleanup();
    wrap(<CountStatusPanel session={session} index={1} showSystem={false} />);
    expect(screen.queryByTestId("count-erp-status")).toBeNull();
  });
});

describe("D10 visibility gate — Direct route access (/audit & /stock-discrepancies)", () => {
  test("store_manager gets identical shared no-access state naming who can open, with zero fetches", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));

    wrap(<AuditSearch />, ["/audit"]);
    const auditHeading = screen.getByRole("heading", { level: 1 }).textContent;
    const auditBody = screen.getByText(/owner or an organization administrator/i).textContent;
    expect(listAuditEvents).not.toHaveBeenCalled();

    cleanup();
    wrap(<StockDiscrepancyStores />, ["/stock-discrepancies"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(auditHeading);
    expect(screen.getByText(/owner or an organization administrator/i).textContent).toBe(auditBody);
    expect(listErpnextNegativeOnHandStores).not.toHaveBeenCalled();

    cleanup();
    wrap(
      <Routes>
        <Route path="/stock-discrepancies/:storeId" element={<StockDiscrepancyStore />} />
      </Routes>,
      [`/stock-discrepancies/${STORE_ID}`],
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(auditHeading);
    expect(listErpnextNegativeOnHand).not.toHaveBeenCalled();
  });
});

describe("D10a visibility gate — Devices", () => {
  test("DeviceList keeps till management for store_manager but hides device ids, sale queue column, and health fetch", async () => {
    const row = deviceSummary({ deviceId: STORE_ID, label: "Till 1", storeId: STORE_ID });
    consoleListDevices.mockResolvedValue({ status: 200, data: { items: [row], nextCursor: null } });
    consoleListDeviceHealth.mockResolvedValue({
      status: 200,
      data: { items: [], nextCursor: null },
    });

    activeContext.mockReturnValue(ctx("store_manager"));
    wrap(<DeviceList />, ["/devices"]);
    expect(await screen.findByText("Till 1")).toBeDefined();
    // Management actions kept:
    expect(screen.getByRole("link", { name: "Pairing codes" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Download POS" })).toBeDefined();
    // Technical fields hidden + health query skipped:
    expect(screen.queryByText(STORE_ID)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /unsent sales/i })).toBeNull();
    expect(consoleListDeviceHealth).not.toHaveBeenCalled();

    cleanup();
    activeContext.mockReturnValue(ctx("owner"));
    wrap(<DeviceList />, ["/devices"]);
    expect(await screen.findByText("Till 1")).toBeDefined();
    expect(screen.getByText(STORE_ID)).toBeDefined();
    expect(screen.getByRole("columnheader", { name: /unsent sales/i })).toBeDefined();
    expect(consoleListDeviceHealth).toHaveBeenCalled();
  });

  test("DeviceOverview hides deviceId and SaleQueuePanel (and skips health fetch) for store_manager", () => {
    const dev = deviceDetail({
      deviceId: STORE_ID,
      label: "Till 1",
      storeId: STORE_ID,
    }) as unknown as DeviceDetail;
    consoleGetDeviceHealth.mockResolvedValue({ status: 200, data: {} });

    activeContext.mockReturnValue(ctx("store_manager"));
    wrap(<DeviceOverview device={dev} storeName="Cairo Festival City" now={Date.now()} />);
    expect(screen.getByText("Till 1")).toBeDefined();
    expect(screen.queryByText(STORE_ID)).toBeNull();
    expect(screen.queryByText(/unsent sales/i)).toBeNull();
    expect(consoleGetDeviceHealth).not.toHaveBeenCalled();

    cleanup();
    activeContext.mockReturnValue(ctx("owner"));
    wrap(<DeviceOverview device={dev} storeName="Cairo Festival City" now={Date.now()} />);
    expect(screen.getByText(STORE_ID)).toBeDefined();
    expect(consoleGetDeviceHealth).toHaveBeenCalled();
  });

  test("ReleaseLedger hides app build/version identifier when showVersion=false", () => {
    const facts = {
      version: "1.4.2-pilot.9",
      fileName: "POS-Pulse-Setup.exe",
      sizeBytes: 1024 * 1024 * 50,
      sha256: "a".repeat(64),
      expectedPublisher: "Retail Tower",
    };
    wrap(<ReleaseLedger facts={facts} showVersion />);
    expect(screen.getByText("1.4.2-pilot.9")).toBeDefined();

    cleanup();
    wrap(<ReleaseLedger facts={facts} showVersion={false} />);
    expect(screen.queryByText("1.4.2-pilot.9")).toBeNull();
    expect(screen.getByText("POS-Pulse-Setup.exe")).toBeDefined();
  });
});
