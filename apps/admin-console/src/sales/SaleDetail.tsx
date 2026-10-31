import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { DetailGrid } from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { DateTime, Money, useT } from "@/i18n";
import type { SaleDetail as Detail } from "@/lib/sale-queries";
import { SaleSyncSections } from "@/sale-sync/SaleSyncSections";
import { useStoreOf } from "@/shift-closes/useShiftCloses";
/**
 * RT-587 — One sale (spec 012 J2, read-only). Only what the detail projection
 * returns: the header facts, the receipt header captured with the sale, the
 * lines, payments, void and returns summaries, and the ERP posting state.
 * Times are in the store zone the server reports; business dates are calendar
 * days fixed at capture. A missing fact says "not recorded". No write, reprint
 * or repair is offered (FR-010). A 404 is the API's uniform refusal and reads
 * as not found or not available, whatever the cause.
 *
 * RT-726: for owner / tenant_admin the page also hosts the sale sync-ops
 * sections (`src/sale-sync/`): the server sync status, the sync timeline and
 * the guarded repair request. This module itself still reads only.
 *
 * RT-961: the v3 detail template. The back link, the page header with the
 * status chips, then the ledger panels two to a row (the sale beside its
 * payments), the lines and returns full width, and the remaining ledgers.
 * RT-974: a failed ERPNext posting adds a state-only banner under the header.
 *
 * RT-1009 (v4.0 «Ink & Receipt»): the Sales surface opts into the v4 panel and
 * pill shapes (`surface--v4`); the sections carry their index badges in reading
 * order («01» the sale … «08» related screens); the payments are the receipt
 * card. The role-gated sync sections (another module) stay unnumbered.
 */
import { Link, useLocation, useParams } from "react-router";
import { ErpFailureBanner } from "./ErpFailureBanner";
import {
  ErpSection,
  Field,
  LinesSection,
  PaymentsSection,
  ReturnsSection,
  Section,
  VoidSection,
} from "./SaleDetailSections";
import { BusinessDate, DeviceName, RecordedName, SaleNumber, StatusChips } from "./SaleParts";
import { shiftClosesHref } from "./saleLogic";
import { type SaleError, useSaleDetail, useSaleScope } from "./useSales";
import "../shell/surface.css";
import "./sales.css";

/** The list's search string (its filters), kept in navigation state by the list. */
function useBackSearch(): string {
  const state = useLocation().state as { list?: unknown } | null;
  const list = state?.list;
  return typeof list === "string" && list.startsWith("?") ? list : "";
}

function BackLink(): React.JSX.Element {
  const t = useT();
  return (
    <Link to={{ pathname: "/sales", search: useBackSearch() }} className="surface__back">
      <BackArrow /> {t("sales.detail.back")}
    </Link>
  );
}

function StoreName({ storeRef }: Readonly<{ storeRef: string }>): React.JSX.Element {
  const t = useT();
  const store = useStoreOf(storeRef);
  if (store.name) return <bdi dir="auto">{store.name}</bdi>;
  return <>{store.ready ? t("sales.unknownStore") : null}</>;
}

function SummarySection({ detail }: Readonly<{ detail: Detail }>): React.JSX.Element {
  const t = useT();
  const sale = detail.summary;
  const zone = detail.storeTimezone;
  const notRecorded = t("sales.value.notRecorded");
  return (
    <Section id="sale-summary" titleKey="sales.section.summary" index={1}>
      <dl className="surface__detail">
        <Field label={t("sales.field.saleNumber")}>
          <SaleNumber value={sale.saleNumber} />
        </Field>
        <Field label={t("sales.field.receiptNumber")}>
          <SaleNumber value={detail.receiptNumber} />
        </Field>
        <Field label={t("sales.field.businessDate")}>
          <BusinessDate value={sale.businessDate} />
        </Field>
        <Field label={t("sales.field.occurredAt")}>
          <DateTime value={sale.occurredAt} timeZone={zone} />
        </Field>
        <Field label={t("sales.field.receivedAt")}>
          <DateTime value={sale.receivedAt} timeZone={zone} />
        </Field>
        <Field label={t("sales.field.settledAt")}>
          {detail.settledAt ? <DateTime value={detail.settledAt} timeZone={zone} /> : notRecorded}
        </Field>
        <Field label={t("sales.field.store")}>
          <StoreName storeRef={sale.storeRef} />
        </Field>
        <Field label={t("sales.field.device")}>
          <DeviceName device={sale.device} />
        </Field>
        <Field label={t("sales.field.operator")}>
          <RecordedName name={sale.operator.displayName} source={sale.operator.nameSource} />
        </Field>
        <Field label={t("sales.field.total")} money>
          <Money value={sale.posTotal} currency={sale.currencyCode} />
        </Field>
      </dl>
    </Section>
  );
}

function ReceiptHeaderSection({ detail }: Readonly<{ detail: Detail }>): React.JSX.Element {
  const t = useT();
  const header = detail.receiptHeader;
  return (
    <Section id="sale-receipt-header" titleKey="sales.section.receiptHeader" index={7}>
      {header ? (
        <dl className="surface__detail">
          <Field label={t("sales.field.branchName")}>
            <bdi dir="auto">{header.branchName}</bdi>
          </Field>
          <Field label={t("sales.field.branchAddress")}>
            <bdi dir="auto">{header.branchAddress}</bdi>
          </Field>
          <Field label={t("sales.field.taxRegistrationId")}>
            <bdi dir="ltr">{header.taxRegistrationId}</bdi>
          </Field>
        </dl>
      ) : (
        <p className="content__sub">{t("sales.detail.missing")}</p>
      )}
    </Section>
  );
}

/** Links out (spec 012 §7); this screen never re-renders another screen's data. */
function RelatedSection({ detail }: Readonly<{ detail: Detail }>): React.JSX.Element {
  const t = useT();
  const { storeRef, businessDate } = detail.summary;
  return (
    <Section id="sale-related" titleKey="sales.section.related" index={8}>
      <ul className="sale-related">
        <li>
          <Link to={shiftClosesHref({ storeRef, businessDate })}>
            {t("sales.related.shiftCloses")}
          </Link>
        </li>
      </ul>
    </Section>
  );
}

function Loaded({ detail }: Readonly<{ detail: Detail }>): React.JSX.Element {
  const t = useT();
  const { role } = useSaleScope();
  const number = detail.summary.saleNumber;
  return (
    <div className="surface surface--v4">
      <BackLink />
      <PageHeader
        title={
          number
            ? t.rich("sales.detail.title", { number: <SaleNumber value={number} /> })
            : t("sales.detail.titleNoNumber")
        }
      >
        <StatusChips sale={detail.summary} />
        <p className="content__sub">
          {t.rich("sales.detail.zoneNote", {
            zone: <bdi dir="ltr">{detail.storeTimezone}</bdi>,
          })}
        </p>
      </PageHeader>
      <ErpFailureBanner detail={detail} role={role} />
      <DetailGrid>
        <SummarySection detail={detail} />
        <PaymentsSection detail={detail} index={2} />
      </DetailGrid>
      <LinesSection detail={detail} index={3} />
      <ReturnsSection detail={detail} timeZone={detail.storeTimezone} index={4} />
      <DetailGrid>
        <ErpSection detail={detail} index={5} />
        <VoidSection detail={detail} timeZone={detail.storeTimezone} index={6} />
        <SaleSyncSections saleRef={detail.summary.saleRef} timeZone={detail.storeTimezone} />
        <ReceiptHeaderSection detail={detail} />
        <RelatedSection detail={detail} />
      </DetailGrid>
    </div>
  );
}

function ErrorView({
  error,
  onRetry,
}: Readonly<{ error: SaleError; onRetry: () => void }>): React.JSX.Element {
  const t = useT();
  if (error.kind === "not-found") {
    return (
      <div className="surface">
        <ListState state="empty" emptyMessage={t("sales.detail.notFound")} />
        <BackLink />
      </div>
    );
  }
  const session = error.kind === "session";
  return (
    <div className="surface">
      <Banner
        variant="danger"
        message={t(session ? "sales.list.sessionExpired" : "sales.detail.loadFailed")}
        requestId={error.requestId}
        action={
          session ? undefined : (
            <button type="button" className="btn-secondary" onClick={onRetry}>
              {t("sales.detail.retry")}
            </button>
          )
        }
      />
      <BackLink />
    </div>
  );
}

export function SaleDetail(): React.JSX.Element {
  const t = useT();
  const scope = useSaleScope();
  const { saleRef } = useParams();
  const { detail, isLoading, error, retry } = useSaleDetail(scope, saleRef);

  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("sales.list.scopePrompt")}</p>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="surface">
        <ListState state="loading" label={t("sales.detail.loadingNoun")} />
      </div>
    );
  }
  if (error) return <ErrorView error={error} onRetry={retry} />;
  if (!detail) return <div className="surface" />;
  return <Loaded detail={detail} />;
}
