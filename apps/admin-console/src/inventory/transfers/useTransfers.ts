/**
 * RT-1515 (PR 1) query hooks for the read-only shipment-Transfer views: the
 * tenant's Transfers (newest first, keyset paged, by the contract's filters),
 * one Transfer, and its receipts (oldest first, keyset paged). Reads only.
 *
 * They reuse the inventory read plumbing (typed errors carrying `error.code`,
 * no self-retry, a failed continuation keeps the loaded rows). Keys carry the
 * active tenant and store and every filter, so a scope or filter change starts
 * a fresh list and never stitches rows from two snapshots (UX-10.19).
 */
import {
  type ShipmentTransfer,
  type ShipmentTransferFilter,
  type ShipmentTransferList,
  type ShipmentTransferReceipt,
  type ShipmentTransferReceiptList,
  getShipmentTransfer,
  listShipmentTransferReceipts,
  listShipmentTransfers,
} from "@/lib/inventory-queries";
import {
  type InventoryScope,
  type PagedState,
  type ReadState,
  useInventoryPages,
  useInventoryRead,
} from "../useInventory";

const base = (scope: InventoryScope) => ["transfers", scope.tenantId, scope.activeStoreId] as const;

export function useShipmentTransfers(
  scope: InventoryScope,
  filter: ShipmentTransferFilter,
): PagedState<ShipmentTransfer> {
  return useInventoryPages<ShipmentTransfer, ShipmentTransferList>({
    queryKey: [
      ...base(scope),
      "list",
      filter.storeId ?? "",
      filter.direction ?? "",
      filter.state ?? "",
    ],
    scope,
    fetchPage: (query) => listShipmentTransfers(filter, query),
  });
}

export function useShipmentTransfer(
  scope: InventoryScope,
  transferId: string,
): ReadState<ShipmentTransfer> {
  return useInventoryRead({
    queryKey: [...base(scope), "transfer", transferId],
    scope,
    load: () => getShipmentTransfer(transferId),
  });
}

export function useShipmentTransferReceipts(
  scope: InventoryScope,
  transferId: string,
): PagedState<ShipmentTransferReceipt> {
  return useInventoryPages<ShipmentTransferReceipt, ShipmentTransferReceiptList>({
    queryKey: [...base(scope), "receipts", transferId],
    scope,
    fetchPage: (query) => listShipmentTransferReceipts(transferId, query),
  });
}
