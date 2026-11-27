import { Banner } from "@/components/Banner";
/**
 * RT-1515 (PR 1) — one shipment Transfer, read only, in a drawer over the list
 * (UX-10.31): its route (source to destination store), state, the lifecycle
 * timestamps it actually carries, its lines, its receipts and the ERP posting
 * state of each leg (the dispatch, and each receipt) as data.
 *
 * Line quantities are the API's exact strings, each labelled: Ordered,
 * Dispatched, Received, Short-closed and In transit (a quantity of the line,
 * never a location or a status). No plain "Stock", and no Available-to-Sell
 * figure: none exists yet (owner decision on RT-1515). The Transfer is read
 * fresh (`getShipmentTransfer`); receipts are paged oldest first
 * (`listShipmentTransferReceipts`) and a failed continuation keeps them.
 *
 * RT-1515 (PR 2, PR 3): a Transfer also carries its write actions (approve,
 * dispatch, cancel, receive, close, short-close) for the roles the API accepts
 * and in the states that allow them. A recorded action says so, above the actions, and the
 * Transfer is read again (never edited locally). The drawer cannot be closed
 * while a write awaits its answer, so the answer is not lost.
 */
import { Drawer } from "@/components/Drawer";
import { ListState } from "@/components/ListState";
import { canSeeSystemDetail } from "@/context/effectiveRole";
import { DateTime, useT } from "@/i18n";
import type { ShipmentTransfer, ShipmentTransferReceipt } from "@/lib/inventory-queries";
import { useState } from "react";
import { inventoryStatusKey } from "../inventoryLogic";
import { LoadMore, Machine, Quantity, StaleError } from "../parts";
import type { InventoryScope, PagedState } from "../useInventory";
import { TransferActions } from "./TransferActions";
import { CaptionedTable, LegBadge, StateBadge, StoreName, TransferError } from "./TransferParts";
import { type ReceiptRow, receiptRowsOf, timelineOf } from "./transferLogic";
import type { TransferAction } from "./transferWriteLogic";
import { type TransferActionWrites, useTransferActionWrites } from "./useTransferWrites";
import { useShipmentTransfer, useShipmentTransferReceipts } from "./useTransfers";

type StoreNames = ReadonlyMap<string, string>;

function Summary({
  transfer,
  names,
  showSystem,
}: Readonly<{
  transfer: ShipmentTransfer;
  names: StoreNames;
  showSystem: boolean;
}>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="transfers__ledger">
      <div>
        <dt>{t("transfers.detail.route")}</dt>
        <dd>
          {t.rich("transfers.route", {
            source: <StoreName id={transfer.sourceStoreId} names={names} />,
            destination: <StoreName id={transfer.destinationStoreId} names={names} />,
          })}
        </dd>
      </div>
      <div>
        <dt>{t("transfers.detail.state")}</dt>
        <dd>
          <StateBadge state={transfer.state} />
        </dd>
      </div>
      {timelineOf(transfer).map((entry) => (
        <div key={entry.key}>
          <dt>{t(entry.key)}</dt>
          <dd>
            <DateTime value={entry.at} />
          </dd>
        </div>
      ))}
      {showSystem ? (
        <div>
          <dt>{t("transfers.detail.dispatchErp")}</dt>
          <dd>
            <LegBadge state={transfer.dispatchIntegrationState} />
          </dd>
        </div>
      ) : null}
      {transfer.reason ? (
        <div>
          <dt>{t("transfers.detail.reason")}</dt>
          <dd>
            <bdi dir="auto">{transfer.reason}</bdi>
          </dd>
        </div>
      ) : null}
      {transfer.shortClose ? (
        <div>
          <dt>{t("transfers.detail.shortCloseReason")}</dt>
          <dd>
            <bdi dir="auto">{transfer.shortClose.reason}</bdi>
          </dd>
        </div>
      ) : null}
      {transfer.cancellation ? (
        <div>
          <dt>{t("transfers.detail.cancelReason")}</dt>
          <dd>
            <bdi dir="auto">{transfer.cancellation.reason}</bdi>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>{t("transfers.detail.id")}</dt>
        <dd>
          <Machine value={transfer.id} />
        </dd>
      </div>
    </dl>
  );
}

const QUANTITY_COLUMNS = [
  ["quantity", "transfers.lines.col.ordered"],
  ["dispatchedQuantity", "transfers.lines.col.dispatched"],
  ["receivedQuantity", "transfers.lines.col.received"],
  ["shortClosedQuantity", "transfers.lines.col.shortClosed"],
  ["inTransitQuantity", "transfers.lines.col.inTransit"],
] as const;

function LinesTable({ transfer }: Readonly<{ transfer: ShipmentTransfer }>): React.JSX.Element {
  const t = useT();
  return (
    <CaptionedTable caption={t("transfers.lines.caption")}>
      <thead>
        <tr>
          <th scope="col" className="num">
            {t("transfers.lines.col.seq")}
          </th>
          <th scope="col">{t("transfers.lines.col.product")}</th>
          <th scope="col">{t("transfers.lines.col.tracking")}</th>
          <th scope="col">{t("transfers.lines.col.unit")}</th>
          {QUANTITY_COLUMNS.map(([field, key]) => (
            <th key={field} scope="col" className="num">
              {t(key)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {transfer.lines.map((line) => (
          <tr key={line.id} className="data-table__row data-table__row--static">
            <th scope="row" className="num">
              <bdi dir="ltr">{line.lineSeq}</bdi>
            </th>
            <td>
              <Machine value={line.tenantProductRef} />
            </td>
            <td>
              {line.trackingIdentityId ? (
                <Machine value={line.trackingIdentityId} />
              ) : (
                <span className="muted">{t("transfers.value.none")}</span>
              )}
            </td>
            <td>
              <Machine value={line.stockingUnit} />
            </td>
            {QUANTITY_COLUMNS.map(([field]) => (
              <td key={field} className="num">
                <Quantity value={line[field]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </CaptionedTable>
  );
}

/** The receipt-level cells, on the first line of each receipt, spanning its lines. */
function ReceiptCells({
  receipt,
  showSystem,
}: Readonly<{ receipt: ShipmentTransferReceipt; showSystem: boolean }>) {
  const t = useT();
  const span = receipt.lines.length;
  return (
    <>
      <th scope="row" rowSpan={span}>
        <DateTime value={receipt.receivedAt} />
      </th>
      {showSystem ? (
        <td rowSpan={span}>
          <LegBadge state={receipt.integrationState} />
        </td>
      ) : null}
      <td rowSpan={span} className="inventory__wrap">
        {receipt.note ? (
          <bdi dir="auto">{receipt.note}</bdi>
        ) : (
          <span className="muted">{t("transfers.value.none")}</span>
        )}
      </td>
    </>
  );
}

function ReceiptRowView({
  row,
  showSystem,
}: Readonly<{ row: ReceiptRow; showSystem: boolean }>): React.JSX.Element {
  const t = useT();
  return (
    <tr className="data-table__row data-table__row--static">
      {row.index === 0 ? <ReceiptCells receipt={row.receipt} showSystem={showSystem} /> : null}
      <td className="num">
        {row.lineSeq === undefined ? (
          <span className="inventory__unknown">{t("transfers.value.unknown")}</span>
        ) : (
          <bdi dir="ltr">{row.lineSeq}</bdi>
        )}
      </td>
      <td className="num">
        <Quantity value={row.quantity} />
      </td>
      <td>{t(inventoryStatusKey(row.inventoryStatus))}</td>
    </tr>
  );
}

function ReceiptsTable({
  receipts,
  transfer,
  showSystem,
}: Readonly<{
  receipts: ShipmentTransferReceipt[];
  transfer: ShipmentTransfer;
  showSystem: boolean;
}>) {
  const t = useT();
  const rows = receiptRowsOf(receipts, transfer);
  return (
    <CaptionedTable caption={t("transfers.receipts.caption")} strips={false}>
      <thead>
        <tr>
          <th scope="col">{t("transfers.receipts.col.receivedAt")}</th>
          {showSystem ? <th scope="col">{t("transfers.receipts.col.erp")}</th> : null}
          <th scope="col">{t("transfers.receipts.col.note")}</th>
          <th scope="col" className="num">
            {t("transfers.receipts.col.line")}
          </th>
          <th scope="col" className="num">
            {t("transfers.receipts.col.quantity")}
          </th>
          <th scope="col">{t("transfers.receipts.col.status")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <ReceiptRowView
            key={`${row.receipt.id}-${row.index}`}
            row={row}
            showSystem={showSystem}
          />
        ))}
      </tbody>
    </CaptionedTable>
  );
}

function ReceiptsSection({
  receipts,
  transfer,
  showSystem,
}: Readonly<{
  receipts: PagedState<ShipmentTransferReceipt>;
  transfer: ShipmentTransfer;
  showSystem: boolean;
}>) {
  const t = useT();
  let body: React.JSX.Element;
  if (receipts.isLoading) {
    body = <ListState state="loading" label={t("transfers.receipts.loadingNoun")} />;
  } else if (receipts.error) {
    body = (
      <TransferError
        error={receipts.error}
        failedKey="transfers.receipts.loadFailed"
        onRetry={receipts.retry}
      />
    );
  } else if (receipts.rows.length === 0 && !receipts.hasMore) {
    body = <ListState state="empty" emptyMessage={t("transfers.receipts.empty")} />;
  } else {
    body = (
      <>
        <ReceiptsTable receipts={receipts.rows} transfer={transfer} showSystem={showSystem} />
        <StaleError error={receipts.inlineError} onRetry={receipts.retry} />
        <LoadMore
          hasMore={receipts.hasMore}
          isFetching={receipts.isFetchingNextPage}
          label={t("transfers.receipts.loadMore")}
          onLoadMore={receipts.loadMore}
        />
      </>
    );
  }
  return (
    <section className="transfers__section" aria-labelledby="transfer-receipts">
      <h3 id="transfer-receipts" className="transfers__heading">
        {t("transfers.receipts.title")}
      </h3>
      {body}
    </section>
  );
}

function Detail({
  scope,
  transfer,
  names,
  writes,
}: Readonly<{
  scope: InventoryScope;
  transfer: ShipmentTransfer;
  names: StoreNames;
  writes: TransferActionWrites;
}>) {
  const t = useT();
  const showSystem = canSeeSystemDetail(scope.role);
  const receipts = useShipmentTransferReceipts(scope, transfer.id);
  const [notice, setNotice] = useState<TransferAction | null>(null);
  return (
    <>
      {notice ? <Banner variant="success" message={t(`transfers.recorded.${notice}`)} /> : null}
      <Summary transfer={transfer} names={names} showSystem={showSystem} />
      <TransferActions scope={scope} transfer={transfer} writes={writes} onRecorded={setNotice} />
      <section className="transfers__section" aria-labelledby="transfer-lines">
        <h3 id="transfer-lines" className="transfers__heading">
          {t("transfers.lines.title")}
        </h3>
        <LinesTable transfer={transfer} />
      </section>
      <ReceiptsSection receipts={receipts} transfer={transfer} showSystem={showSystem} />
    </>
  );
}

export function TransferDrawer({
  scope,
  transferId,
  names,
  onClose,
}: Readonly<{
  scope: InventoryScope;
  transferId: string;
  names: StoreNames;
  onClose: () => void;
}>): React.JSX.Element {
  const t = useT();
  const read = useShipmentTransfer(scope, transferId);
  const writes = useTransferActionWrites(transferId);
  let body: React.JSX.Element;
  if (read.isLoading) {
    body = <ListState state="loading" label={t("transfers.detail.loadingNoun")} />;
  } else if (read.error || !read.data) {
    body = (
      <TransferError
        error={read.error ?? { kind: "generic" }}
        failedKey="transfers.detail.loadFailed"
        onRetry={read.retry}
      />
    );
  } else {
    body = (
      <>
        <StaleError error={read.inlineError} onRetry={read.retry} />
        <Detail scope={scope} transfer={read.data} names={names} writes={writes} />
      </>
    );
  }
  return (
    <Drawer
      title={t("transfers.detail.title")}
      onClose={onClose}
      id="transfer-detail"
      dismissible={!writes.pending}
    >
      <div className="transfers__drawer">{body}</div>
    </Drawer>
  );
}
