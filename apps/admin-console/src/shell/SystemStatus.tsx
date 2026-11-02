/**
 * RT-1071: the sidebar system-status block (DESIGN.md §12.6), from the
 * server-computed `consoleGetSystemStatus` read (RT-1056). Replaces the
 * «قريبًا» frame of RT-993.
 *
 * Read on mount (and when the tenant changes) and on Refresh only: no polling,
 * no refetch on focus or interval (NG-7, D-4). A failed read shows every
 * component unknown, never healthy. A 404 (a role outside the allowed set)
 * renders nothing. State is always named in words, never by colour alone.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { formatDateTime, formatDuration, useT } from "@/i18n";
import { consoleGetSystemStatus } from "@/lib/system-status-queries";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import {
  COMPONENT_LABEL,
  STATE_LABEL,
  type StatusView,
  ageMinutes,
  isStale,
  statusView,
  unknownView,
} from "./systemStatusLogic";

class StatusReadError extends Error {
  constructor(readonly status: number) {
    super("system-status");
  }
}

async function readStatus() {
  const res = await consoleGetSystemStatus();
  if (res.status >= 400 || !res.data) throw new StatusReadError(res.status);
  return res.data;
}

export function SystemStatus(): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id ?? null;
  const query = useQuery({
    queryKey: ["system-status", tenantId],
    queryFn: readStatus,
    enabled: Boolean(tenantId),
    // Load and Refresh only (D-4): the cached read is never refetched by itself.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    retry: false,
  });

  // A local clock for the stale label only; it triggers no request.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const refused = query.error instanceof StatusReadError && query.error.status === 404;
  if (refused) return null; // non-disclosing: nothing about the cause is shown

  const loading = query.isPending && query.fetchStatus !== "idle";
  const failed = query.isError;
  const body = query.data;
  // A failed (re-)read shows unknown even if an earlier body is cached: a stale `ok` is never kept.
  const view: StatusView | null = failed ? unknownView() : body ? statusView(body) : null;
  const receivedAt = query.dataUpdatedAt;
  const stale = !failed && body && receivedAt > 0 && isStale(receivedAt, now);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of read-only text and links, not form controls; a fieldset would announce a form grouping.
    <div className="sidebar__status" role="group" aria-labelledby={titleId}>
      <div className="sidebar__status-head">
        <span id={titleId} className="sidebar__status-title">
          {t("shell.status.title")}
        </span>
        <button
          type="button"
          className="sidebar__status-refresh"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {t("shell.status.refresh")}
        </button>
      </div>
      {loading || query.isFetching ? (
        <output className="sidebar__status-note">{t("shell.status.loading")}</output>
      ) : null}
      {view ? (
        <ul className="sidebar__status-list">
          {view.components.map((c) => (
            <li key={c.id} className="sidebar__status-row" data-state={c.state}>
              <span className="sidebar__status-name">
                {c.route ? (
                  <Link className="sidebar__status-link" to={c.route}>
                    {t(COMPONENT_LABEL[c.id])}
                  </Link>
                ) : (
                  t(COMPONENT_LABEL[c.id])
                )}
              </span>
              <span className="sidebar__status-state">{t(STATE_LABEL[c.state])}</span>
              {c.reasonKey ? (
                <span className="sidebar__status-reason">{t(c.reasonKey)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {failed ? (
        <output className="sidebar__status-note">{t("shell.status.readFailed")}</output>
      ) : null}
      {body && !failed ? (
        <span className="sidebar__status-note">
          {t("shell.status.asOf", { time: formatDateTime(body.asOf) })}
        </span>
      ) : null}
      {stale ? (
        <span className="sidebar__status-note sidebar__status-stale">
          {t("shell.status.stale", { age: formatDuration(ageMinutes(receivedAt, now) * 60) })}
        </span>
      ) : null}
    </div>
  );
}
