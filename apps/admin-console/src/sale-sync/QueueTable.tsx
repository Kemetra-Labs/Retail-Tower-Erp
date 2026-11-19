/**
 * The table frame of a keyset-paged read-only queue (RT-726 sales needing repair, RT-1312 sale
 * quarantine): the loading skeleton, the first-page error, the empty state, the table with its
 * caption and column heads, the inline error of a failed later page, and a deliberate Load more.
 * The caller supplies the columns, the row and the copy.
 */
import { BusyButton } from "@/components/BusyButton";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { DataTableSkeleton } from "@/components/DataTableSkeleton";
import { DateTime, type MessageKey, useT } from "@/i18n";
import { Fragment } from "react";
import { ReadError, StaleError } from "./parts";
import type { PagedState } from "./useSaleSync";

export interface QueueTableProps<Item> {
  list: PagedState<Item>;
  columns: readonly { key: string; header: string }[];
  caption: string;
  /** The noun the loading skeleton announces. */
  loadingNoun: string;
  failedKey: MessageKey;
  notFoundKey: MessageKey;
  loadMoreKey: MessageKey;
  /** The empty state: the list holds nothing and has no further page. */
  empty: React.ReactNode;
  rowKey: (item: Item) => string;
  renderRow: (item: Item) => React.ReactNode;
}

export function QueueTable<Item>({
  list,
  columns,
  caption,
  loadingNoun,
  failedKey,
  notFoundKey,
  loadMoreKey,
  empty,
  rowKey,
  renderRow,
}: Readonly<QueueTableProps<Item>>): React.JSX.Element {
  const t = useT();
  if (list.isLoading) {
    return <DataTableSkeleton caption={caption} columns={columns} label={loadingNoun} />;
  }
  if (list.error) {
    return (
      <ReadError
        error={list.error}
        failedKey={failedKey}
        notFoundKey={notFoundKey}
        onRetry={list.retry}
      />
    );
  }
  if (list.rows.length === 0 && !list.hasMore) return <>{empty}</>;
  return (
    <>
      <TableScrollRegion>
        {(captionId) => (
          <table className="data-table data-table--strips">
            <caption id={captionId} className="data-table__caption">
              {caption}
            </caption>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key} scope="col">
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.rows.map((item) => (
                <Fragment key={rowKey(item)}>{renderRow(item)}</Fragment>
              ))}
            </tbody>
          </table>
        )}
      </TableScrollRegion>
      {/* A failed continuation keeps the rows above and retries at the boundary. */}
      <StaleError error={list.inlineError} onRetry={list.retry} />
      {list.hasMore ? (
        <div>
          <BusyButton
            type="button"
            className="btn-secondary"
            onClick={list.loadMore}
            busy={list.isFetchingNextPage}
          >
            {t(loadMoreKey)}
          </BusyButton>
        </div>
      ) : null}
    </>
  );
}

/** "Last read: <time>" under a queue, once rows are on screen. */
export function QueueAsOf({
  asOf,
  messageKey,
}: Readonly<{ asOf: number | undefined; messageKey: MessageKey }>): React.JSX.Element | null {
  const t = useT();
  if (!asOf) return null;
  return (
    <p className="sale-sync__asof">
      {t.rich(messageKey, { time: <DateTime value={new Date(asOf).toISOString()} /> })}
    </p>
  );
}
