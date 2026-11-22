import * as queries from "@/lib/inventory-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-728 / RT-436 / RT-1515 boundary. The inventory views use the four READ
 * operations of the generated inventory client, the three shipment-Transfer
 * READS (RT-1515 PR 1: list, one Transfer, its receipts) and the writes
 * `createStatusMove` (RT-435) and, from RT-1515 PR 2, exactly four
 * shipment-Transfer writes (create a Draft, approve, cancel, dispatch), through
 * their wrappers, each with the Idempotency-Key header. Receive and close are a
 * later PR, the Transfers setting is not a Console write, and the legacy instant
 * transfer stays forbidden. No other write (createStockMovement /
 * createStockTransfer / recordStockCount / relocation / holds / recalls /
 * backfill), no ERPNext call, no hand-rolled fetch, no Authorization header,
 * no free-text product entry. Static scan, comments stripped.
 */
const wrapperSrc = readSource("src/lib/inventory-queries.ts");
const feature = sourcesUnder("src/inventory");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

/** The only feature files that may hold the write (mutation) and form inputs. */
const WRITE_FILES = [
  "useStatusMove.ts",
  "StatusMoveSection.tsx",
  // RT-1515 PR 2: the shipment-Transfer write hooks and forms.
  "useTransferWrites.ts",
  "TransferCreate.tsx",
  "TransferCreateLines.tsx",
  "TransferActions.tsx",
];
const isWriteFile = (file: string) => WRITE_FILES.some((name) => file.endsWith(`/${name}`));

describe("inventory boundary (RT-728, RT-436, RT-1515)", () => {
  test("exactly the seven read wrappers, the status-move write and the four Transfer writes are exported", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "approveShipmentTransfer",
      "cancelShipmentTransfer",
      "createShipmentTransfer",
      "createStatusMove",
      "dispatchShipmentTransfer",
      "getOnHand",
      "getShipmentTransfer",
      "listShipmentTransferReceipts",
      "listShipmentTransfers",
      "listStockLocations",
      "listStoreMovements",
      "listTrackingIdentities",
    ]);
  });

  test("the wrappers GET the read paths and POST only the status-move and the four Transfer paths", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\.(\w+)\("([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths.sort()).toEqual([
      "GET /api/inventory/v1/on-hand/{storeId}/{productId}",
      "GET /api/inventory/v1/products/{productId}/tracking-identities",
      "GET /api/inventory/v1/shipment-transfers",
      "GET /api/inventory/v1/shipment-transfers/{transferId}",
      "GET /api/inventory/v1/shipment-transfers/{transferId}/receipts",
      "GET /api/inventory/v1/stores/{storeId}/locations",
      "GET /api/inventory/v1/stores/{storeId}/movements",
      "POST /api/inventory/v1/shipment-transfers",
      "POST /api/inventory/v1/shipment-transfers/{transferId}/approve",
      "POST /api/inventory/v1/shipment-transfers/{transferId}/cancel",
      "POST /api/inventory/v1/shipment-transfers/{transferId}/dispatch",
      "POST /api/inventory/v1/stores/{storeId}/status-moves",
    ]);
  });

  test("no receive, close or setting write and no legacy instant transfer (RT-1515 PR 3 is later)", () => {
    for (const src of all) {
      expect(src).not.toMatch(
        /recordShipmentTransferReceipt|closeShipmentTransfer|ShipmentTransfersSetting/,
      );
      expect(src).not.toMatch(/createStockTransfer/);
      expect(src).not.toMatch(/apiClient\.\w+\("\/api\/inventory\/v1\/transfers"/);
      expect(src).not.toMatch(/\/api\/inventory\/v1\/transfers(?![\w-])/);
      expect(src).not.toMatch(/\/shipment-transfers\/\{transferId\}\/close"/);
    }
    // Only POSTs on the Transfer paths, and only the four approved ones.
    expect(wrapperSrc).not.toMatch(
      /apiClient\.(PUT|PATCH|DELETE)\("\/api\/inventory\/v1\/(shipment-transfers|transfers|settings)/,
    );
    expect(wrapperSrc).not.toMatch(/apiClient\.POST\("\/api\/inventory\/v1\/(transfers|settings)/);
    expect(wrapperSrc).not.toMatch(
      /apiClient\.POST\("\/api\/inventory\/v1\/shipment-transfers\/\{transferId\}\/(receipts|close)"/,
    );
  });

  test("every Transfer write wrapper sends the Idempotency-Key header", () => {
    for (const name of [
      "createShipmentTransfer",
      "approveShipmentTransfer",
      "cancelShipmentTransfer",
      "dispatchShipmentTransfer",
    ]) {
      const body = wrapperSrc.slice(wrapperSrc.indexOf(`export async function ${name}(`));
      const call = body.slice(0, body.indexOf("\n}\n"));
      expect(call, name).toMatch(/header: \{ "Idempotency-Key": idempotencyKey \}/);
    }
  });

  test("the store ledger is the whole store (scope=all), never by product", () => {
    expect(wrapperSrc).toContain('scope: "all"');
    expect(wrapperSrc).not.toMatch(/productId[^}]*scope|scope[^}]*productId/);
  });

  test("the feature goes through the wrappers; only the status-move files write", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toContain("@/generated/client");
      expect(src, file).not.toMatch(
        /createStockMovement|createStockTransfer|recordStockCount|createRelocation|placeQualityHold|releaseTrackingHold|createInventoryRecall|backfillSaleLinkedMovements|setReturnLandingPolicy|correctTrackingIdentityExpiry/,
      );
      if (!isWriteFile(file)) expect(src, file).not.toMatch(/useMutation|Idempotency-Key/);
    }
  });

  test("the status move sends no tenant, store or actor in its body", () => {
    const logic = readSource("src/inventory/statusMoveLogic.ts");
    expect(logic).not.toMatch(/tenantId|storeId|actor|createdBy/);
  });

  test("no free-text product entry: only the status-move form renders inputs", () => {
    for (const { file, src } of feature) {
      if (!isWriteFile(file)) expect(src, file).not.toMatch(/<input|<textarea/);
    }
    const form = readSource("src/inventory/StatusMoveSection.tsx");
    expect(form).not.toMatch(/name="(productId|tenantProductRef)"|id="move-product/);
  });

  test("no ERP system, hand-rolled fetch or Authorization header", () => {
    for (const src of all) {
      expect(src).not.toMatch(/frappe|\/api\/resource|\/api\/method/i);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/[Aa]uthorization\s*:/);
    }
  });

  test("ERP Book is never read from the negative-on-hand or reconciliation surfaces here", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(
        /listErpnextNegativeOnHand|listReconciliationResults|getReconciliationRun|stock-discrepancy-queries/,
      );
    }
  });
});
