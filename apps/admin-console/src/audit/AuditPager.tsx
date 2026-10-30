/**
 * SF-6-1 pager (T021, OQ-4). A single primary "Load more" driven by `next_cursor`
 * (hidden when there is no next page). No page numbers, no auto-fetch-until-
 * exhausted. A muted count line shows how many rows are loaded (a noun-first
 * counter in Arabic, UX-12; no total, the contract gives none).
 */
import { BusyButton } from "@/components/BusyButton";
import { useT } from "@/i18n";
import "./audit.css";

export interface AuditPagerProps {
  loadedCount: number;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function AuditPager({
  loadedCount,
  hasMore,
  isFetchingNextPage,
  onLoadMore,
}: Readonly<AuditPagerProps>): React.JSX.Element {
  const t = useT();
  return (
    <div className="audit-pager">
      <span className="audit-pager__count">{t("audit.pager.loaded", { count: loadedCount })}</span>
      {hasMore ? (
        <BusyButton
          type="button"
          className="btn-secondary"
          onClick={onLoadMore}
          busy={isFetchingNextPage}
        >
          {t("audit.pager.loadMore")}
        </BusyButton>
      ) : null}
    </div>
  );
}
