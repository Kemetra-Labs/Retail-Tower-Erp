/**
 * RT-1601 redistribution proposals list (W9 slice A, N4): the active tenant's proposals newest first,
 * and «Compute a proposal». A compute that finds something opens the new proposal; one that finds
 * nothing says so (and that any open proposal was replaced). The Console decides nothing about stock.
 *
 * Access: owner or tenant_admin with every store in scope. Other roles get NoAccess; a store-scoped
 * owner or tenant_admin gets the same "not available" view as a tenant with the feature off (a 404 also
 * hides rows cached from an earlier read). In every refused case nothing is
 * requested; no active tenant → a scope prompt. While the feature is off for the tenant the API
 * answers the non-disclosing 404: the screen says "not available", never why.
 */
import { NoAccess } from "@/auth/NoAccess";
import { BusyButton } from "@/components/BusyButton";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { ScopePrompt } from "@/components/ScopePrompt";
import { useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { LoadMore } from "@/inventory/parts";
import { CaptionedTable } from "@/inventory/transfers/TransferParts";
import type { RedistributionProposalSummary } from "@/lib/redistribution-queries";
import { useSignOut } from "@/shell/useSignOut";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  NoticeBanner,
  ObjectiveFacts,
  ProposalStateBadge,
  ReadFailed,
  type RedistributionNotice,
  Time,
  noticeOf,
} from "./RedistributionParts";
import {
  useRedistributionList,
  useRedistributionScope,
  useRedistributionWrites,
} from "./useRedistribution";
import "../shell/surface.css";
import "./redistribution.css";

function ProposalRow({
  row,
  onOpen,
}: Readonly<{ row: RedistributionProposalSummary; onOpen: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <tr className="data-table__row">
      <td>
        <Time iso={row.createdAt} />
      </td>
      <td>
        <ProposalStateBadge state={row.state} />
      </td>
      <td>
        <ObjectiveFacts objective={row.objective} />
      </td>
      <td className="data-table__cell--num">
        <bdi dir="ltr">{row.excludedStoreCount}</bdi>
      </td>
      <td className="data-table__cell--num">
        <bdi dir="ltr">{row.warningCount}</bdi>
      </td>
      <td>
        <button
          type="button"
          className="btn-secondary"
          onClick={onOpen}
          aria-label={t("redistribution.list.openLabel", { time: formatDateTime(row.createdAt) })}
        >
          {t("redistribution.list.open")}
        </button>
      </td>
    </tr>
  );
}

function ProposalTable({
  rows,
  onOpen,
}: Readonly<{
  rows: readonly RedistributionProposalSummary[];
  onOpen: (id: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <CaptionedTable caption={t("redistribution.list.caption")}>
      <thead>
        <tr>
          <th scope="col">{t("redistribution.list.col.created")}</th>
          <th scope="col">{t("redistribution.list.col.state")}</th>
          <th scope="col">{t("redistribution.list.col.objective")}</th>
          <th scope="col">{t("redistribution.list.col.excluded")}</th>
          <th scope="col">{t("redistribution.list.col.warnings")}</th>
          <th scope="col">
            <span className="sr-only">{t("redistribution.list.col.actions")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <ProposalRow key={row.id} row={row} onOpen={() => onOpen(row.id)} />
        ))}
      </tbody>
    </CaptionedTable>
  );
}

function useComputeAction(tenantId: string | null) {
  const navigate = useNavigate();
  const writes = useRedistributionWrites(tenantId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<RedistributionNotice | null>(null);
  const compute = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const outcome = await writes.compute();
    setBusy(false);
    if (outcome.kind === "ok") {
      const data = outcome.data;
      if ("id" in data) {
        navigate(`/inventory/redistribution/${data.id}`);
        return;
      }
      const replaced = data.supersededProposalId !== null;
      setNotice({
        variant: "info",
        messageKey: replaced
          ? "redistribution.compute.nothingReplaced"
          : "redistribution.compute.nothing",
      });
      return;
    }
    setNotice(noticeOf(outcome, "redistribution.compute.nothing"));
  };
  return { busy, notice, compute };
}

export function RedistributionList(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const { tenantId, roleAllowed, allowed } = useRedistributionScope();
  const list = useRedistributionList(tenantId, undefined, allowed);
  const action = useComputeAction(tenantId);

  if (!tenantId) return <ScopePrompt message={t("redistribution.scopePrompt")} />;
  if (!roleAllowed) return <NoAccess onSignOut={signOut} />;

  const off = !allowed || list.error?.kind === "notAvailable";
  const computeButton = off ? undefined : (
    <BusyButton
      type="button"
      className="btn-primary"
      busy={action.busy}
      onClick={() => void action.compute()}
    >
      {t("redistribution.compute.action")}
    </BusyButton>
  );
  return (
    <div className="surface redistribution">
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("redistribution.title")}
        subtitle={t("redistribution.sub")}
        actions={computeButton}
      />
      <p className="field__hint">{t("redistribution.note.advice")}</p>
      <NoticeBanner notice={action.notice} />
      {off ? (
        <ReadFailed error={allowed ? (list.error ?? NOT_AVAILABLE) : NOT_AVAILABLE} />
      ) : (
        <ListBody list={list} onOpen={(id) => navigate(`/inventory/redistribution/${id}`)} />
      )}
    </div>
  );
}

const NOT_AVAILABLE = { kind: "notAvailable" } as const;

function ListBody({
  list,
  onOpen,
}: Readonly<{
  list: ReturnType<typeof useRedistributionList>;
  onOpen: (id: string) => void;
}>): React.JSX.Element {
  const t = useT();
  if (list.error && list.rows.length === 0) {
    return <ReadFailed error={list.error} onRetry={list.retry} />;
  }
  if (list.isLoading) return <ListState state="loading" label={t("redistribution.list.label")} />;
  if (list.rows.length === 0) {
    return (
      <ListState
        state="empty"
        emptyMessage={t("redistribution.list.empty")}
        emptyHint={t("redistribution.list.emptyHint")}
      />
    );
  }
  return (
    <>
      <ProposalTable rows={list.rows} onOpen={onOpen} />
      {list.error ? <ReadFailed error={list.error} onRetry={list.retry} /> : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={t("redistribution.list.more")}
        onLoadMore={list.loadMore}
      />
    </>
  );
}
