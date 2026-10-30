/**
 * RT-587 sale detail sections (spec 012 J2). Each renders one block of the
 * detail projection exactly as served: lines in the server's order, tenders,
 * the void and returns summaries and the ERP posting state. A block the sale
 * never recorded says so; nothing is computed, filled or re-sorted here.
 *
 * RT-961: each block is a section panel (DESIGN.md §5). A table sits under its
 * panel header; money columns are end-aligned, and the lines are anchored by
 * the sale total exactly as served (not a sum of the lines).
 */
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { DateTime, type MessageKey, Money, roleKey, useT } from "@/i18n";
import type { SaleDetail, SaleLine, SaleReturn } from "@/lib/sale-queries";
import { BusinessDate, ErpChip } from "./SaleParts";
import { tenderMethodKey } from "./saleLogic";

/**
 * A detail table in RT-826's inline-axis scroll region, named by its caption:
 * a wide table scrolls inside it, never `.content` (RT-825, RT-785 D4).
 */
function ScrollTable({
  caption,
  children,
}: Readonly<{ caption: string; children: React.ReactNode }>): React.JSX.Element {
  const captionId = useCaptionId();
  return (
    <DataTableScroll captionId={captionId}>
      <table className="data-table">
        <caption id={captionId} className="data-table__caption">
          {caption}
        </caption>
        {children}
      </table>
    </DataTableScroll>
  );
}

export function Section({
  id,
  titleKey,
  children,
}: Readonly<{ id: string; titleKey: MessageKey; children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id={id} title={t(titleKey)}>
      <PanelBody>{children}</PanelBody>
    </DetailPanel>
  );
}

/** A ledger row (RT-961): `money` end-aligns an amount. */
export const Field = LedgerField;

/** Machine data (references, document ids), isolated LTR. */
function MachineText({ value }: Readonly<{ value: string }>): React.JSX.Element {
  return <bdi dir="ltr">{value}</bdi>;
}

function LineRow({ line }: Readonly<{ line: SaleLine }>): React.JSX.Element {
  const t = useT();
  const notRecorded = t("sales.value.notRecorded");
  return (
    <tr className="data-table__row data-table__row--static">
      <td>{line.sequence ?? notRecorded}</td>
      <th scope="row">
        <bdi dir="auto">{line.lineName}</bdi>
      </th>
      <td className="data-table__cell--num">
        <MachineText value={line.quantity} />
      </td>
      <td>
        <bdi dir="auto">{line.unit}</bdi>
      </td>
      <td className="data-table__cell--num">
        <Money value={line.unitPrice} currency={line.currencyCode} />
      </td>
      <td className="data-table__cell--num">
        <Money value={line.lineAmount} currency={line.currencyCode} />
      </td>
      <td className="data-table__cell--num">
        {line.taxAmount === null ? (
          notRecorded
        ) : (
          <Money value={line.taxAmount} currency={line.currencyCode} />
        )}
      </td>
      <td className="data-table__cell--num">
        <MachineText value={line.returnedQuantity} />
      </td>
    </tr>
  );
}

/** A column header; `num` marks a money or quantity column (end-aligned). */
interface Column {
  key: MessageKey;
  num?: boolean;
}

const LINE_COLUMNS: Column[] = [
  { key: "sales.lines.col.sequence" },
  { key: "sales.lines.col.name" },
  { key: "sales.lines.col.quantity", num: true },
  { key: "sales.lines.col.unit" },
  { key: "sales.lines.col.unitPrice", num: true },
  { key: "sales.lines.col.amount", num: true },
  { key: "sales.lines.col.tax", num: true },
  { key: "sales.lines.col.returned", num: true },
];
/** The line-amount column, under which the sale total is anchored. */
const LINE_AMOUNT_INDEX = 5;

function HeadRow({ columns }: Readonly<{ columns: Column[] }>): React.JSX.Element {
  const t = useT();
  return (
    <thead>
      <tr>
        {columns.map(({ key, num }) => (
          <th key={key} scope="col" className={num ? "data-table__cell--num" : undefined}>
            {t(key)}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/** The sale total as served, under the line-amount column. */
function LinesTotal({ detail }: Readonly<{ detail: SaleDetail }>): React.JSX.Element {
  const t = useT();
  const after = LINE_COLUMNS.length - LINE_AMOUNT_INDEX - 1;
  return (
    <tfoot>
      <tr className="data-table__total">
        <th scope="row" colSpan={LINE_AMOUNT_INDEX}>
          {t("sales.field.total")}
        </th>
        <td className="data-table__cell--num">
          <Money value={detail.summary.posTotal} currency={detail.summary.currencyCode} />
        </td>
        <td colSpan={after} />
      </tr>
    </tfoot>
  );
}

export function LinesSection({ detail }: Readonly<{ detail: SaleDetail }>): React.JSX.Element {
  const t = useT();
  const empty = detail.lines.length === 0;
  const unordered = detail.lineOrder === "not_recorded";
  return (
    <DetailPanel id="sale-lines" title={t("sales.section.lines")}>
      {unordered || empty ? (
        <PanelBody>
          {unordered ? <p className="content__sub">{t("sales.lines.orderNotRecorded")}</p> : null}
          {empty ? <p className="content__sub">{t("sales.lines.empty")}</p> : null}
        </PanelBody>
      ) : null}
      {empty ? null : (
        <ScrollTable caption={t("sales.lines.caption")}>
          <HeadRow columns={LINE_COLUMNS} />
          <tbody>
            {detail.lines.map((line) => (
              <LineRow key={line.lineRef} line={line} />
            ))}
          </tbody>
          <LinesTotal detail={detail} />
        </ScrollTable>
      )}
    </DetailPanel>
  );
}

const TENDER_COLUMNS: Column[] = [
  { key: "sales.payments.col.method" },
  { key: "sales.payments.col.amount", num: true },
  { key: "sales.payments.col.reference" },
];

export function PaymentsSection({ detail }: Readonly<{ detail: SaleDetail }>): React.JSX.Element {
  const t = useT();
  const currency = detail.summary.currencyCode;
  if (detail.tenderState === "unknown") {
    return (
      <Section id="sale-payments" titleKey="sales.section.payments">
        <p className="content__sub">{t("sales.payments.unknown")}</p>
      </Section>
    );
  }
  return (
    <DetailPanel id="sale-payments" title={t("sales.section.payments")}>
      <ScrollTable caption={t("sales.payments.caption")}>
        <HeadRow columns={TENDER_COLUMNS} />
        <tbody>
          {detail.tenders.map((tender, index) => (
            <tr
              key={`${tender.sequence ?? "x"}-${index}`}
              className="data-table__row data-table__row--static"
            >
              <td>{t(tenderMethodKey(tender))}</td>
              <td className="data-table__cell--num">
                <Money value={tender.amount} currency={currency} />
              </td>
              <td>{tender.reference ? <MachineText value={tender.reference} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      <PanelBody>
        {detail.changeGiven === null ? null : (
          <dl className="surface__detail">
            <Field label={t("sales.payments.changeGiven")} money>
              <Money value={detail.changeGiven} currency={currency} />
            </Field>
          </dl>
        )}
        <p className="content__sub">{t("sales.payments.netNote")}</p>
      </PanelBody>
    </DetailPanel>
  );
}

export function VoidSection({
  detail,
  timeZone,
}: Readonly<{ detail: SaleDetail; timeZone: string }>): React.JSX.Element {
  const t = useT();
  const voidSummary = detail.void;
  if (!voidSummary) {
    return (
      <Section id="sale-void" titleKey="sales.section.void">
        <p className="content__sub">{t("sales.void.none")}</p>
      </Section>
    );
  }
  const notRecorded = t("sales.value.notRecorded");
  return (
    <Section id="sale-void" titleKey="sales.section.void">
      <dl className="surface__detail">
        <Field label={t("sales.void.voidedAt")}>
          <DateTime value={voidSummary.voidedAt} timeZone={timeZone} />
        </Field>
        <Field label={t("sales.void.businessDate")}>
          {voidSummary.voidBusinessDate ? (
            <BusinessDate value={voidSummary.voidBusinessDate} />
          ) : (
            notRecorded
          )}
        </Field>
        <Field label={t("sales.void.approved")}>
          {t(voidSummary.approved ? "sales.void.approvedYes" : "sales.void.approvedNo")}
        </Field>
        <Field label={t("sales.void.approverRole")}>
          {voidSummary.approverRole ? t(roleKey(voidSummary.approverRole)) : notRecorded}
        </Field>
      </dl>
      <p className="content__sub">{t("sales.void.approverRoleNote")}</p>
    </Section>
  );
}

const RETURN_COLUMNS: Column[] = [
  { key: "sales.returns.col.item" },
  { key: "sales.returns.col.quantity", num: true },
  { key: "sales.returns.col.amount", num: true },
];

function ReturnBlock({
  entry,
  lineNames,
  currency,
  timeZone,
}: Readonly<{
  entry: SaleReturn;
  lineNames: ReadonlyMap<string, string>;
  currency: string;
  timeZone: string;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="sale-return">
      <dl className="surface__detail">
        <Field label={t("sales.returns.recordedAt")}>
          <DateTime value={entry.recordedAt} timeZone={timeZone} />
        </Field>
        <Field label={t("sales.returns.businessDate")}>
          <BusinessDate value={entry.businessDate} />
        </Field>
        <Field label={t("sales.returns.total")} money>
          <Money value={entry.returnTotal} currency={currency} />
        </Field>
      </dl>
      <ScrollTable caption={t("sales.returns.caption")}>
        <HeadRow columns={RETURN_COLUMNS} />
        <tbody>
          {entry.lines.map((returned) => (
            <tr key={returned.lineRef} className="data-table__row data-table__row--static">
              <th scope="row">
                <bdi dir="auto">
                  {lineNames.get(returned.lineRef) ?? t("sales.returns.unknownLine")}
                </bdi>
              </th>
              <td className="data-table__cell--num">
                <MachineText value={returned.quantity} />
              </td>
              <td className="data-table__cell--num">
                <Money value={returned.lineAmount} currency={currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
    </div>
  );
}

export function ReturnsSection({
  detail,
  timeZone,
}: Readonly<{ detail: SaleDetail; timeZone: string }>): React.JSX.Element {
  const t = useT();
  const lineNames = new Map(detail.lines.map((line) => [line.lineRef, line.lineName]));
  return (
    <Section id="sale-returns" titleKey="sales.section.returns">
      {detail.returns.length === 0 ? (
        <p className="content__sub">{t("sales.returns.empty")}</p>
      ) : (
        detail.returns.map((entry) => (
          <ReturnBlock
            key={entry.returnRef}
            entry={entry}
            lineNames={lineNames}
            currency={detail.summary.currencyCode}
            timeZone={timeZone}
          />
        ))
      )}
    </Section>
  );
}

/** A document id is shown only for a `posted` state (OD-534-5). */
function postedDocument(state: string, ref: string | null): string | null {
  return state === "posted" && ref ? ref : null;
}

export function ErpSection({ detail }: Readonly<{ detail: SaleDetail }>): React.JSX.Element {
  const t = useT();
  const erp = detail.erpPosting;
  const saleDocument = postedDocument(erp.sale, erp.saleDocumentRef);
  const reversalDocument = erp.reversal
    ? postedDocument(erp.reversal, erp.reversalDocumentRef)
    : null;
  return (
    <Section id="sale-erp" titleKey="sales.section.erp">
      <dl className="surface__detail">
        <Field label={t("sales.erp.sale")}>
          <ErpChip state={erp.sale} />
        </Field>
        {saleDocument ? (
          <Field label={t("sales.erp.saleDocument")}>
            <MachineText value={saleDocument} />
          </Field>
        ) : null}
        {erp.reversal ? (
          <Field label={t("sales.erp.reversal")}>
            <ErpChip state={erp.reversal} />
          </Field>
        ) : null}
        {reversalDocument ? (
          <Field label={t("sales.erp.reversalDocument")}>
            <MachineText value={reversalDocument} />
          </Field>
        ) : null}
      </dl>
      <p className="content__sub">{t("sales.erp.note")}</p>
    </Section>
  );
}
