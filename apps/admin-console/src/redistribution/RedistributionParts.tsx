/**
 * RT-1601 small parts shared by the redistribution list and proposal screens: the state badge, the
 * objective facts, the per-store read times and exclusions, the warnings, a line's accept outcome
 * and the non-disclosing read error. Every figure is shown as Backend-Core sent it (exact-decimal
 * strings, never parsed); every code reads through the catalog, an unknown one generically.
 */
import { Banner } from "@/components/Banner";
import { type MessageKey, useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { Machine, Quantity, RetryButton } from "@/inventory/parts";
import { CaptionedTable, StoreName } from "@/inventory/transfers/TransferParts";
import type {
  RedistributionAcceptOutcome,
  RedistributionProposal,
  RedistributionWarning,
} from "@/lib/redistribution-queries";
import { Link } from "react-router";
import {
  dropReasonKey,
  exclusionKey,
  stateBadgeClass,
  stateKey,
  warningKey,
} from "./redistributionLogic";
import type { RedistributionOutcome } from "./redistributionOutcomes";
import type { RedistributionReadError } from "./useRedistribution";

export function ProposalStateBadge({ state }: Readonly<{ state: string }>): React.JSX.Element {
  const t = useT();
  return <span className={stateBadgeClass(state)}>{t(stateKey(state))}</span>;
}

export function Time({ iso }: Readonly<{ iso: string }>): React.JSX.Element {
  return (
    <time dateTime={iso}>
      <bdi dir="ltr">{formatDateTime(iso)}</bdi>
    </time>
  );
}

/** Deficit before → after, store pairs and lines: the plan's size, as computed. */
export function ObjectiveFacts({
  objective,
}: Readonly<{ objective: RedistributionProposal["objective"] }>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="redistribution__facts">
      <div>
        <dt>{t("redistribution.objective.before")}</dt>
        <dd>
          <Quantity value={objective.deficitBefore} />
        </dd>
      </div>
      <div>
        <dt>{t("redistribution.objective.after")}</dt>
        <dd>
          <Quantity value={objective.deficitAfter} />
        </dd>
      </div>
      <div>
        <dt>{t("redistribution.objective.pairs")}</dt>
        <dd>
          <bdi dir="ltr">{objective.storePairs}</bdi>
        </dd>
      </div>
      <div>
        <dt>{t("redistribution.objective.lines")}</dt>
        <dd>
          <bdi dir="ltr">{objective.lines}</bdi>
        </dd>
      </div>
    </dl>
  );
}

/** Each store's read time and, when it may not give stock, why. */
export function StoresTable({
  stores,
  names,
}: Readonly<{
  stores: RedistributionProposal["stores"];
  names: ReadonlyMap<string, string>;
}>): React.JSX.Element {
  const t = useT();
  return (
    <CaptionedTable caption={t("redistribution.stores.caption")}>
      <thead>
        <tr>
          <th scope="col">{t("redistribution.stores.col.store")}</th>
          <th scope="col">{t("redistribution.stores.col.readAt")}</th>
          <th scope="col">{t("redistribution.stores.col.source")}</th>
        </tr>
      </thead>
      <tbody>
        {stores.map((store) => (
          <tr key={store.storeId} className="data-table__row">
            <td>
              <StoreName id={store.storeId} names={names} />
            </td>
            <td>
              <Time iso={store.readAt} />
            </td>
            <td>
              {store.exclusion ? (
                <span className="badge badge--warning">{t(exclusionKey(store.exclusion))}</span>
              ) : (
                t(
                  store.eligibleAsSource
                    ? "redistribution.stores.eligible"
                    : "redistribution.stores.notEligible",
                )
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </CaptionedTable>
  );
}

/** The compute's warnings, one line each; none means a quiet note, never an empty box. */
export function WarningsList({
  warnings,
  names,
}: Readonly<{
  warnings: readonly RedistributionWarning[];
  names: ReadonlyMap<string, string>;
}>): React.JSX.Element {
  const t = useT();
  if (warnings.length === 0) {
    return <p className="field__hint">{t("redistribution.warnings.none")}</p>;
  }
  return (
    <ul className="redistribution__warnings">
      {warnings.map((w, i) => (
        <li key={`${w.code}-${w.storeId ?? ""}-${w.productId ?? ""}-${i}`}>
          {t(warningKey(w.code))}
          {w.storeId ? (
            <>
              {" · "}
              <StoreName id={w.storeId} names={names} />
            </>
          ) : null}
          {w.count ? (
            <>
              {" · "}
              {t("redistribution.warnings.count", { count: w.count })}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const OUTCOME_KEYS: Record<string, MessageKey> = {
  created: "redistribution.outcome.created",
  reduced: "redistribution.outcome.reduced",
  dropped: "redistribution.outcome.dropped",
};

/** A line's accept outcome: the created quantity, the draft transfer, or why it was dropped. */
export function OutcomeCell({
  outcome,
}: Readonly<{ outcome: RedistributionAcceptOutcome }>): React.JSX.Element {
  const t = useT();
  const badge = outcome.outcome === "dropped" ? "badge badge--warning" : "badge badge--success";
  return (
    <div className="redistribution__outcome">
      <span className={badge}>
        {t(OUTCOME_KEYS[outcome.outcome] ?? "redistribution.state.unknown")}
      </span>
      {outcome.createdQuantity ? (
        <span>
          {t("redistribution.outcome.quantity")} <Quantity value={outcome.createdQuantity} />
        </span>
      ) : null}
      {outcome.reason ? <span>{t(dropReasonKey(outcome.reason))}</span> : null}
      {outcome.transferId ? <TransferLink id={outcome.transferId} /> : null}
    </div>
  );
}

/** A created draft transfer: its id, linked to the transfers list that owns approval and dispatch. */
export function TransferLink({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const t = useT();
  return (
    <Link to="/inventory/transfers" aria-label={t("redistribution.transfer.openLabel", { id })}>
      <Machine value={id} />
    </Link>
  );
}

const READ_COPY: Record<RedistributionReadError["kind"], MessageKey> = {
  session: "redistribution.error.session",
  notAvailable: "redistribution.notAvailable",
  generic: "redistribution.error.loadFailed",
};

/** A read that failed with nothing on screen. The 404 never says why (feature off, scope or gone). */
export function ReadFailed({
  error,
  onRetry,
}: Readonly<{ error: RedistributionReadError; onRetry?: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <Banner
      variant={error.kind === "notAvailable" ? "info" : "danger"}
      message={t(READ_COPY[error.kind])}
      requestId={error.requestId}
      action={error.kind === "generic" && onRetry ? <RetryButton onRetry={onRetry} /> : undefined}
    />
  );
}

/** The banner after a command: what happened, in catalog copy, with the request id. */
export interface RedistributionNotice {
  variant: "success" | "warning" | "danger" | "info";
  messageKey: MessageKey;
  params?: Record<string, string | number>;
  requestId?: string;
}

export function noticeOf(
  outcome: RedistributionOutcome<unknown>,
  okKey: MessageKey,
  params?: Record<string, string | number>,
): RedistributionNotice {
  if (outcome.kind === "ok") return { variant: "success", messageKey: okKey, params };
  return {
    variant: outcome.keepKey ? "warning" : "danger",
    messageKey: outcome.messageKey,
    requestId: outcome.requestId,
  };
}

export function NoticeBanner({
  notice,
}: Readonly<{ notice: RedistributionNotice | null }>): React.JSX.Element | null {
  const t = useT();
  if (!notice) return null;
  return (
    <Banner
      variant={notice.variant}
      message={t(notice.messageKey, notice.params)}
      requestId={notice.requestId}
    />
  );
}
