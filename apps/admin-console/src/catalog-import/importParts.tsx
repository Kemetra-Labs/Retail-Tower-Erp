/**
 * RT-1509: the small pieces the import steps share: the status pill, a row's issues in words, the
 * refusal banner, the browser-zone time, the download of a server file, and a wait countdown.
 *
 * Nothing here decides a rule. A refusal is shown by its machine code (`errorKey`), the issue text
 * by its code (`issueKey`); a cell's value comes from the row, never from a message.
 */
import { Banner } from "@/components/Banner";
import { type MessageKey, formatDateTime, formatNumber, useT } from "@/i18n";
import type {
  CanonicalField,
  CatalogImportBatch,
  CatalogImportRow,
  RowIssue,
  RowStatus,
} from "@/lib/catalog-import-queries";
import { useEffect, useState } from "react";
import {
  type ImportOutcome,
  STATUS_KEYS,
  classifyImport,
  errorKey,
  issueKey,
  statusTone,
} from "./catalogImportLogic";

const TONE_CLASS = {
  ok: "badge badge--success",
  warn: "badge badge--warning",
  danger: "badge badge--danger",
  mute: "badge",
} as const;

export function StatusBadge({ status }: Readonly<{ status: RowStatus }>): React.JSX.Element {
  const t = useT();
  return <span className={TONE_CLASS[statusTone(status)]}>{t(STATUS_KEYS[status])}</span>;
}

export function fieldLabelKey(field: CanonicalField): MessageKey {
  return `catalogImport.field.${field}` as MessageKey;
}

/** An instant shown in the browser's own zone and labelled so (RT-401 is open; D13). */
export function useBrowserTime(): (iso: string) => string {
  const t = useT();
  return (iso) => {
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }
    return t("catalogImport.time.browser", { time: formatDateTime(iso, { timeZone }) });
  };
}

/** The cell text of a mapped field in one row (the file's own text, after the server's trim). */
function mappedCell(
  batch: CatalogImportBatch,
  row: CatalogImportRow,
  field: CanonicalField,
): string | null {
  const column = batch.mapping?.find((entry) => entry.target === field)?.columnNumber;
  return column === undefined ? null : (row.cells[column - 1] ?? null);
}

/** «الصنف في الملف»: the name and the SKU or first barcode, each LTR-isolated where it is a machine value. */
export function RowProduct({
  batch,
  row,
}: Readonly<{ batch: CatalogImportBatch; row: CatalogImportRow }>): React.JSX.Element {
  const name = mappedCell(batch, row, "name");
  const code = mappedCell(batch, row, "sku") ?? mappedCell(batch, row, "barcode");
  return (
    <>
      {name ? <span>{name}</span> : null}
      {name && code ? <br /> : null}
      {code ? <bdi dir="ltr">{code}</bdi> : null}
    </>
  );
}

/** One row's issues, each in words: severity word, then the fixed copy of its code, then the cell value. */
export function RowIssues({ row }: Readonly<{ row: CatalogImportRow }>): React.JSX.Element {
  const t = useT();
  if (row.issues.length === 0) {
    return <span className="import-step__why">{t("catalogImport.validate.noIssues")}</span>;
  }
  return (
    <ul className="import-issues">
      {row.issues.map((issue, i) => (
        <li key={`${issue.code}-${issue.columnNumber ?? i}-${i}`}>
          <IssueLine issue={issue} row={row} />
        </li>
      ))}
    </ul>
  );
}

function IssueLine({
  issue,
  row,
}: Readonly<{ issue: RowIssue; row: CatalogImportRow }>): React.JSX.Element {
  const t = useT();
  const cell = issue.columnNumber === null ? null : (row.cells[issue.columnNumber - 1] ?? null);
  return (
    <>
      <b>{t(`catalogImport.severity.${issue.severity}` as MessageKey)}: </b>
      {t(issueKey(issue.code), {
        field: issue.field ? t(fieldLabelKey(issue.field)) : "",
        name: issue.relatedProduct?.name ?? "",
        row: issue.relatedRowNumber ?? "",
      })}
      {issue.severity === "error" && cell ? (
        <span className="import-cellvalue">
          {" "}
          {t.rich("catalogImport.issue.cellValue", { value: <bdi dir="ltr">{cell}</bdi> })}
        </span>
      ) : null}
    </>
  );
}

/** A refusal or an unclear answer as a persistent banner; the request id is the support handle. */
export function RefusalBanner({
  outcome,
  variant = "danger",
  action,
}: Readonly<{
  outcome: Exclude<ImportOutcome<unknown>, { kind: "ok" }>;
  variant?: "danger" | "warning";
  action?: React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const key =
    outcome.kind === "refused"
      ? errorKey(outcome.code, outcome.status)
      : errorKey(undefined, outcome.status);
  return (
    <Banner variant={variant} message={t(key)} requestId={outcome.requestId} action={action} />
  );
}

/** One request, one outcome: a call that threw before any status is an unclear answer (status 0). */
export async function outcomeOf<T>(
  call: () => Promise<{
    status: number;
    data?: T;
    error?: unknown;
    retryAfter?: string | null;
    replayed?: boolean;
  }>,
  options: { success?: readonly number[]; resend?: boolean } = {},
): Promise<ImportOutcome<T>> {
  const res = await call().catch(() => ({ status: 0 }) as { status: number; data?: T });
  return classifyImport(res as Parameters<typeof classifyImport<T>>[0], options);
}

/** The file name from `Content-Disposition` (RFC 6266 `filename*` first), or the fallback. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      /* fall through to the plain filename */
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1] ?? fallback;
}

/** Seconds left of a server-given wait; 0 when there is none. The text is visual: it ticks each second. */
export function useWait(seconds: number | undefined, key: unknown): number {
  const [left, setLeft] = useState(seconds ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` restarts the wait for a new answer.
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const timer = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [seconds, key]);
  return left;
}

/** «جارٍ التحقق من صفوف الملف…»: the validation is synchronous and can take up to ten seconds. */
export function ValidatingNote({ rows }: Readonly<{ rows: number }>): React.JSX.Element {
  const t = useT();
  return (
    <output className="import-panel" aria-busy="true">
      <b>{t("catalogImport.validate.busy.title", { count: formatNumber(rows) })}</b>
      <span className="import-step__why">{t("catalogImport.validate.busy.body")}</span>
    </output>
  );
}

/** The fields a field change or a conflict names, as the server names them in `fieldChanges`. */
const CHANGE_FIELDS: readonly string[] = [
  "name",
  "description",
  "category",
  "brand",
  "tax_category",
  "is_active",
];

/** The label of a changed field; a field this catalog does not know is shown as the server named it. */
export function changeFieldLabel(t: ReturnType<typeof useT>, field: string): string {
  return CHANGE_FIELDS.includes(field)
    ? t(`catalogImport.changes.field.${field}` as MessageKey)
    : field;
}
