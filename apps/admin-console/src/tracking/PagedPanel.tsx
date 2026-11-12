/**
 * RT-455 part 2: the body every keyset-paged tracking tab shares: loading, a
 * first-page failure, the empty list, then the rows with a stale-page notice and
 * Load more. A paged list never shows a total (UX-10.17); an unknown list is
 * never an empty one.
 */
import { ListState } from "@/components/ListState";
import type { MessageKey } from "@/i18n";
import { useT } from "@/i18n";
import { LoadMore, ReadError, StaleError } from "../inventory/parts";
import type { PagedState } from "../inventory/useInventory";

function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body inventory__panel-body--solo">{children}</div>;
}

export function PagedPanel<T>({
  list,
  loadingKey,
  failedKey,
  emptyKey,
  moreKey,
  children,
}: Readonly<{
  list: PagedState<T>;
  loadingKey: MessageKey;
  failedKey: MessageKey;
  emptyKey: MessageKey;
  moreKey: MessageKey;
  children: (rows: readonly T[]) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  if (list.isLoading) {
    return (
      <Body>
        <ListState state="loading" label={t(loadingKey)} />
      </Body>
    );
  }
  if (list.error) {
    return (
      <Body>
        <ReadError
          error={list.error}
          failedKey={failedKey}
          notFoundKey={failedKey}
          onRetry={list.retry}
        />
      </Body>
    );
  }
  if (list.rows.length === 0 && !list.hasMore) {
    return (
      <Body>
        <ListState state="empty" emptyMessage={t(emptyKey)} />
      </Body>
    );
  }
  return (
    <>
      {children(list.rows)}
      {list.inlineError ? (
        <Body>
          <StaleError error={list.inlineError} onRetry={list.retry} />
        </Body>
      ) : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={t(moreKey)}
        onLoadMore={list.loadMore}
      />
    </>
  );
}
