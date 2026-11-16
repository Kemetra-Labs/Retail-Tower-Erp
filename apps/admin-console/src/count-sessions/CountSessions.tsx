/**
 * RT-1425 — one store's stock counts: open a Count Session and the store's
 * sessions, newest first, keyset paged (Load more; a failed continuation keeps the
 * rows). The list never carries an expected quantity (blind capture). Roles follow
 * the inventory views; the API decides every refusal.
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { DataTableSkeleton } from "@/components/DataTableSkeleton";
import { DetailPanel } from "@/components/DetailPanel";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { DateTime, useT } from "@/i18n";
import { isUuid } from "@/inventory/inventoryLogic";
import { BackLink, LoadMore, ReadError, StaleError } from "@/inventory/parts";
import { type InventoryScope, useStoreName } from "@/inventory/useInventory";
import type { CountSession, CountSessionState } from "@/lib/count-session-queries";
import { ScopeMismatchBanner } from "@/shell/ScopeMismatchBanner";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CountGate, StateBadge, usePersonLabel } from "./CountParts";
import { OpenCountPanel } from "./OpenCountPanel";
import { countStateKey } from "./countLogic";
import { useCountSessions } from "./useCounts";
import "../shell/surface.css";
import "../inventory/inventory.css";
import "./counts.css";

const FILTER_STATES: readonly CountSessionState[] = [
  "open",
  "cut_taken",
  "submitted",
  "approved",
  "posting",
  "confirmed",
  "needs_attention",
  "closed",
  "cancelled",
];

function SessionsTable({
  storeId,
  rows,
}: Readonly<{ storeId: string; rows: CountSession[] }>): React.JSX.Element {
  const t = useT();
  const person = usePersonLabel(rows.map((r) => r.openedBy));
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {t("counts.list.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("counts.list.col.opened")}</th>
              <th scope="col">{t("counts.list.col.state")}</th>
              <th scope="col">{t("counts.list.col.products")}</th>
              <th scope="col">{t("counts.list.col.openedBy")}</th>
              <th scope="col">{t("counts.list.col.findings")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <Link
                    to={`/inventory/stores/${storeId}/counts/${s.id}`}
                    aria-label={t("counts.list.open", { when: s.openedAt })}
                  >
                    <DateTime value={s.openedAt} />
                  </Link>
                </th>
                <td>
                  <StateBadge state={s.state} />
                </td>
                <td className="num">{s.scope.productIds.length}</td>
                <td>{person(s.openedBy)}</td>
                <td className="num">{s.lateEventFindingCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function SessionsPanel({
  scope,
  storeId,
  index,
}: Readonly<{ scope: InventoryScope; storeId: string; index: number }>) {
  const t = useT();
  const [state, setState] = useState<CountSessionState | "">("");
  const sessions = useCountSessions({ scope, storeId }, state);
  let body: React.JSX.Element;
  if (sessions.isLoading) {
    body = (
      <DataTableSkeleton
        caption={t("counts.list.caption")}
        columns={[
          { key: "opened", header: t("counts.list.col.opened") },
          { key: "state", header: t("counts.list.col.state") },
          { key: "products", header: t("counts.list.col.products") },
        ]}
        label={t("counts.list.loadingNoun")}
      />
    );
  } else if (sessions.error) {
    body = (
      <div className="counts__body">
        <ReadError
          error={sessions.error}
          failedKey="counts.list.loadFailed"
          notFoundKey="counts.store.notFound"
          onRetry={sessions.retry}
        />
      </div>
    );
  } else if (sessions.rows.length === 0 && !sessions.hasMore) {
    body = (
      <div className="counts__body">
        <ListState
          state="empty"
          emptyMessage={state ? t("counts.list.emptyFiltered") : t("counts.list.empty")}
        />
      </div>
    );
  } else {
    body = (
      <>
        <SessionsTable storeId={storeId} rows={sessions.rows} />
        <div className="counts__body">
          <StaleError error={sessions.inlineError} onRetry={sessions.retry} />
        </div>
        <LoadMore
          hasMore={sessions.hasMore}
          isFetching={sessions.isFetchingNextPage}
          label={t("counts.list.loadMore")}
          onLoadMore={sessions.loadMore}
        />
      </>
    );
  }
  return (
    <DetailPanel
      id="counts-list"
      index={index}
      title={t("counts.list.title")}
      aside={
        <div className="field counts__filter">
          <label htmlFor="count-state-filter">{t("counts.list.filter")}</label>
          <select
            id="count-state-filter"
            className="input"
            value={state}
            onChange={(e) => setState(e.target.value as CountSessionState | "")}
          >
            <option value="">{t("counts.list.filter.all")}</option>
            {FILTER_STATES.map((s) => (
              <option key={s} value={s}>
                {t(countStateKey(s))}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {body}
    </DetailPanel>
  );
}

function StoreCounts({
  scope,
  storeId,
}: Readonly<{ scope: InventoryScope; storeId: string }>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const name = useStoreName(scope.tenantId, storeId);
  return (
    <div className="surface inventory--v4 counts">
      <BackLink to={`/inventory/stores/${storeId}`} label={t("counts.back")} />
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("counts.title")}
        subtitle={name ? <bdi dir="auto">{name}</bdi> : t("counts.store.sub")}
      />
      <ScopeMismatchBanner storeId={storeId} />
      <div className="inventory__strip">
        <p className="inventory__note">{t("counts.note.blind")}</p>
        <p className="inventory__note">{t("counts.note.deskGuard")}</p>
      </div>
      <OpenCountPanel
        storeId={storeId}
        index={1}
        onOpened={(id) => navigate(`/inventory/stores/${storeId}/counts/${id}`)}
      />
      <SessionsPanel scope={scope} storeId={storeId} index={2} />
    </div>
  );
}

export function CountSessions(): React.JSX.Element {
  const { storeId } = useParams();
  return (
    <CountGate valid={isUuid(storeId)} storeId={storeId} notFoundKey="counts.store.notFound">
      {(scope) => <StoreCounts scope={scope} storeId={storeId ?? ""} />}
    </CountGate>
  );
}
