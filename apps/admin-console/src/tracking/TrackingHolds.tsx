/**
 * RT-455 — «الحجز والاستدعاء»: the tenant's tracked-inventory safety screen
 * (board `docs/design/v9/boards/Tracking-holds*.dc.html`, RT-972 notes §2).
 *
 * - The band's facts are counts of the computed findings, which are not paged,
 *   so they are the whole set in the caller's scope (D-V9): active holds,
 *   expired-but-sellable POSITIONS (one finding per identity, store and unit;
 *   TR-8), and when the server computed them. None while the read loads or
 *   failed: an unknown count is «—», never zero.
 * - Critical `tracking_consistency` findings sit in their own band above the
 *   tabs (OD-8), only when the server reports one.
 * - Tabs: active holds and expired-sellable (findings); «قريبة الانتهاء»
 *   (stopped: `expiring_lot` is never emitted); released holds and past recalls
 *   (owner / tenant_admin, TR-3).
 * - RT-455 part 2 (RT-451 S3 and S5 runtime): the Tracking Resolution queue
 *   (list and bind; the owner binds) and the sale-line findings on their own
 *   keyset-paged read. The tracking consistency check has no emitter on `main`:
 *   it is shown as unavailable, never as zero.
 * - A store_manager sees findings for its own stores, rows without «عرض», and
 *   the OD-9 count of unresolved sales in its stores, never a row.
 *
 * The screen is hidden for a tenant with no tracked products (TR-6), and while
 * the tenant's tracked-selling switch is off or its deployment gate answers
 * 404 (RT-455 part 1, OD-T4): the nav never lists it, and a deep link says so
 * instead of showing empty tables.
 * Every rule stays in Backend-Core; this screen reads.
 */
import { NoAccess } from "@/auth/NoAccess";
import { useStoreLabels } from "@/catalog/useCatalogProduct";
import { Banner } from "@/components/Banner";
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { type BandFacts, ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { formatDateTime, useLocale, useT } from "@/i18n";
import type { SafetyFindingList } from "@/lib/tracking-queries";
import { useSignOut } from "@/shell/useSignOut";
import { TrackingPagesGate } from "@/tracked-selling/TrackingPagesGate";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ReadError } from "../inventory/parts";
import { type InventoryScope, type ReadState, useInventoryScope } from "../inventory/useInventory";
import { ActiveHoldsPanel, ConsistencyBand, ExpiredPanel, ExpiringPanel } from "./FindingPanels";
import { RecallsPanel, ReleasedPanel } from "./HistoryPanels";
import { RecallCreateDrawer } from "./RecallCreate";
import { ManagerQueueCount, QueueCountLine, ResolutionPanel } from "./ResolutionPanels";
import { SaleLinePanel } from "./SaleLinePanels";
import { HoldDrawer, RecallDrawer } from "./TrackingDrawers";
import { TrackingNamesProvider } from "./parts";
import {
  type FindingGroups,
  type TrackingTab,
  canOpenTracking,
  canReadHolds,
  canReadQueue,
  groupFindings,
  tabForKey,
  tabFromSearch,
  tabsFor,
} from "./trackingLogic";
import {
  useMemberNames,
  useSafetyFindings,
  useTrackingSummaryQuery,
  useUnresolvedCount,
} from "./useTracking";
import "../shell/surface.css";
import "../inventory/inventory.css";
import "./tracking.css";

// --- Band -------------------------------------------------------------------------

function useBandFacts(findings: ReadState<SafetyFindingList>, groups: FindingGroups) {
  const t = useT();
  const data = findings.data;
  if (!data || findings.inlineError) return undefined;
  const facts: BandFacts = [
    { label: t("tracking.band.activeHolds"), value: <bdi>{groups.holds.length}</bdi> },
    { label: t("tracking.band.expiredPositions"), value: <bdi>{groups.expired.length}</bdi> },
    { label: t("tracking.band.generatedAt"), value: formatDateTime(data.generatedAt) },
  ];
  return { label: t("tracking.band.label"), items: facts };
}

// --- Tabs -------------------------------------------------------------------------

const TAB_KEYS = {
  active: "tracking.tab.active",
  expired: "tracking.tab.expired",
  expiring: "tracking.tab.expiring",
  released: "tracking.tab.released",
  recalls: "tracking.tab.recalls",
  resolution: "tracking.tab.resolution",
  saleLines: "tracking.tab.saleLines",
} as const;

function tabId(tab: TrackingTab): string {
  return `tracking-tab-${tab}`;
}

function panelId(tab: TrackingTab): string {
  return `tracking-panel-${tab}`;
}

/**
 * A count beside a tab: current-state findings, and the unresolved sales (OD-2,
 * TR-8: the event findings are never counted). None while a count is unknown.
 */
function tabCount(
  tab: TrackingTab,
  groups: FindingGroups | undefined,
  unresolved: number | undefined,
): number | undefined {
  if (tab === "resolution") return unresolved;
  if (!groups) return undefined;
  if (tab === "active") return groups.holds.length;
  if (tab === "expired") return groups.expired.length;
  return undefined;
}

function TabList({
  tabs,
  selected,
  groups,
  unresolved,
  onSelect,
}: Readonly<{
  tabs: readonly TrackingTab[];
  selected: TrackingTab;
  groups: FindingGroups | undefined;
  unresolved: number | undefined;
  onSelect: (tab: TrackingTab) => void;
}>): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const refs = useRef(new Map<TrackingTab, HTMLButtonElement>());
  function onKeyDown(event: React.KeyboardEvent): void {
    const target = tabForKey(event.key, selected, tabs, locale === "ar");
    if (!target) return;
    event.preventDefault();
    onSelect(target);
    refs.current.get(target)?.focus();
  }
  return (
    <div className="tracking-tabs" role="tablist" aria-label={t("tracking.tabs.label")}>
      {tabs.map((tab) => {
        const isSelected = selected === tab;
        const count = tabCount(tab, groups, unresolved);
        return (
          <button
            key={tab}
            ref={(el) => {
              if (el) refs.current.set(tab, el);
            }}
            type="button"
            role="tab"
            id={tabId(tab)}
            aria-controls={isSelected ? panelId(tab) : undefined}
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className="tracking-tab"
            onClick={() => onSelect(tab)}
            onKeyDown={onKeyDown}
          >
            {t(TAB_KEYS[tab])}
            {count === undefined ? null : <span className="tracking-tab__count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// --- Panels -----------------------------------------------------------------------

interface PanelProps {
  tab: TrackingTab;
  scope: InventoryScope;
  findings: ReadState<SafetyFindingList>;
  groups: FindingGroups | undefined;
  onOpenHold: (id: string) => void;
  onOpenRecall: (id: string) => void;
}

/** The findings tabs share one read: loading and failure show once, here. */
function FindingsGate({
  findings,
  children,
}: Readonly<{ findings: ReadState<SafetyFindingList>; children: React.ReactNode }>) {
  const t = useT();
  if (findings.isLoading) {
    return (
      <div className="inventory__panel-body inventory__panel-body--solo">
        <ListState state="loading" label={t("tracking.findings.loadingNoun")} />
      </div>
    );
  }
  if (findings.error) {
    return (
      <div className="inventory__panel-body inventory__panel-body--solo">
        <ReadError
          error={findings.error}
          failedKey="tracking.findings.loadFailed"
          notFoundKey="tracking.findings.loadFailed"
          onRetry={findings.retry}
        />
      </div>
    );
  }
  return <>{children}</>;
}

function TabPanel(props: Readonly<PanelProps>): React.JSX.Element {
  const t = useT();
  const { tab, scope, findings, groups } = props;
  const reads = canReadQueue(scope.role);
  const canOpen = canReadHolds(scope.role);
  let body: React.ReactNode;
  if (tab === "active" || tab === "expired") {
    body = (
      <FindingsGate findings={findings}>
        {groups && tab === "active" ? (
          <ActiveHoldsPanel holds={groups.holds} canOpen={canOpen} onOpen={props.onOpenHold} />
        ) : null}
        {groups && tab === "expired" ? (
          <ExpiredPanel expired={groups.expired} canOpen={canOpen} />
        ) : null}
      </FindingsGate>
    );
  } else if (tab === "expiring") {
    body = <ExpiringPanel />;
  } else if (tab === "released") {
    body = <ReleasedPanel scope={scope} />;
  } else if (tab === "recalls") {
    body = <RecallsPanel scope={scope} onOpen={props.onOpenRecall} />;
  } else if (tab === "resolution") {
    // OD-9: a store_manager gets the count only, never a row.
    body = reads ? (
      <ResolutionPanel scope={scope} />
    ) : (
      <div className="inventory__panel-body inventory__panel-body--solo">
        <p className="tracking__muted">{t("tracking.resolution.title")}</p>
        <ManagerQueueCount scope={scope} />
      </div>
    );
  } else {
    body = <SaleLinePanel scope={scope} />;
  }
  return (
    <section
      role="tabpanel"
      id={panelId(tab)}
      aria-labelledby={tabId(tab)}
      className="tracking-panel"
    >
      <DetailPanel id={`tracking-${tab}`}>{body}</DetailPanel>
    </section>
  );
}

// --- Page -------------------------------------------------------------------------

function StoreManagerNotes({
  unresolved,
}: Readonly<{ unresolved: ReadState<number> }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="inventory__strip" data-testid="tracking-manager-notes">
      <p className="inventory__note">{t("tracking.manager.readOnly")}</p>
      {/* OD-9: the count of unresolved sales in its stores, from the queue read. */}
      <QueueCountLine count={unresolved} />
    </div>
  );
}

function HoldsView({ scope }: Readonly<{ scope: InventoryScope }>): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const [search, setSearch] = useSearchParams();
  const [holdId, setHoldId] = useState<string | null>(null);
  const [recallId, setRecallId] = useState<string | null>(null);
  const [recalling, setRecalling] = useState(false);
  const tabs = tabsFor(scope.role);
  const selected = tabFromSearch(search, tabs);
  const findings = useSafetyFindings(scope);
  const groups = useMemo(
    () => (findings.data ? groupFindings(findings.data.findings) : undefined),
    [findings.data],
  );
  const unresolved = useUnresolvedCount(scope);
  const facts = useBandFacts(findings, groups ?? { holds: [], expired: [], consistency: [] });
  const holdsRole = canReadHolds(scope.role);
  const storeName = useStoreLabels(
    scope.tenantId,
    { id: context?.active_store?.id ?? null, name: context?.active_store?.name ?? null },
    true,
  );
  const members = useMemberNames(scope.tenantId, holdsRole);
  const names = useMemo(
    () => ({ storeName: (id: string) => storeName(id).name, members }),
    [storeName, members],
  );
  const tenant = <bdi dir="auto">{context?.active_tenant?.name}</bdi>;
  const select = (tab: TrackingTab) =>
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", tab);
        return next;
      },
      { replace: true },
    );

  return (
    <TrackingNamesProvider value={names}>
      <div className="surface inventory--v4 tracking">
        <ListHeaderBand
          group={t("shell.nav.section.stock")}
          title={t("tracking.title")}
          subtitle={
            holdsRole ? t.rich("tracking.sub.tenant", { tenant }) : t("tracking.sub.manager")
          }
          facts={facts}
          actions={
            holdsRole ? (
              <button type="button" className="btn-primary" onClick={() => setRecalling(true)}>
                {t("tracking.recallCreate.open")}
              </button>
            ) : undefined
          }
        />
        {findings.inlineError ? (
          <Banner
            variant="warning"
            message={t("tracking.findings.stale")}
            requestId={findings.inlineError.requestId}
            action={
              <GatedButton type="button" className="btn-secondary" onClick={findings.retry}>
                {t("inventory.retry")}
              </GatedButton>
            }
          />
        ) : null}
        {findings.error ? (
          <p className="tracking__muted" data-testid="tracking-band-unknown">
            {t("tracking.band.unknown")}
          </p>
        ) : null}
        {holdsRole ? null : <StoreManagerNotes unresolved={unresolved} />}
        {groups ? <ConsistencyBand findings={groups.consistency} /> : null}
        <TabList
          tabs={tabs}
          selected={selected}
          groups={groups}
          unresolved={unresolved.data}
          onSelect={select}
        />
        <TabPanel
          tab={selected}
          scope={scope}
          findings={findings}
          groups={groups}
          onOpenHold={setHoldId}
          onOpenRecall={setRecallId}
        />
        {holdId && holdsRole ? (
          <HoldDrawer
            scope={scope}
            holdId={holdId}
            code={groups?.holds.find((h) => h.holdId === holdId)?.identityCode}
            onClose={() => setHoldId(null)}
          />
        ) : null}
        {recallId && holdsRole ? (
          <RecallDrawer scope={scope} recallId={recallId} onClose={() => setRecallId(null)} />
        ) : null}
        {recalling && holdsRole ? (
          <RecallCreateDrawer scope={scope} onClose={() => setRecalling(false)} />
        ) : null}
      </div>
    </TrackingNamesProvider>
  );
}

/** TR-6: a tenant with no tracked products has no tracking section; a deep link says so. */
function NotTracked(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <ListHeaderBand group={t("shell.nav.section.stock")} title={t("tracking.title")} />
      <div
        className="inventory__panel-body inventory__panel-body--solo"
        data-testid="tracking-not-tracked"
      >
        <ListState state="empty" emptyMessage={t("tracking.notTracked.title")} />
        <p className="tracking__muted">{t("tracking.notTracked.body")}</p>
      </div>
    </div>
  );
}

/** TR-6, inside the OD-T4 gate. */
function TrackedHoldsBody({
  scope,
  summary,
}: Readonly<{
  scope: InventoryScope;
  summary: ReturnType<typeof useTrackingSummaryQuery>;
}>): React.JSX.Element {
  const t = useT();
  if (summary.isLoading) return <ListState state="loading" label={t("tracking.loadingNoun")} />;
  if (summary.data === false) return <NotTracked />;
  // A failed summary does not hide a screen reached by link: its own reads say what failed.
  return <HoldsView scope={scope} />;
}

export function TrackingHolds(): React.JSX.Element {
  const t = useT();
  const scope = useInventoryScope();
  const signOut = useSignOut();
  const summary = useTrackingSummaryQuery(scope.tenantId, scope.role);
  if (!canOpenTracking(scope.role)) return <NoAccess onSignOut={signOut} />;
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("inventory.scopePrompt")}</p>
      </div>
    );
  }
  // RT-455 part 1 (OD-T4): nothing below shows while tracked selling is off.
  const body = <TrackedHoldsBody scope={scope} summary={summary} />;
  return (
    <TrackingPagesGate tenantId={scope.tenantId} role={scope.role}>
      {body}
    </TrackingPagesGate>
  );
}
