import { TableScrollRegion } from "@/components/DataTableScroll";
/**
 * RT-1425 — late pre-cut event findings (G6-4, decision 835): a POS sale or an
 * ERP-origin voucher stamped at or before the Count Cut that Backend-Core learned
 * after it. Before approval the server invalidates the affected lines and the
 * session returns to review; after approval this is a finding with its
 * availability and overselling-risk assessment and no automatic stock movement.
 * Nothing here resolves a finding: the contract has no resolution operation, so
 * no action is offered.
 */
import { DetailPanel } from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { DateTime, useT } from "@/i18n";
import { LoadMore, Machine, Quantity, ReadError, StaleError } from "@/inventory/parts";
import type { PagedState } from "@/inventory/useInventory";
import type { CountLateEventFinding } from "@/lib/count-session-queries";
import { ProductLabel, StateBadge } from "./CountParts";
import { assessmentKey } from "./countLogic";

function FindingsTable({
  rows,
  names,
}: Readonly<{ rows: CountLateEventFinding[]; names: ReadonlyMap<string, string> }>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {t("counts.late.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("counts.late.col.product")}</th>
              <th scope="col">{t("counts.late.col.assessment")}</th>
              <th scope="col" className="num">
                {t("counts.late.col.quantity")}
              </th>
              <th scope="col">{t("counts.late.col.risk")}</th>
              <th scope="col">{t("counts.late.col.event")}</th>
              <th scope="col">{t("counts.late.col.detected")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <ProductLabel id={f.productId} names={names} />
                </th>
                <td>{t(assessmentKey(f.assessment))}</td>
                <td className="num">
                  <Quantity value={f.quantity} />
                </td>
                <td>
                  <span className={f.oversellRisk ? "badge badge--danger" : "badge"}>
                    {t(f.oversellRisk ? "counts.late.oversell" : "counts.late.noOversell")}
                  </span>
                </td>
                <td>
                  <Machine value={f.linkedEvent.eventType} />{" "}
                  <Machine value={f.linkedEvent.reference} />
                  <div className="counts__note">
                    <Machine value={f.linkedEvent.sourceSystem} /> <DateTime value={f.erpStamp} />
                  </div>
                </td>
                <td>
                  <DateTime value={f.detectedAt} /> <StateBadge state={f.detectedInState} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

export function LateFindingsSection({
  findings,
  names,
  index,
}: Readonly<{
  findings: PagedState<CountLateEventFinding>;
  names: ReadonlyMap<string, string>;
  index: number;
}>) {
  const t = useT();
  let body: React.JSX.Element;
  if (findings.isLoading) {
    body = <ListState state="loading" label={t("counts.late.loadingNoun")} />;
  } else if (findings.error) {
    body = (
      <div className="counts__body">
        <ReadError
          error={findings.error}
          failedKey="counts.late.loadFailed"
          notFoundKey="counts.session.notFound"
          onRetry={findings.retry}
        />
      </div>
    );
  } else if (findings.rows.length === 0) {
    body = <ListState state="empty" emptyMessage={t("counts.late.empty")} />;
  } else {
    body = (
      <>
        <FindingsTable rows={findings.rows} names={names} />
        <div className="counts__body">
          <StaleError error={findings.inlineError} onRetry={findings.retry} />
        </div>
        <LoadMore
          hasMore={findings.hasMore}
          isFetching={findings.isFetchingNextPage}
          label={t("counts.late.loadMore")}
          onLoadMore={findings.loadMore}
        />
      </>
    );
  }
  return (
    <DetailPanel id="count-late" index={index} title={t("counts.late.title")}>
      <div className="counts__body">
        <p className="counts__note">{t("counts.late.sub")}</p>
      </div>
      {body}
    </DetailPanel>
  );
}
