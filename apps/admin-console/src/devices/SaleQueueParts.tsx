/**
 * RT-1312 presenters for the till's unsent sales: the list cell and the detail
 * Overview panel. Text carries every state (UX-02): Unknown («غير معروف») takes the
 * danger role and is never shown as 0 (DESIGN.md §3); unavailable (the health read
 * was refused or failed) is quiet text, since it is not a value the device sent.
 * A refused (dead-letter) or held count above zero is a danger flag. Every count
 * is as of the device's last stored heartbeat, and says so with that time.
 * No sale id, amount or cashier: the contract carries none.
 */
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { DateTime, type MessageKey, formatNumber, useT } from "@/i18n";
import type { SaleQueueState } from "./saleQueueLogic";
import "./devices.css";

type Counts = Extract<SaleQueueState, { kind: "counts" }>;
type NotCounts = Exclude<SaleQueueState, Counts>;

const STATE_KEYS: Record<NotCounts["kind"], MessageKey> = {
  loading: "devices.saleQueue.loading",
  unavailable: "devices.saleQueue.unavailable",
  unknown: "devices.saleQueue.unknown",
};

/** Loading, unavailable or Unknown as text; only Unknown takes the danger role. */
function StateText({ state }: Readonly<{ state: NotCounts }>): React.JSX.Element {
  const t = useT();
  const className = state.kind === "unknown" ? "device-flag device-flag--danger" : "device-quiet";
  return <span className={className}>{t(STATE_KEYS[state.kind])}</span>;
}

const flagIf = (count: number): string | undefined =>
  count > 0 ? "device-flag device-flag--danger" : undefined;

/** The list cell: three counts, then the oldest pending and as-of times. */
export function SaleQueueCell({
  state,
  timeZone,
}: Readonly<{ state: SaleQueueState; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  if (state.kind !== "counts") return <StateText state={state} />;
  return (
    <span className="device-name">
      <span>{t("devices.saleQueue.pending", { count: state.pending })}</span>
      <span className={flagIf(state.deadLetter)}>
        {t("devices.saleQueue.deadLetter", { count: state.deadLetter })}
      </span>
      <span className={flagIf(state.held)}>
        {t("devices.saleQueue.held", { count: state.held })}
      </span>
      {state.oldestPendingAt ? (
        <small className="device-quiet">
          {t.rich("devices.saleQueue.oldestPending", {
            time: <DateTime value={state.oldestPendingAt} timeZone={timeZone} />,
          })}
        </small>
      ) : null}
      <small className="device-quiet">
        {t.rich("devices.saleQueue.asOf", {
          time: <DateTime value={state.heartbeatAt} timeZone={timeZone} />,
        })}
      </small>
    </span>
  );
}

function Count({ value }: Readonly<{ value: number }>): React.JSX.Element {
  const className = flagIf(value);
  return className ? (
    <span className={className}>{formatNumber(value)}</span>
  ) : (
    <>{formatNumber(value)}</>
  );
}

function CountFields({
  state,
  timeZone,
}: Readonly<{ state: Counts; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <LedgerField label={t("devices.saleQueue.field.pending")}>
        {formatNumber(state.pending)}
      </LedgerField>
      <LedgerField label={t("devices.saleQueue.field.deadLetter")}>
        <Count value={state.deadLetter} />
      </LedgerField>
      <LedgerField label={t("devices.saleQueue.field.held")}>
        <Count value={state.held} />
      </LedgerField>
      <LedgerField label={t("devices.saleQueue.field.oldestPending")}>
        {state.oldestPendingAt ? (
          <DateTime value={state.oldestPendingAt} timeZone={timeZone} />
        ) : (
          <span className="device-quiet">{t("devices.saleQueue.nonePending")}</span>
        )}
      </LedgerField>
      <LedgerField label={t("devices.saleQueue.field.asOf")}>
        <DateTime value={state.heartbeatAt} timeZone={timeZone} />
      </LedgerField>
    </>
  );
}

/** The detail Overview panel. */
export function SaleQueuePanel({
  state,
  timeZone,
}: Readonly<{ state: SaleQueueState; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id="device-sale-queue" title={t("devices.saleQueue.title")}>
      <PanelBody>
        {state.kind === "counts" && state.attention ? (
          <p className="device-flag device-flag--danger">{t("devices.attention.strandedSales")}</p>
        ) : null}
        <dl className="surface__detail">
          {state.kind === "counts" ? (
            <CountFields state={state} timeZone={timeZone} />
          ) : (
            <LedgerField label={t("devices.saleQueue.field.state")}>
              <StateText state={state} />
            </LedgerField>
          )}
        </dl>
        <p className="content__sub">{t("devices.saleQueue.note")}</p>
      </PanelBody>
    </DetailPanel>
  );
}
