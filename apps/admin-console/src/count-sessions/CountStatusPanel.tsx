/**
 * RT-1425 — the session's facts and, after approval, its ERP status. ERP status is
 * the session `state` the server serves (`posting`, `confirmed`, `needs_attention`)
 * and nothing else: no per-chunk detail, no ERPNext read, no activation toggle (the
 * contract has none). A state before approval shows no ERP line at all.
 */
import { Banner } from "@/components/Banner";
import { DetailPanel } from "@/components/DetailPanel";
import { DateTime, useT } from "@/i18n";
import { Machine } from "@/inventory/parts";
import type { CountSession } from "@/lib/count-session-queries";
import { StateBadge, usePersonLabel } from "./CountParts";
import { isErpState, isSelfApproved } from "./countLogic";

const ERP_KEYS = {
  posting: "counts.erp.posting",
  confirmed: "counts.erp.confirmed",
  needs_attention: "counts.erp.needs_attention",
} as const;

function ErpStatus({ state }: Readonly<{ state: string }>): React.JSX.Element | null {
  const t = useT();
  if (!isErpState(state)) return null;
  const key = ERP_KEYS[state as keyof typeof ERP_KEYS];
  const variant = state === "needs_attention" ? "danger" : state === "posting" ? "info" : "success";
  return (
    <div data-testid="count-erp-status">
      <Banner variant={variant} title={t("counts.erp.title")} message={t(key)} />
    </div>
  );
}

function Fact({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="counts__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function CountStatusPanel({
  session,
  index,
}: Readonly<{ session: CountSession; index: number }>): React.JSX.Element {
  const t = useT();
  const { approval, cancellation, cut } = session;
  const person = usePersonLabel([
    session.openedBy,
    session.submittedBy,
    approval?.approvedBy,
    cancellation?.cancelledBy,
    cut?.takenBy,
  ]);
  return (
    <DetailPanel id="count-status" index={index} title={t("counts.status.title")}>
      <div className="counts__body">
        <p className="counts__state">
          <StateBadge state={session.state} />
        </p>
        <ErpStatus state={session.state} />
        {isSelfApproved(session) ? (
          <div data-testid="count-self-approved">
            <Banner
              variant="warning"
              title={t("counts.selfApproved.title")}
              message={t("counts.selfApproved.message")}
            />
          </div>
        ) : null}
        <dl className="counts__facts">
          <Fact label={t("counts.fact.opened")}>
            {person(session.openedBy)} · <DateTime value={session.openedAt} />
          </Fact>
          {cut ? (
            <Fact label={t("counts.fact.cut")}>
              <DateTime value={cut.cutAt} /> · <Machine value={cut.watermark} />
            </Fact>
          ) : null}
          {session.submittedAt && session.submittedBy ? (
            <Fact label={t("counts.fact.submitted")}>
              {person(session.submittedBy)} · <DateTime value={session.submittedAt} />
            </Fact>
          ) : null}
          {approval ? (
            <Fact label={t("counts.fact.approved")}>
              {person(approval.approvedBy)} · <DateTime value={approval.approvedAt} /> ·{" "}
              {t(
                approval.policy === "small_merchant_exception"
                  ? "counts.policy.exception"
                  : "counts.policy.strict",
              )}
            </Fact>
          ) : null}
          {cancellation ? (
            <Fact label={t("counts.fact.cancelled")}>
              {person(cancellation.cancelledBy)} · <DateTime value={cancellation.cancelledAt} />
              {" · "}
              <bdi dir="auto">{cancellation.reason}</bdi>
            </Fact>
          ) : null}
          {session.note ? (
            <Fact label={t("counts.fact.note")}>
              <bdi dir="auto">{session.note}</bdi>
            </Fact>
          ) : null}
          <Fact label={t("counts.fact.products")}>{session.scope.productIds.length}</Fact>
          <Fact label={t("counts.fact.findings")}>{session.lateEventFindingCount}</Fact>
        </dl>
      </div>
    </DetailPanel>
  );
}
