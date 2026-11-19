/**
 * RT-1312 (Phase 3(b) slice B) — one sale the till could not send (`consoleGetQuarantinedSale`),
 * for owner / tenant_admin. The item's state, what the till recorded about the refusal, a minimal
 * summary of the stored sale (never the stored body: the server does not send it), and the one
 * guarded write, "Close without recording" (`consoleWriteOffQuarantinedSale`), offered only while
 * the server says the item is `open`.
 *
 * Repair (`consoleRepairQuarantinedSale`) is slice C and is not offered here; the page says so.
 * A state this build does not know is shown as unknown and offers nothing. Times are in the
 * item's store zone when the store is known (RT-401). A 404 is the API's uniform refusal and
 * reads as not found or not available, whatever the cause.
 *
 * Gate first: any other role gets NoAccess and nothing is requested. A malformed reference is
 * never sent.
 */
import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { DetailGrid, HeaderStatus } from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { DateTime, type T, useT } from "@/i18n";
import type { QuarantinedSale } from "@/lib/sale-quarantine-queries";
import { SyncOpsGate } from "@/sale-sync/SyncOpsGate";
import { Machine, ReadError, StaleError } from "@/sale-sync/parts";
import { isUuid } from "@/sale-sync/saleSyncLogic";
import type { SyncError } from "@/sale-sync/useSaleSync";
import { Field, Section } from "@/sales/SaleDetailSections";
import type { SaleScope } from "@/sales/useSales";
import { useStoreOf } from "@/shift-closes/useShiftCloses";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { WriteOffDialog } from "./WriteOffDialog";
import { QuarantineStateBadge, TillTotal } from "./parts";
import { canWriteOff, quarantineStateView, reasonKindKey } from "./quarantineLogic";
import { useQuarantinedSale } from "./useQuarantine";
import "../shell/surface.css";
import "../sale-sync/sale-sync.css";

interface Zoned {
  item: QuarantinedSale;
  timeZone?: string;
}

function BackLink(): React.JSX.Element {
  const t = useT();
  return (
    <Link to="/quarantined-sales" className="surface__back">
      <BackArrow /> {t("saleQuarantine.detail.back")}
    </Link>
  );
}

function notRecorded(t: T): React.JSX.Element {
  return <span className="muted">{t("saleQuarantine.value.notRecorded")}</span>;
}

function ItemSection({ item, timeZone }: Readonly<Zoned>): React.JSX.Element {
  const t = useT();
  const store = useStoreOf(item.storeId);
  const view = quarantineStateView(item.state);
  return (
    <Section id="quarantine-item" titleKey="saleQuarantine.section.item" index={1}>
      <dl className="surface__detail">
        <Field label={t("saleQuarantine.field.state")}>
          <QuarantineStateBadge code={item.state} />
          <p className="content__sub">{t(view.meaningKey)}</p>
        </Field>
        <Field label={t("saleQuarantine.field.store")}>
          {store.name ? <bdi dir="auto">{store.name}</bdi> : <Machine value={item.storeId} />}
        </Field>
        <Field label={t("saleQuarantine.field.device")}>
          <Link to={`/devices/${item.deviceId}`}>
            <Machine value={item.deviceId} />
          </Link>
        </Field>
        <Field label={t("saleQuarantine.field.source")}>
          <Machine value={item.sourceSystem} />
        </Field>
        <Field label={t("saleQuarantine.field.externalId")}>
          <Machine value={item.externalId} />
        </Field>
        <Field label={t("saleQuarantine.field.receivedAt")}>
          <DateTime value={item.receivedAt} timeZone={timeZone} />
        </Field>
      </dl>
    </Section>
  );
}

function TillSection({ item, timeZone }: Readonly<Zoned>): React.JSX.Element {
  const t = useT();
  return (
    <Section id="quarantine-till" titleKey="saleQuarantine.section.till" index={2}>
      <dl className="surface__detail">
        <Field label={t("saleQuarantine.field.reason")}>{t(reasonKindKey(item.reasonKind))}</Field>
        <Field label={t("saleQuarantine.field.tillStatus")}>
          {item.tillHttpStatus === null ? (
            notRecorded(t)
          ) : (
            <Machine value={`${item.tillHttpStatus}`} />
          )}
        </Field>
        <Field label={t("saleQuarantine.field.tillCode")}>
          {item.tillErrorCode ? <Machine value={item.tillErrorCode} /> : notRecorded(t)}
        </Field>
        <Field label={t("saleQuarantine.field.tillRecordedAt")}>
          <DateTime value={item.tillRecordedAt} timeZone={timeZone} />
        </Field>
        {item.previousTerminalId ? (
          <Field label={t("saleQuarantine.field.previousTerminal")}>
            <Link to={`/devices/${item.previousTerminalId}`}>
              <Machine value={item.previousTerminalId} />
            </Link>
          </Field>
        ) : null}
      </dl>
    </Section>
  );
}

function SaleSection({ item, timeZone }: Readonly<Zoned>): React.JSX.Element {
  const t = useT();
  const { summary } = item;
  return (
    <Section id="quarantine-sale" titleKey="saleQuarantine.section.sale" index={3}>
      <dl className="surface__detail">
        <Field label={t("saleQuarantine.field.occurredAt")}>
          {summary.occurredAt ? (
            <DateTime value={summary.occurredAt} timeZone={timeZone} />
          ) : (
            notRecorded(t)
          )}
        </Field>
        <Field label={t("saleQuarantine.field.total")} money>
          <TillTotal total={summary.posTotal} currency={summary.currencyCode} />
        </Field>
        <Field label={t("saleQuarantine.field.lineCount")}>
          {summary.lineCount === null ? notRecorded(t) : <bdi dir="ltr">{summary.lineCount}</bdi>}
        </Field>
      </dl>
      <p className="content__sub">{t("saleQuarantine.summary.hint")}</p>
    </Section>
  );
}

const LAST_REPAIR_KEYS = {
  captured: "saleQuarantine.lastRepair.captured",
  "already-captured": "saleQuarantine.lastRepair.alreadyCaptured",
  refused: "saleQuarantine.lastRepair.refused",
} as const;

function lastRepairLabel(t: T, outcome: string): string {
  return Object.hasOwn(LAST_REPAIR_KEYS, outcome)
    ? t(LAST_REPAIR_KEYS[outcome as keyof typeof LAST_REPAIR_KEYS])
    : t("saleQuarantine.lastRepair.unknown");
}

function HistoryFacts({ item, timeZone }: Readonly<Zoned>): React.JSX.Element {
  const t = useT();
  const { writeOff, lastRepair } = item;
  return (
    <dl className="surface__detail">
      <Field label={t("saleQuarantine.field.repairCount")}>
        <bdi dir="ltr">{item.repairCount}</bdi>
      </Field>
      {lastRepair ? (
        <Field label={t("saleQuarantine.field.lastRepair")}>
          {t.rich("saleQuarantine.lastRepair", {
            at: <DateTime value={lastRepair.at} timeZone={timeZone} />,
            outcome: lastRepairLabel(t, lastRepair.outcome),
          })}
        </Field>
      ) : null}
      {item.saleRef ? (
        <Field label={t("saleQuarantine.field.sale")}>
          <Link to={`/sales/${item.saleRef}`}>{t("saleQuarantine.value.openSale")}</Link>
        </Field>
      ) : null}
      {writeOff ? (
        <>
          <Field label={t("saleQuarantine.field.writtenOffAt")}>
            <DateTime value={writeOff.at} timeZone={timeZone} />
          </Field>
          <Field label={t("saleQuarantine.field.writeOffNote")}>
            <bdi dir="auto">{writeOff.note}</bdi>
          </Field>
        </>
      ) : null}
    </dl>
  );
}

function OpenHandling({
  onWriteOff,
  opener,
}: Readonly<{
  onWriteOff: () => void;
  opener: React.RefObject<HTMLButtonElement | null>;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="sale-sync__repair">
      <h3 className="sale-sync__subtitle">{t("saleQuarantine.writeOff.title")}</h3>
      <p className="content__sub">{t("saleQuarantine.handling.repairLater")}</p>
      <p className="content__sub">{t("saleQuarantine.writeOff.explain")}</p>
      <div>
        <button ref={opener} type="button" className="btn-danger-quiet" onClick={onWriteOff}>
          {t("saleQuarantine.writeOff.action")}
        </button>
      </div>
    </div>
  );
}

function HandlingSection({
  item,
  timeZone,
  scope,
  titleRef,
}: Readonly<
  Zoned & { scope: SaleScope; titleRef: React.RefObject<HTMLHeadingElement | null> }
>): React.JSX.Element {
  const t = useT();
  const [writing, setWriting] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const known = quarantineStateView(item.state).badge !== "badge--danger";
  const open = canWriteOff(item);

  // The control that opened the dialog goes when the item stops being open (a write-off, a 409, or
  // a re-read that found it closed): focus then moves to the page title, not to the body. The
  // dialog owns focus while it is up, so this waits for it to close.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (writing) return;
    const active = document.activeElement;
    if (wasOpen.current && !open && (active === null || active === document.body)) {
      titleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [writing, open, titleRef]);

  return (
    <Section id="quarantine-handling" titleKey="saleQuarantine.section.handling" index={4}>
      {open ? (
        <OpenHandling onWriteOff={() => setWriting(true)} opener={opener} />
      ) : (
        <p className="content__sub">
          {t(known ? "saleQuarantine.handling.closed" : "saleQuarantine.handling.unknownState")}
        </p>
      )}
      {known ? <HistoryFacts item={item} timeZone={timeZone} /> : null}
      {writing ? (
        <WriteOffDialog
          scope={scope}
          quarantineRef={item.quarantineRef}
          reference={item.externalId}
          onClose={() => setWriting(false)}
        />
      ) : null}
    </Section>
  );
}

function Loaded({
  item,
  scope,
  readFailure,
  onRetry,
}: Readonly<{
  item: QuarantinedSale;
  scope: SaleScope;
  /** A re-read failed while the earlier answer stays on screen. */
  readFailure: SyncError | undefined;
  onRetry: () => void;
}>): React.JSX.Element {
  const t = useT();
  const { timeZone } = useStoreOf(item.storeId);
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <div className="surface surface--v4">
      <BackLink />
      <PageHeader
        titleRef={titleRef}
        title={t.rich("saleQuarantine.detail.title", { ref: <Machine value={item.externalId} /> })}
      >
        <HeaderStatus label={t("saleQuarantine.field.state")}>
          <QuarantineStateBadge code={item.state} />
        </HeaderStatus>
      </PageHeader>
      <StaleError error={readFailure} onRetry={onRetry} />
      {item.uploadConflictCount > 0 ? (
        <Banner
          variant="warning"
          message={t("saleQuarantine.detail.uploadConflict", { count: item.uploadConflictCount })}
        />
      ) : null}
      <DetailGrid>
        <ItemSection item={item} timeZone={timeZone} />
        <TillSection item={item} timeZone={timeZone} />
      </DetailGrid>
      <DetailGrid>
        <SaleSection item={item} timeZone={timeZone} />
        <HandlingSection item={item} timeZone={timeZone} scope={scope} titleRef={titleRef} />
      </DetailGrid>
    </div>
  );
}

function Content({ scope }: Readonly<{ scope: SaleScope }>): React.JSX.Element {
  const t = useT();
  const { quarantineRef = "" } = useParams();
  const valid = isUuid(quarantineRef);
  const read = useQuarantinedSale({ scope, quarantineRef, enabled: valid });
  if (!valid) {
    return (
      <div className="surface">
        <ReadError
          error={{ kind: "not-found" }}
          failedKey="saleQuarantine.detail.loadFailed"
          notFoundKey="saleQuarantine.detail.notFound"
          onRetry={() => undefined}
        />
        <BackLink />
      </div>
    );
  }
  if (read.isLoading) {
    return (
      <div className="surface">
        <ListState state="loading" label={t("saleQuarantine.detail.loadingNoun")} />
      </div>
    );
  }
  // A failed first read, or a re-read that says 404 (the item is gone or out of scope now): the
  // earlier item is never kept on screen with an action beside it.
  const failure =
    read.error ?? (read.inlineError?.kind === "not-found" ? read.inlineError : undefined);
  if (failure) {
    return (
      <div className="surface">
        <ReadError
          error={failure}
          failedKey="saleQuarantine.detail.loadFailed"
          notFoundKey="saleQuarantine.detail.notFound"
          onRetry={read.retry}
        />
        <BackLink />
      </div>
    );
  }
  if (!read.data) return <div className="surface" />;
  return (
    <Loaded item={read.data} scope={scope} readFailure={read.inlineError} onRetry={read.retry} />
  );
}

export function QuarantineDetail(): React.JSX.Element {
  return (
    <SyncOpsGate promptKey="saleQuarantine.detail.scopePrompt">
      {(scope) => <Content scope={scope} />}
    </SyncOpsGate>
  );
}
