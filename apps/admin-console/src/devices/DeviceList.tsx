import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { DataTableSkeleton } from "@/components/DataTableSkeleton";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { LoadErrorBanner } from "@/components/LoadErrorBanner";
import { ReadingNote } from "@/components/ReadingNote";
import { canSeeSystemDetail } from "@/context/effectiveRole";
import { DateTime, type T, useT } from "@/i18n";
import type { DeviceSummary } from "@/lib/device-queries";
import { type StoreDirectory, useStoreDirectory } from "@/shift-closes/useShiftCloses";
/**
 * RT-371 — Devices: the fleet table (read-only). Exception-first in the
 * SERVER's order (custody exception, then active by soonest expiry, then
 * revoked, then retired), keyset paged; the view never re-sorts or filters
 * loaded rows. "Stale" is not ordered: last seen is not recorded until RT-370.
 * Filters (store, trust state) live in the URL so Back from a detail and the
 * Store Detail deep link restore them; a filter never changes the active scope.
 *
 * A failed continuation keeps the loaded rows and offers an inline retry
 * (UX-10). A 404 is the API's uniform refusal: with a store filter it reads as
 * "this store's devices are not available to you", never as an empty list.
 *
 * RT-1013 (v4.0): the band carries scope only. `DevicePage` serves no whole-set
 * value (only `items` and `nextCursor`), so it shows no fact, and "loaded so far"
 * stays in the pager, never dressed up as a total. Every result state sits in one
 * results panel; the rows open a device, so they keep a selectable table's ruled
 * rows (DESIGN.md §12.5).
 *
 * Modern concept (Settings & Devices): five columns by default (device, store,
 * trust, attention, unsent sales); credential expiry and last seen sit behind
 * a "show more columns" toggle (rule 1). One smart insight sits above the
 * results, computed from the rows and the health index already on the page
 * (`DeviceInsight.tsx`, rule 4). Pairing codes is the page's one main action
 * (`btn-primary`, rule 2); the POS download stays a secondary link because it
 * is the only entry point to the navigator-only /devices/download-pos screen.
 */
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { DeviceFilterBar } from "./DeviceFilterBar";
import { DeviceInsight } from "./DeviceInsight";
import { Attention, DeviceName, LastSeen, TrustBadge } from "./DeviceParts";
import { SaleQueueCell } from "./SaleQueueParts";
import {
  type DeviceFilters,
  buildListQuery,
  filtersFromSearch,
  filtersToSearch,
  isFiltered,
} from "./deviceFilters";
import { hasStrandedSales, saleQueueStateOf } from "./saleQueueLogic";
import { type DeviceHealthIndex, useDeviceHealthIndex } from "./useDeviceHealth";
import {
  type DeviceError,
  type DeviceListState,
  useDeviceList,
  useDeviceScope,
} from "./useDevices";
import "../shell/surface.css";
import "./devices.css";

function deviceColumns(
  t: T,
  directory: StoreDirectory,
  now: number,
  saleQueues: DeviceHealthIndex,
  showDetails: boolean,
  showSystem: boolean,
): DataTableColumn<DeviceSummary>[] {
  // RT-1312: joined by deviceId; a device absent from the device-health read is unavailable.
  const queueOf = (d: DeviceSummary) =>
    saleQueueStateOf(saleQueues.byId.get(d.deviceId), saleQueues.status);
  const columns: DataTableColumn<DeviceSummary>[] = [
    {
      key: "device",
      header: t("devices.list.col.device"),
      cell: (d) => <DeviceName label={d.label} deviceId={d.deviceId} showDeviceId={showSystem} />,
    },
    {
      key: "store",
      header: t("devices.list.col.store"),
      cell: (d) => directory.nameOf(d.storeId) ?? t("devices.list.unknownStore"),
    },
    {
      key: "trust",
      header: t("devices.list.col.trust"),
      cell: (d) => <TrustBadge trustState={d.trustState} />,
    },
    {
      key: "attention",
      header: t("devices.list.col.attention"),
      cell: (d) => (
        <Attention
          device={d}
          now={now}
          strandedSales={showSystem && hasStrandedSales(queueOf(d))}
        />
      ),
    },
  ];
  if (showSystem) {
    columns.push({
      key: "saleQueue",
      header: t("devices.saleQueue.col"),
      cell: (d) => <SaleQueueCell state={queueOf(d)} timeZone={directory.timeZoneOf(d.storeId)} />,
    });
  }
  // Modern concept, rule 1: expiry and last seen are details on demand. The
  // Attention column already flags a passed expiry, and last seen is not
  // recorded for most devices yet (RT-370), so the default five columns carry
  // the one-line status; the toggle restores the full seven.
  if (showDetails) {
    columns.push(
      {
        key: "expires",
        header: t("devices.list.col.expires"),
        cell: (d) => <DateTime value={d.expiresAt} timeZone={directory.timeZoneOf(d.storeId)} />,
      },
      {
        key: "lastSeen",
        header: t("devices.list.col.lastSeen"),
        cell: (d) => (
          <LastSeen
            lastSeenAt={d.lastSeenAt}
            lastSeenSource={d.lastSeenSource}
            timeZone={directory.timeZoneOf(d.storeId)}
            showSource
          />
        ),
      },
    );
  }
  return columns;
}

interface ErrorViewProps {
  error: DeviceError;
  storeFiltered: boolean;
  onRetry: () => void;
  onClear: () => void;
}

/**
 * A rejected filter (400) cannot be fixed by retrying the same request: the way
 * out is to clear the filters. Any other failure offers a retry.
 */
function FailureBanner({
  error,
  onRetry,
  onClear,
}: Readonly<Omit<ErrorViewProps, "storeFiltered">>): React.JSX.Element {
  const t = useT();
  if (error.kind === "rejected") {
    return (
      <Banner
        variant="warning"
        message={t("devices.list.filterRejected")}
        requestId={error.requestId}
        action={
          <button type="button" className="btn-secondary" onClick={onClear}>
            {t("devices.list.clearFilters")}
          </button>
        }
      />
    );
  }
  return (
    <LoadErrorBanner
      what={t("devices.list.loadFailed")}
      failure={error.failure}
      retryLabel={t("devices.list.retry")}
      onRetry={onRetry}
    />
  );
}

function ErrorView({
  error,
  storeFiltered,
  onRetry,
  onClear,
}: Readonly<ErrorViewProps>): React.JSX.Element {
  const t = useT();
  if (error.kind === "not-found") {
    return storeFiltered ? (
      <ListState
        state="empty"
        emptyMessage={t("devices.list.storeUnavailable")}
        emptyHint={t("devices.list.storeUnavailableHint")}
      />
    ) : (
      <ListState state="empty" emptyMessage={t("devices.list.unavailable")} />
    );
  }
  if (error.kind === "session") {
    return (
      <Banner
        variant="danger"
        message={t("devices.list.sessionExpired")}
        requestId={error.requestId}
      />
    );
  }
  return <FailureBanner error={error} onRetry={onRetry} onClear={onClear} />;
}

/** Loaded count, the inline continuation error, and Load more. */
function Pager({ list }: Readonly<{ list: DeviceListState }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      {list.inlineError ? (
        <LoadErrorBanner
          what={t("devices.list.inlineError")}
          failure={list.inlineError.failure}
          retryLabel={t("devices.list.retry")}
          onRetry={list.retry}
        />
      ) : null}
      <div className="device-pager">
        <span>{t("devices.list.loaded", { count: list.rows.length })}</span>
        {list.hasMore ? (
          <BusyButton
            type="button"
            className="btn-secondary"
            onClick={list.loadMore}
            busy={list.isFetchingNextPage}
          >
            {t("devices.list.loadMore")}
          </BusyButton>
        ) : null}
      </div>
    </>
  );
}

interface ResultsProps {
  list: DeviceListState;
  saleQueues: DeviceHealthIndex;
  directory: StoreDirectory;
  filters: DeviceFilters;
  now: number;
  showDetails: boolean;
  showSystem: boolean;
  onOpen: (row: DeviceSummary) => void;
  onClear: () => void;
}

/**
 * Rows are held back until the store roster has settled (read or failed), so a
 * time is never shown in UTC, or a store as unknown, just because the roster
 * had not arrived yet.
 */
function awaitingRoster(list: DeviceListState, directory: StoreDirectory): boolean {
  return list.rows.length > 0 && !directory.ready;
}

function Results(props: Readonly<ResultsProps>): React.JSX.Element {
  return (
    <div className="section-panel device-results">
      <ResultState {...props} />
    </div>
  );
}

function ResultState({
  list,
  saleQueues,
  directory,
  filters,
  now,
  showDetails,
  showSystem,
  onOpen,
  onClear,
}: Readonly<ResultsProps>): React.JSX.Element {
  const t = useT();
  const columns = deviceColumns(t, directory, now, saleQueues, showDetails, showSystem);
  const pending = list.isLoading || awaitingRoster(list, directory);
  if (pending) {
    return (
      <DataTableSkeleton
        caption={t("devices.list.caption")}
        columns={columns}
        label={t("devices.list.loadingNoun")}
      />
    );
  }
  if (list.error) {
    return (
      <ErrorView
        error={list.error}
        storeFiltered={filters.storeId !== ""}
        onRetry={list.retry}
        onClear={onClear}
      />
    );
  }
  if (list.rows.length === 0) {
    const filtered = isFiltered(filters);
    return (
      <ListState
        state="empty"
        emptyMessage={t(filtered ? "devices.list.emptyFiltered" : "devices.list.empty")}
        emptyHint={t(filtered ? "devices.list.emptyFilteredHint" : "devices.list.emptyHint")}
      />
    );
  }
  return (
    <>
      <DataTable
        caption={t("devices.list.caption")}
        columns={columns}
        rows={list.rows}
        rowKey={(d) => d.deviceId}
        onRowActivate={onOpen}
      />
      <Pager list={list} />
    </>
  );
}

export function DeviceList(): React.JSX.Element {
  const t = useT();
  const scope = useDeviceScope();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const directory = useStoreDirectory(scope.tenantId);
  // One clock reading per mount: "expiry passed" does not flicker between renders.
  const [now] = useState(() => Date.now());
  // Modern concept, rule 1: expiry and last seen are details on demand.
  const [showDetails, setShowDetails] = useState(false);

  const filters = filtersFromSearch(search);
  const showSystem = canSeeSystemDetail(scope.role);
  const list = useDeviceList(scope, buildListQuery(filters));
  const saleQueues = useDeviceHealthIndex(scope, filters, showSystem);
  const clearFilters = () => setSearch(new URLSearchParams());

  if (!scope.tenantId) {
    return (
      <div className="surface device-surface">
        <p className="content__sub">{t("devices.list.scopePrompt")}</p>
      </div>
    );
  }

  return (
    <div className="surface device-surface">
      <ListHeaderBand
        group={t("shell.nav.section.daily")}
        title={t("devices.list.title")}
        subtitle={t.rich("devices.list.sub", { tenant: <bdi>{scope.tenantName}</bdi> })}
        actions={
          <>
            <Link to="/devices/pairing-codes" className="btn-primary">
              {t("devices.list.pairingCodes")}
            </Link>
            {/* RT-1304 D-2: an action of this page, not a destination: no nav-model entry. */}
            {/* Modern concept, rule 2: the download stays secondary — it is the
                only entry point to the navigator-only /devices/download-pos screen. */}
            <Link to="/devices/download-pos" className="btn-secondary">
              {t("devices.download.title")}
            </Link>
          </>
        }
      />
      <DeviceFilterBar
        applied={filters}
        stores={directory.stores}
        onApply={(next) => setSearch(filtersToSearch(next))}
        onClear={clearFilters}
      />
      <ReadingNote>
        <p>{t("devices.list.orderNote")}</p>
        <p>{t("devices.list.staleNote")}</p>
      </ReadingNote>

      <DeviceInsight list={list} saleQueues={saleQueues} now={now} showSystem={showSystem} />

      <div className="device-columns">
        <button
          type="button"
          className="btn-ghost"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((v) => !v)}
        >
          {t(showDetails ? "devices.list.showFewer" : "devices.list.showMore")}
        </button>
      </div>

      {/* Only beside rows: with no rows the list's own state already speaks. */}
      {showSystem && saleQueues.status === "failed" && list.rows.length > 0 ? (
        <Banner
          variant="warning"
          message={t("devices.saleQueue.loadFailed")}
          requestId={saleQueues.requestId}
          action={
            <button type="button" className="btn-secondary" onClick={saleQueues.retry}>
              {t("devices.list.retry")}
            </button>
          }
        />
      ) : null}

      <Results
        list={list}
        saleQueues={saleQueues}
        directory={directory}
        filters={filters}
        now={now}
        showDetails={showDetails}
        showSystem={showSystem}
        onClear={clearFilters}
        onOpen={(row) => navigate(`/devices/${row.deviceId}`, { state: { list: location.search } })}
      />
    </div>
  );
}
