/**
 * RT-1440 (U1) A4 — Shifts closed without a count: a read-only list from the audit search
 * (`action=shift.force_closed`), newest first, with cursor continuation (UX-10.16). It shows who
 * closed each shift, when, where and through which channel (a POS terminal or the Console). The
 * reason stays on the fact and is not in the audit row (D5a), so there is no reason column. Times
 * carry an explicit zone (a cross-store view, UX-12.29). Nothing here writes.
 */
import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { DateTime, roleKey, useT } from "@/i18n";
import { Machine } from "@/inventory/parts";
import { listAuditEvents } from "@/lib/client";
import { usePeopleNames } from "@/people/usePeopleNames";
import { useStoreDirectory } from "@/shift-closes/useShiftCloses";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  FORCE_CLOSED_ACTION,
  type ForceClosedRow,
  forceClosedRows,
} from "./forceClosedLogic";
import "../shell/surface.css";

const PAGE_SIZE = 50;

interface ClosedPage {
  rows: ForceClosedRow[];
  next: string | null;
}

type ListError = { kind: "not-available" | "failed"; requestId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useForceClosedList(tenantId: string | null, storeId: string | null) {
  return useInfiniteQuery<ClosedPage, ListError, { pages: ClosedPage[] }, unknown[], string | undefined>({
    queryKey: ["force-actions", "closed", tenantId, storeId],
    enabled: tenantId !== null,
    retry: false,
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    queryFn: async ({ pageParam }) => {
      const res = await listAuditEvents({
        action: FORCE_CLOSED_ACTION,
        limit: PAGE_SIZE,
        cursor: pageParam,
        ...(storeId ? { store_id: storeId } : {}),
      });
      if (res.status === 200 && res.data) {
        const next = (res.data as { next_cursor?: unknown }).next_cursor;
        return { rows: forceClosedRows(res.data), next: typeof next === "string" ? next : null };
      }
      const requestId = (res.error as { error?: { request_id?: string } } | undefined)?.error?.request_id;
      throw { kind: res.status === 403 || res.status === 404 ? "not-available" : "failed", requestId } satisfies ListError;
    },
  });
}

function RowView({
  row,
  names,
  storeName,
}: Readonly<{ row: ForceClosedRow; names: ReadonlyMap<string, string>; storeName: (id: string) => string | undefined }>): React.JSX.Element {
  const t = useT();
  const who = row.actorUserId ? names.get(row.actorUserId.toLowerCase()) : undefined;
  const store = row.storeId ? storeName(row.storeId) : undefined;
  return (
    <tr>
      <td>
        <bdi dir="ltr">
          <DateTime value={row.occurredAt} />
        </bdi>
      </td>
      <td>
        {row.actorUserId === null ? (
          t("forceActions.closed.unknown")
        ) : who ? (
          <bdi dir="auto">{who}</bdi>
        ) : (
          <Machine value={row.actorUserId} />
        )}
        {row.actorRole ? <small className="device-quiet"> · {t(roleKey(row.actorRole))}</small> : null}
      </td>
      <td>{t(`forceActions.closed.channel.${row.channel}`)}</td>
      <td>
        {row.storeId === null ? (
          t("forceActions.closed.unknown")
        ) : store ? (
          <bdi dir="auto">{store}</bdi>
        ) : (
          <Machine value={row.storeId} />
        )}
      </td>
      <td>
        <Machine value={row.shiftId} />
      </td>
      <td>
        {row.ageMinutes === null
          ? t("forceActions.closed.unknown")
          : t("forceActions.closed.minutes", { count: row.ageMinutes })}
      </td>
    </tr>
  );
}

export function ForceClosedPage(): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id ?? null;
  // The Overview row counts one store when a store is active; its link carries that store (?store=).
  const [params] = useSearchParams();
  const storeParam = params.get("store");
  const list = useForceClosedList(tenantId, storeParam && UUID.test(storeParam) ? storeParam : null);
  const directory = useStoreDirectory(tenantId);
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];
  const names = usePeopleNames(rows.map((r) => r.actorUserId));

  return (
    <div className="surface">
      <Link to="/" className="surface__back">
        <BackArrow /> {t("shell.nav.overview")}
      </Link>
      <PageHeader title={t("forceActions.closed.title")} subtitle={t("forceActions.closed.sub")} />
      {list.isLoading ? (
        <output className="content__sub">
          <span className="spinner" aria-hidden="true" /> {t("forceActions.closed.loading")}
        </output>
      ) : null}
      {list.error ? (
        <Banner
          variant="danger"
          message={t(list.error.kind === "not-available" ? "forceActions.closed.notAvailable" : "forceActions.closed.loadFailed")}
          requestId={list.error.requestId}
          action={
            list.error.kind === "failed" ? (
              <button type="button" className="btn-secondary" onClick={() => void list.refetch()}>
                {t("forceActions.closed.retry")}
              </button>
            ) : undefined
          }
        />
      ) : null}
      {list.data && rows.length === 0 ? <p>{t("forceActions.closed.empty")}</p> : null}
      {rows.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">{t("forceActions.closed.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("forceActions.closed.col.when")}</th>
                <th scope="col">{t("forceActions.closed.col.by")}</th>
                <th scope="col">{t("forceActions.closed.col.channel")}</th>
                <th scope="col">{t("forceActions.closed.col.store")}</th>
                <th scope="col">{t("forceActions.closed.col.shift")}</th>
                <th scope="col">{t("forceActions.closed.col.age")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RowView key={row.id} row={row} names={names} storeName={directory.nameOf} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t("forceActions.closed.loadMore")}
        </button>
      ) : null}
    </div>
  );
}
