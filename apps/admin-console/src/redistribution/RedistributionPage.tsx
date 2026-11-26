/**
 * RT-1601 one redistribution proposal: its state and phase, the objective, each store's read time
 * and exclusion, the warnings, and the lines with their review decisions and accept outcomes.
 *
 * Shadow phase (`acceptEnabled` false): lines are marked "would accept" / "would reject"; nothing is
 * created. Live phase: chosen lines are accepted into W3 draft transfers (linked to the transfers
 * screen, which owns approval and dispatch). Reject ends the proposal with a reason. Every answer
 * that says the proposal moved re-reads it; the server's words never show, the request id does.
 */
import { NoAccess } from "@/auth/NoAccess";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ScopePrompt } from "@/components/ScopePrompt";
import { useT } from "@/i18n";
import { BackLink } from "@/inventory/parts";
import { useStoreNames } from "@/inventory/transfers/TransferParts";
import type {
  RedistributionAcceptResult,
  RedistributionProposal,
  RedistributionReviewDecisionValue,
} from "@/lib/redistribution-queries";
import { useProductNames } from "@/offers/useProductNames";
import { useSignOut } from "@/shell/useSignOut";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { AcceptDialog, AcceptResultSummary, RejectDialog } from "./RedistributionDecide";
import { RedistributionLines } from "./RedistributionLines";
import {
  NoticeBanner,
  ObjectiveFacts,
  ProposalStateBadge,
  ReadFailed,
  type RedistributionNotice,
  StoresTable,
  Time,
  WarningsList,
  noticeOf,
} from "./RedistributionParts";
import { acceptableLineIds, isDecidable } from "./redistributionLogic";
import {
  type RedistributionWrites,
  useRedistributionProposal,
  useRedistributionScope,
  useRedistributionWrites,
} from "./useRedistribution";
import "../shell/surface.css";
import "./redistribution.css";

type Dialog = "accept" | "reject" | null;

function useLineDecisions(proposal: RedistributionProposal, writes: RedistributionWrites) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [notice, setNotice] = useState<RedistributionNotice | null>(null);
  const open = new Set(acceptableLineIds(proposal));
  const chosen = [...selected].filter((id) => open.has(id));
  const toggle = (lineId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };
  const review = async (lineId: string, decision: RedistributionReviewDecisionValue) => {
    setReviewing(lineId);
    const outcome = await writes.review(proposal.id, [{ lineId, decision }]);
    setReviewing(null);
    setNotice(outcome.kind === "ok" ? null : noticeOf(outcome, "redistribution.review.done"));
  };
  return {
    chosen,
    selected,
    toggle,
    reviewing,
    review,
    notice,
    clear: () => setSelected(new Set()),
  };
}

function ProposalBody({
  proposal,
  tenantId,
}: Readonly<{ proposal: RedistributionProposal; tenantId: string }>): React.JSX.Element {
  const t = useT();
  const writes = useRedistributionWrites(tenantId);
  const storeNames = useStoreNames(tenantId);
  const products = useProductNames(
    tenantId,
    [...new Set(proposal.lines.map((l) => l.productId))],
    {},
  );
  const lines = useLineDecisions(proposal, writes);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [accepted, setAccepted] = useState<RedistributionAcceptResult | null>(null);
  const [notice, setNotice] = useState<RedistributionNotice | null>(null);
  const decidable = isDecidable(proposal.state);
  const linesHeading = useRef<HTMLHeadingElement>(null);
  // The opener may be gone once a decision ends the proposal: focus lands on the lines (UX-11.8).
  const afterDialog = (): void => {
    setDialog(null);
    requestAnimationFrame(() => linesHeading.current?.focus());
  };
  return (
    <>
      <p className="field__hint">
        {t(proposal.acceptEnabled ? "redistribution.phase.live" : "redistribution.phase.shadow")}
      </p>
      <dl className="redistribution__facts">
        <div>
          <dt>{t("redistribution.detail.computedAt")}</dt>
          <dd>
            <Time iso={proposal.computedAt} />
          </dd>
        </div>
        <div>
          <dt>{t("redistribution.detail.expiresAt")}</dt>
          <dd>
            <Time iso={proposal.expiresAt} />
          </dd>
        </div>
      </dl>
      <ObjectiveFacts objective={proposal.objective} />
      {proposal.rejectReason ? (
        <p>{t("redistribution.detail.rejectReason", { reason: proposal.rejectReason })}</p>
      ) : null}
      <NoticeBanner notice={notice ?? lines.notice} />
      {accepted ? <AcceptResultSummary result={accepted} /> : null}
      <h2 className="redistribution__heading" ref={linesHeading} tabIndex={-1}>
        {t("redistribution.lines.title")}
      </h2>
      {decidable ? (
        <div className="redistribution__actions">
          {proposal.acceptEnabled ? (
            <button
              type="button"
              className="btn-primary"
              disabled={lines.chosen.length === 0 || lines.reviewing !== null}
              onClick={() => setDialog("accept")}
            >
              {lines.chosen.length === 0
                ? t("redistribution.accept.openNone")
                : t("redistribution.accept.open", { count: lines.chosen.length })}
            </button>
          ) : null}
          <button
            type="button"
            className="btn-danger-quiet"
            disabled={lines.reviewing !== null}
            onClick={() => setDialog("reject")}
          >
            {t("redistribution.reject.open")}
          </button>
        </div>
      ) : null}
      <RedistributionLines
        proposal={proposal}
        storeNames={storeNames}
        productName={products.nameOf}
        selected={lines.selected}
        onToggle={lines.toggle}
        reviewing={lines.reviewing}
        onReview={(id, decision) => void lines.review(id, decision)}
      />
      <h2 className="redistribution__heading">{t("redistribution.stores.title")}</h2>
      <StoresTable stores={proposal.stores} names={storeNames} />
      <h2 className="redistribution__heading">{t("redistribution.warnings.title")}</h2>
      <WarningsList warnings={proposal.warnings} names={storeNames} />
      {dialog === "accept" ? (
        <AcceptDialog
          proposalId={proposal.id}
          lineIds={lines.chosen}
          writes={writes}
          onClose={(result) => {
            afterDialog();
            if (result) {
              setAccepted(result);
              lines.clear();
            }
          }}
        />
      ) : null}
      {dialog === "reject" ? (
        <RejectDialog
          proposalId={proposal.id}
          writes={writes}
          onClose={(rejected) => {
            afterDialog();
            if (rejected)
              setNotice({ variant: "success", messageKey: "redistribution.reject.done" });
          }}
        />
      ) : null}
    </>
  );
}

export function RedistributionPage(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const { proposalId } = useParams();
  const { tenantId, roleAllowed, allowed } = useRedistributionScope();
  const read = useRedistributionProposal(tenantId, proposalId, allowed);

  if (!tenantId) return <ScopePrompt message={t("redistribution.scopePrompt")} />;
  if (!roleAllowed) return <NoAccess onSignOut={signOut} />;
  const error = allowed ? read.error : ({ kind: "notAvailable" } as const);
  // A 404 hides a proposal cached from an earlier read, with its decision controls.
  const proposal = error?.kind === "notAvailable" ? undefined : read.proposal;
  return (
    <div className="surface redistribution">
      <BackLink to="/inventory/redistribution" label={t("redistribution.back")} />
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("redistribution.detail.title")}
        actions={proposal ? <ProposalStateBadge state={proposal.state} /> : undefined}
      />
      {error ? (
        <ReadFailed
          error={error}
          onRetry={read.reload}
          notAvailableKey="redistribution.error.notAvailable"
        />
      ) : null}
      {read.isLoading ? <output className="content__sub">{t("common.loading")}</output> : null}
      {proposal ? (
        <ProposalBody key={`${tenantId}:${proposal.id}`} proposal={proposal} tenantId={tenantId} />
      ) : null}
    </div>
  );
}
