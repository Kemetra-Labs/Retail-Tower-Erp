/**
 * RT-1541: renders the strictly typed `answer` of the Manager Sales Ask/Explain contract
 * (RT-1526 §5, U-3 .. U-5b).
 *
 * The first line restates scope and period (X-2). Statements and tables are rendered from typed
 * slots and cells: every figure is the server's value, formatted for locale and currency only
 * (never summed, converted or rounded), with a citation chip into the read-only source list
 * (X-4). Untrusted text (a store name, a label) is rendered as text in `<bdi>`, never as markup.
 * No chart, no colour for direction, no count-up.
 */
import { DateTime, Money, formatNumber, useT } from "@/i18n";
import type { MessageKey } from "@/i18n";
import type {
  AnswerBlock,
  ManagerSalesAnswer,
  StatementBlock,
  TableBlock,
  TableCell,
} from "@/lib/ai-manager-sales-queries";
import { BusinessDate, BusinessDateRange } from "@/sales/SaleParts";
import { useRef } from "react";
import {
  COLUMN_COPY,
  GAP_COPY,
  NOTICE_COPY,
  OPERATION_COPY,
  type StoreOption,
  cellKind,
  citationNumbers,
  earliestAsOf,
  figuresByRef,
  orderedNotices,
  plainName,
} from "./managerSalesLogic";

interface AnswerContextProps {
  answer: ManagerSalesAnswer;
  stores: readonly StoreOption[];
}

/** A column or slot name: catalogue copy when known, else machine text (never hidden). */
function Label({ name }: Readonly<{ name: string }>): React.JSX.Element {
  const t = useT();
  const key = COLUMN_COPY[name];
  return key ? <>{t(key)}</> : <bdi dir="ltr">{plainName(name)}</bdi>;
}

function Figure({ cell }: Readonly<{ cell: TableCell }>): React.JSX.Element {
  const t = useT();
  switch (cellKind(cell)) {
    case "count":
      return <span className="ams-num">{formatNumber(cell.value as number, t.locale)}</span>;
    case "money":
      return <Money value={cell.value as string} currency={cell.currency} className="ams-num" />;
    case "ratio":
      // A ratio is shown exactly as the server served it (four digits), never as a computed percent.
      return (
        <bdi dir="ltr" className="ams-num">
          {cell.value as string}
        </bdi>
      );
    case "date":
      return <BusinessDate value={cell.value as string} />;
    default:
      return <bdi>{plainName(String(cell.value))}</bdi>;
  }
}

function CiteChip({
  n,
  onOpen,
}: Readonly<{ n: number | undefined; onOpen: (n: number) => void }>): React.JSX.Element | null {
  const t = useT();
  if (n === undefined) return null;
  return (
    <button
      type="button"
      className="ams-cite"
      aria-label={t("aiManagerSales.cite.open", { n })}
      onClick={() => onOpen(n)}
    >
      <span aria-hidden="true">{formatNumber(n, t.locale)}</span>
    </button>
  );
}

function Statement({
  block,
  figures,
  numbers,
  onOpen,
}: Readonly<{
  block: StatementBlock;
  figures: Map<string, TableCell>;
  numbers: Map<string, number>;
  onOpen: (n: number) => void;
}>): React.JSX.Element {
  const t = useT();
  const slots = Object.entries(block.slots);
  return (
    <dl className="ams-statement">
      {slots.map(([name, slot]) => {
        const figure = figures.get(slot.ref);
        return (
          <div key={name} className="ams-statement__row">
            <dt>
              <Label name={name} />
            </dt>
            <dd>
              {figure ? <Figure cell={figure} /> : t("aiManagerSales.figure.seeSource")}
              <CiteChip n={numbers.get(slot.ref)} onOpen={onOpen} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Table({
  block,
  numbers,
  onOpen,
}: Readonly<{
  block: TableBlock;
  numbers: Map<string, number>;
  onOpen: (n: number) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be keyboard-focusable
    <section className="ams-table-wrap" aria-label={t("aiManagerSales.table.region")} tabIndex={0}>
      <table className="ams-table">
        <caption className="sr-only">{t("aiManagerSales.table.caption")}</caption>
        <thead>
          <tr>
            {block.columns.map((column, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional; a key may repeat
              <th key={`${column}-${i}`} scope="col">
                <Label name={column} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, as the server ordered them
            <tr key={r}>
              {row.map((cell, c) =>
                c === 0 ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  <th key={c} scope="row">
                    <Figure cell={cell} />
                    <CiteChip n={numbers.get(cell.ref)} onOpen={onOpen} />
                  </th>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  <td key={c}>
                    <Figure cell={cell} />
                    <CiteChip n={numbers.get(cell.ref)} onOpen={onOpen} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Blocks({
  blocks,
  numbers,
  onOpen,
}: Readonly<{
  blocks: readonly AnswerBlock[];
  numbers: Map<string, number>;
  onOpen: (n: number) => void;
}>): React.JSX.Element {
  const figures = figuresByRef(blocks);
  return (
    <>
      {blocks.map((block, i) =>
        block.type === "table" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional, in display order
          <Table key={i} block={block} numbers={numbers} onOpen={onOpen} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional, in display order
          <Statement key={i} block={block} figures={figures} numbers={numbers} onOpen={onOpen} />
        ),
      )}
    </>
  );
}

/** U-3: scope, period, "as of" and the received-only marker; the first line of every answer. */
function ContextLine({ answer, stores }: Readonly<AnswerContextProps>): React.JSX.Element {
  const t = useT();
  const names = new Map(stores.map((s) => [s.id, s.name]));
  const refs = answer.scope.storeRefs;
  const single = answer.scope.mode === "store" && refs.length === 1;
  const scope = single ? (
    <bdi>{plainName(names.get(refs[0]) ?? refs[0])}</bdi>
  ) : answer.scope.mode === "all_in_scope" ? (
    t("aiManagerSales.ctx.scopeAll")
  ) : (
    t("aiManagerSales.ctx.scopeStores", { count: refs.length })
  );
  const asOf = earliestAsOf(answer.sources);
  const zones = new Set(refs.map((id) => stores.find((s) => s.id === id)?.timezone ?? "UTC"));
  const zone = zones.size === 1 ? [...zones][0] : undefined;
  return (
    <p className="ams-context">
      {t.rich(single ? "aiManagerSales.ctx.line.store" : "aiManagerSales.ctx.line.stores", {
        scope,
        period: <BusinessDateRange from={answer.period.from} to={answer.period.to} />,
        asOf: asOf ? <DateTime value={asOf} timeZone={zone} /> : "—",
      })}
    </p>
  );
}

function Notices({ answer }: Readonly<{ answer: ManagerSalesAnswer }>): React.JSX.Element {
  const t = useT();
  const asOf = earliestAsOf(answer.sources);
  const time = asOf ? <DateTime value={asOf} /> : "—";
  return (
    <ul className="ams-notices" aria-label={t("aiManagerSales.notices.label")}>
      {orderedNotices(answer.notices).map((notice) => (
        <li key={notice}>
          {notice === "parameters_from_controls_only"
            ? t.rich(NOTICE_COPY[notice], {
                scope: t("aiManagerSales.ctx.scopeAnswer", {
                  count: answer.scope.storeRefs.length,
                }),
                period: <BusinessDateRange from={answer.period.from} to={answer.period.to} />,
              })
            : notice === "day_in_progress"
              ? t.rich(NOTICE_COPY[notice], { time })
              : t(NOTICE_COPY[notice])}
        </li>
      ))}
    </ul>
  );
}

/** Declines inside a successful answer: the figures stay, with their notices (§4.2). */
function Declines({ answer }: Readonly<{ answer: ManagerSalesAnswer }>): React.JSX.Element | null {
  const t = useT();
  if (answer.declined.length === 0) return null;
  const reasonKey: MessageKey = answer.notices.includes("day_in_progress")
    ? "aiManagerSales.reason.dayInProgress"
    : "aiManagerSales.reason.receivedOnly";
  return (
    <ul className="ams-declines" aria-label={t("aiManagerSales.declines.label")}>
      {answer.declined.map((decline) => (
        <li key={decline}>
          {decline === "causal_not_supported"
            ? t("aiManagerSales.decline.causal")
            : t("aiManagerSales.decline.conclusive", { reason: t(reasonKey) })}
        </li>
      ))}
    </ul>
  );
}

function Sources({
  answer,
  detailsRef,
  focusRef,
}: Readonly<{
  answer: ManagerSalesAnswer;
  detailsRef: React.RefObject<HTMLDetailsElement | null>;
  focusRef: React.RefObject<Map<number, HTMLLIElement>>;
}>): React.JSX.Element {
  const t = useT();
  return (
    <details className="ams-sources" ref={detailsRef}>
      <summary>{t("aiManagerSales.sources.title")}</summary>
      <ul className="ams-sources__reads">
        {answer.sources.map((source) => (
          <li key={source.operationId}>
            {t(OPERATION_COPY[source.operationId])} · <bdi dir="ltr">{source.operationId}</bdi> ·{" "}
            {t.rich("metrics.context.asOf", { asOf: <DateTime value={source.asOf} /> })}
          </li>
        ))}
      </ul>
      <ol className="ams-sources__list">
        {answer.citations.map((citation, i) => (
          <li
            key={citation.ref}
            tabIndex={-1}
            ref={(el) => {
              if (el) focusRef.current.set(i + 1, el);
              else focusRef.current.delete(i + 1);
            }}
          >
            <bdi dir="ltr">{citation.operationId}</bdi> · <bdi dir="ltr">{citation.fieldPath}</bdi>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function AnswerView({ answer, stores }: Readonly<AnswerContextProps>): React.JSX.Element {
  const t = useT();
  const numbers = citationNumbers(answer.citations);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const entries = useRef(new Map<number, HTMLLIElement>());
  const open = (n: number) => {
    if (detailsRef.current) detailsRef.current.open = true;
    entries.current.get(n)?.focus();
  };
  return (
    <div className="ams-answer">
      <ContextLine answer={answer} stores={stores} />
      <Notices answer={answer} />
      <Declines answer={answer} />
      <Blocks blocks={answer.blocks} numbers={numbers} onOpen={open} />
      {answer.gaps.length > 0 ? (
        <ul className="ams-gaps" aria-label={t("aiManagerSales.gaps.label")}>
          {answer.gaps.map((gap) => (
            <li key={gap}>{t(GAP_COPY[gap])}</li>
          ))}
        </ul>
      ) : null}
      <Sources answer={answer} detailsRef={detailsRef} focusRef={entries} />
    </div>
  );
}
