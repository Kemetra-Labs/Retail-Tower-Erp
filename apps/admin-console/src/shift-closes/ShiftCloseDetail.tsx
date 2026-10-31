import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import {
  DetailGrid,
  DetailPanel,
  LedgerField as Field,
  HeaderStatus,
  PanelBody,
} from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { ReceiptCard } from "@/components/ReceiptCard";
import {
  DateTime,
  type MessageKey,
  Money,
  formatEvidenceTime,
  formatNumber,
  useLocale,
  useT,
} from "@/i18n";
import type { ShiftCloseDetail as Detail, ShiftCashMovement } from "@/lib/shift-close-queries";
/**
 * RT-18 — One recorded shift close (read-only). The close fields exactly as the
 * API recorded them: the cash reconciliation (opening float, cash sales and
 * refunds, pay-ins and pay-outs, expected, counted) and the signed variance
 * (counted − expected), then the recorded approver, the cash movements and the
 * returns refunded in cash. Nothing is recomputed, edited or resolved here.
 *
 * The approver is attribution as the terminal sent it: not verified (the
 * persisted `approverCheck` is RT-384 / RT-385, not in the contract) and it
 * never changes the variance. Actors are bare ids: the contract carries no
 * names. A 404 is the API's uniform refusal and reads as not available.
 *
 * RT-961: the v3 detail template. The summary and the cash reconciliation sit
 * side by side as ledgers; the cash figures are end-aligned, expected and
 * counted read as the results they are, and the variance is the anchored total
 * (its direction still in words, never colour).
 */
import { Link, useLocation, useParams } from "react-router";
import { KindPill } from "./ShiftKindPill";
import { ShiftScopePrompt } from "./ShiftScopePrompt";
import { ShiftTimeBar } from "./ShiftTimeBar";
import { movementKindKey, reasonCodeKey, varianceDirectionKey } from "./shiftCloseLogic";
import {
  type ShiftCloseError,
  useShiftCloseDetail,
  useShiftCloseScope,
  useStoreOf,
} from "./useShiftCloses";
import "../shell/surface.css";
import "./shift-closes.css";

/** The list's search string (its filters), kept in navigation state by the list. */
function useBackSearch(): string {
  const state = useLocation().state as { list?: unknown } | null;
  const list = state?.list;
  return typeof list === "string" && list.startsWith("?") ? list : "";
}

function BackLink(): React.JSX.Element {
  const t = useT();
  return (
    <Link to={{ pathname: "/shift-closes", search: useBackSearch() }} className="surface__back">
      <BackArrow /> {t("shift.detail.back")}
    </Link>
  );
}

/** An actor or reference id: machine data, isolated LTR (UX-11). */
function MachineId({ value }: Readonly<{ value: string }>): React.JSX.Element {
  return <bdi dir="ltr">{value}</bdi>;
}

/**
 * A section panel named by its title; `table` puts the content edge to edge.
 * `index` is the section's position badge («01»…), decoration beside the title.
 */
function Section({
  id,
  titleKey,
  index,
  table,
  children,
}: Readonly<{
  id: string;
  titleKey: MessageKey;
  index: number;
  table?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id={id} title={t(titleKey)} index={index}>
      {table ? children : <PanelBody>{children}</PanelBody>}
    </DetailPanel>
  );
}

interface LoadedProps {
  detail: Detail;
  storeName?: string;
  timeZone?: string;
}

function SummarySection({ detail, storeName, timeZone }: Readonly<LoadedProps>): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  return (
    <Section id="shift-summary" titleKey="shift.detail.section.summary" index={1}>
      <dl className="surface__detail">
        <Field label={t("shift.field.store")}>{storeName ?? t("shift.list.unknownStore")}</Field>
        <Field label={t("shift.field.shiftId")} mono>
          <MachineId value={detail.shiftId} />
        </Field>
        {detail.forcedReason ? (
          <Field label={t("shift.field.forcedReason")}>
            <bdi dir="auto">{detail.forcedReason}</bdi>
          </Field>
        ) : null}
        <Field label={t("shift.field.openedAt")}>
          <DateTime value={detail.openedAt} timeZone={timeZone} />
        </Field>
        <Field label={t("shift.field.closedAt")}>
          <DateTime value={detail.closedAt} timeZone={timeZone} />
        </Field>
        <Field label={t("shift.field.receivedAt")}>
          <time dateTime={detail.receivedAt}>
            <bdi dir="ltr">{formatEvidenceTime(detail.receivedAt)}</bdi>
          </time>
        </Field>
        <Field label={t("shift.field.saleCount")}>{formatNumber(detail.saleCount, locale)}</Field>
        <Field label={t("shift.field.openingUser")} mono>
          <MachineId value={detail.openingUserId} />
        </Field>
        <Field label={t("shift.field.closingUser")} mono>
          <MachineId value={detail.closingUserId} />
        </Field>
        <Field label={t("shift.field.recordedBy")} mono>
          <MachineId value={detail.recordedByUserId} />
        </Field>
      </dl>
    </Section>
  );
}

/** How a figure enters the expected cash (the contract's arithmetic): a sign, never a sum. */
type LedgerSign = "·" | "+" | "−";

/**
 * RT-1015: the cash reconciliation as the receipt card. The signed variance as
 * served is the card's figure, its direction in words beside it; below the
 * perforation every other figure sits exactly as served. Nothing is computed
 * here: the sign marks are decoration (`aria-hidden`) for how the contract
 * builds the expected cash, and the labels stay the meaning.
 */
function CashSection({ detail }: Readonly<{ detail: Detail }>): React.JSX.Element {
  const t = useT();
  const currency = detail.currencyCode;
  const figures: [MessageKey, string, LedgerSign][] = [
    ["shift.field.openingFloat", detail.openingFloat, "·"],
    ["shift.field.cashSales", detail.cashSalesTotal, "+"],
    ["shift.field.cashRefunds", detail.cashRefundsTotal, "−"],
    ["shift.field.payIn", detail.payInTotal, "+"],
    ["shift.field.payOut", detail.payOutTotal, "−"],
  ];
  const results: [MessageKey, string][] = [
    ["shift.field.expected", detail.expectedCash],
    ["shift.field.counted", detail.countedCash],
  ];
  return (
    <ReceiptCard
      section
      index={2}
      label={t("shift.detail.section.cash")}
      figure={
        <span className="shift-receipt__figure">
          <span className="shift-receipt__figure-label">{t("shift.field.variance")}</span>
          <Money signed value={detail.variance} currency={currency} />
          <span className="shift-receipt__direction">{t(varianceDirectionKey(detail))}</span>
        </span>
      }
    >
      <div className="shift-ledger">
        <dl className="surface__detail">
          {figures.map(([key, value, sign]) => (
            <Field
              key={key}
              label={
                <>
                  <span className="shift-sign" aria-hidden="true">
                    {sign}
                  </span>
                  {t(key)}
                </>
              }
              money
            >
              <Money value={value} currency={currency} />
            </Field>
          ))}
          {results.map(([key, value]) => (
            <Field key={key} label={t(key)} money result>
              <Money value={value} currency={currency} />
            </Field>
          ))}
        </dl>
        <p className="shift-ledger__note">{t("shift.detail.cashServed")}</p>
      </div>
    </ReceiptCard>
  );
}

function ApprovalSection({ detail }: Readonly<{ detail: Detail }>): React.JSX.Element {
  const t = useT();
  const approver = detail.varianceApprovedByUserId;
  return (
    <Section id="shift-approval" titleKey="shift.detail.section.approval" index={4}>
      {approver ? (
        <dl className="surface__detail">
          <Field label={t("shift.field.approver")} mono>
            <MachineId value={approver} />
          </Field>
        </dl>
      ) : (
        <p className="content__sub">{t("shift.approval.none")}</p>
      )}
      <p className="content__sub">{t("shift.approval.note")}</p>
    </Section>
  );
}

function MovementRow({
  movement,
  currency,
  timeZone,
}: Readonly<{
  movement: ShiftCashMovement;
  currency: string;
  timeZone?: string;
}>): React.JSX.Element {
  const t = useT();
  return (
    <tr className="data-table__row data-table__row--static">
      <td>
        <DateTime value={movement.occurredAt} timeZone={timeZone} />
      </td>
      <td>{t(movementKindKey(movement))}</td>
      <td>{t(reasonCodeKey(movement))}</td>
      <td className="data-table__cell--num">
        <Money value={movement.amount} currency={currency} />
      </td>
      <td>{movement.note ? <bdi dir="auto">{movement.note}</bdi> : null}</td>
      <td className="data-table__cell--mono">
        <MachineId value={movement.recordedByUserId} />
      </td>
    </tr>
  );
}

function MovementsSection({
  detail,
  timeZone,
}: Readonly<{ detail: Detail; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  return (
    <Section
      id="shift-movements"
      titleKey="shift.detail.section.movements"
      index={3}
      table={detail.cashMovements.length > 0}
    >
      {detail.cashMovements.length === 0 ? (
        <p className="content__sub">{t("shift.movement.empty")}</p>
      ) : (
        <DataTableScroll captionId={captionId}>
          <table className="data-table data-table--strips">
            <caption id={captionId} className="data-table__caption">
              {t("shift.movement.caption")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("shift.movement.col.time")}</th>
                <th scope="col">{t("shift.movement.col.kind")}</th>
                <th scope="col">{t("shift.movement.col.reason")}</th>
                <th scope="col" className="data-table__cell--num">
                  {t("shift.movement.col.amount")}
                </th>
                <th scope="col">{t("shift.movement.col.note")}</th>
                <th scope="col">{t("shift.movement.col.recordedBy")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.cashMovements.map((m) => (
                <MovementRow
                  key={m.movementId}
                  movement={m}
                  currency={detail.currencyCode}
                  timeZone={timeZone}
                />
              ))}
            </tbody>
          </table>
        </DataTableScroll>
      )}
    </Section>
  );
}

function ReturnsSection({ refs }: Readonly<{ refs: readonly string[] }>): React.JSX.Element {
  const t = useT();
  return (
    <Section id="shift-returns" titleKey="shift.detail.section.returns" index={5}>
      {refs.length === 0 ? (
        <p className="content__sub">{t("shift.returns.empty")}</p>
      ) : (
        <ul className="shift-refs">
          {refs.map((ref) => (
            <li key={ref}>
              <MachineId value={ref} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Loaded({ detail, storeName, timeZone }: Readonly<LoadedProps>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface surface--shifts">
      <BackLink />
      <PageHeader
        title={t("shift.detail.title")}
        subtitle={t.rich("shift.detail.zoneNote", {
          zone: <bdi dir="ltr">{timeZone ?? "UTC"}</bdi>,
        })}
      >
        <HeaderStatus label={t("shift.field.kind")}>
          <KindPill close={detail} />
        </HeaderStatus>
      </PageHeader>
      <ShiftTimeBar detail={detail} timeZone={timeZone} />
      <DetailGrid>
        <SummarySection detail={detail} storeName={storeName} timeZone={timeZone} />
        <CashSection detail={detail} />
      </DetailGrid>
      <MovementsSection detail={detail} timeZone={timeZone} />
      <DetailGrid>
        <ApprovalSection detail={detail} />
        <ReturnsSection refs={detail.cashRefundReturnRefs} />
      </DetailGrid>
    </div>
  );
}

function ErrorView({
  error,
  onRetry,
}: Readonly<{ error: ShiftCloseError; onRetry: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface surface--shifts">
      {error.kind === "not-found" ? (
        <div className="section-panel">
          <ListState state="empty" emptyMessage={t("shift.detail.notFound")} />
        </div>
      ) : (
        <Banner
          variant="danger"
          message={t(
            error.kind === "session" ? "shift.list.sessionExpired" : "shift.detail.loadFailed",
          )}
          requestId={error.requestId}
          action={
            error.kind === "session" ? undefined : (
              <button type="button" className="btn-secondary" onClick={onRetry}>
                {t("shift.detail.retry")}
              </button>
            )
          }
        />
      )}
      <BackLink />
    </div>
  );
}

/** The close is read but its store's zone has not settled: hold the times back. */
function awaitingStore(detail: Detail | undefined, storeReady: boolean): boolean {
  return detail !== undefined && !storeReady;
}

export function ShiftCloseDetail(): React.JSX.Element {
  const t = useT();
  const scope = useShiftCloseScope();
  const { shiftId } = useParams();
  const { detail, isLoading, error, retry } = useShiftCloseDetail(scope, shiftId);
  const store = useStoreOf(detail?.storeId);

  if (!scope.tenantId) return <ShiftScopePrompt />;
  if (isLoading || awaitingStore(detail, store.ready)) {
    return (
      <div className="surface surface--shifts">
        <ListState state="loading" label={t("shift.detail.loadingNoun")} />
      </div>
    );
  }
  if (error) return <ErrorView error={error} onRetry={retry} />;
  if (!detail) return <div className="surface surface--shifts" />;
  return <Loaded detail={detail} storeName={store.name} timeZone={store.timeZone} />;
}
