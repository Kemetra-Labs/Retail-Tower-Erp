/**
 * RT-1509 step 1, «رفع الملف»: choose the mode (no default, D15), optionally download the template,
 * pick one file, upload. The client checks only what helps the merchant (the file kind decides which
 * option field applies); Backend-Core decides everything else (spec 039 FR-20).
 *
 * The upload is idempotent by key + file bytes + query (mode, sheet, delimiter, file_name). One key
 * is held per intended upload (`KeyedAttempt`, keyed on exactly those inputs): an unclear answer
 * (no answer, 5xx, 425, 429) resends the same file and query under the same key, and a changed
 * option takes a new key, so a resend never meets `409 idempotency_key_conflict`.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { formatNumber, useT } from "@/i18n";
import {
  type CatalogImportBatch,
  type CsvDelimiter,
  type ImportMode,
  consoleGetCatalogImportTemplate,
  consoleUploadCatalogImport,
} from "@/lib/catalog-import-queries";
import { saveBlob } from "@/lib/save-blob";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useId, useRef, useState } from "react";
import { OpenBatchCard } from "./OpenBatchCard";
import { type ImportOutcome, errorKey } from "./catalogImportLogic";
import { filenameFromDisposition, outcomeOf, useWait } from "./importParts";

const MODES: readonly ImportMode[] = ["upsert", "create", "update"];
const DELIMITERS: readonly CsvDelimiter[] = ["comma", "semicolon", "tab"];

type Failure = Exclude<ImportOutcome<unknown>, { kind: "ok" }>;
type UploadQuery = Parameters<typeof consoleUploadCatalogImport>[1];

function kindOf(file: File | null): "csv" | "xlsx" | null {
  const name = file?.name.toLowerCase() ?? "";
  if (name.endsWith(".csv")) return "csv";
  return name.endsWith(".xlsx") ? "xlsx" : null;
}

/** What the server fingerprints: a change to any of it is a new upload, so a new key. */
function requestOf(
  mode: ImportMode | null,
  file: File | null,
  sheet: string,
  delimiter: "" | CsvDelimiter,
): { query: UploadQuery; print: string } | null {
  if (!mode || !file) return null;
  const kind = kindOf(file);
  const query: UploadQuery = {
    mode,
    fileName: file.name,
    sheet: kind === "csv" || sheet.trim() === "" ? undefined : sheet.trim(),
    delimiter: kind === "xlsx" || delimiter === "" ? undefined : delimiter,
  };
  const print = JSON.stringify([
    file.name,
    file.size,
    file.lastModified,
    mode,
    query.sheet,
    query.delimiter,
  ]);
  return { query, print };
}

function useUploadFlow(onUploaded: (batch: CatalogImportBatch) => void) {
  const attempt = useRef(new KeyedAttempt());
  const [mode, setMode] = useState<ImportMode | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState("");
  const [delimiter, setDelimiter] = useState<"" | CsvDelimiter>("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [templateFailed, setTemplateFailed] = useState(false);

  async function upload(): Promise<void> {
    const req = requestOf(mode, file, sheet, delimiter);
    if (!req || !file || busy) return;
    setBusy(true);
    const key = attempt.current.keyFor(req.print);
    const outcome = await outcomeOf(() => consoleUploadCatalogImport(file, req.query, key), {
      success: [201],
      resend: true,
    });
    setBusy(false);
    if (outcome.kind === "ok") {
      attempt.current.settle();
      setFailure(null);
      onUploaded(outcome.data);
      return;
    }
    if (outcome.kind === "unclear") {
      setFailure(outcome);
      return;
    }
    // A terminal answer: the next upload is a new action.
    attempt.current.settle();
    const open = outcome.code === "import_batch_open" ? outcome.openBatchId : undefined;
    setOpenBatchId(open ?? null);
    setFailure(open ? null : outcome);
  }

  async function downloadTemplate(headers: "ar" | "en"): Promise<void> {
    setTemplateFailed(false);
    const res = await consoleGetCatalogImportTemplate(headers).catch(() => null);
    if (!res || res.status !== 200 || !res.data) {
      setTemplateFailed(true);
      return;
    }
    saveBlob(
      res.data as Blob,
      filenameFromDisposition(res.disposition, `product-import-template-${headers}.csv`),
    );
  }

  return {
    mode,
    setMode,
    file,
    pick: (next: File | null) => {
      setFile(next);
      setFailure(null);
    },
    sheet,
    setSheet,
    delimiter,
    setDelimiter,
    busy,
    failure,
    openBatchId,
    closeOpenBatch: () => setOpenBatchId(null),
    templateFailed,
    upload,
    downloadTemplate,
  };
}

type Flow = ReturnType<typeof useUploadFlow>;

function ModeFieldset({
  mode,
  setMode,
}: Readonly<Pick<Flow, "mode" | "setMode">>): React.JSX.Element {
  const t = useT();
  const name = useId();
  return (
    <fieldset className="import-panel">
      <legend>
        {t("catalogImport.upload.mode.legend")}{" "}
        <span className="import-step__why">{t("catalogImport.upload.mode.required")}</span>
      </legend>
      {MODES.map((m) => (
        <label key={m} className="import-mode">
          <input type="radio" name={name} checked={mode === m} onChange={() => setMode(m)} />
          <span>
            <b>{t(`catalogImport.upload.mode.${m}`)}</b>
            <small>{t(`catalogImport.upload.mode.${m}Hint`)}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function AdvancedOptions({
  flow,
  kind,
}: Readonly<{ flow: Flow; kind: "csv" | "xlsx" | null }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  return (
    <details>
      <summary>{t("catalogImport.upload.advanced")}</summary>
      <div className="import-options">
        <div className="field">
          <label htmlFor={`${id}-sheet`}>{t("catalogImport.upload.sheet.label")}</label>
          <input
            id={`${id}-sheet`}
            className="input"
            value={flow.sheet}
            disabled={kind === "csv"}
            placeholder={t("catalogImport.upload.sheet.placeholder")}
            aria-describedby={`${id}-sheet-hint`}
            onChange={(e) => flow.setSheet(e.target.value)}
          />
          <p id={`${id}-sheet-hint`} className="field__hint">
            {t("catalogImport.upload.sheet.hint")}
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-delim`}>{t("catalogImport.upload.delimiter.label")}</label>
          <select
            id={`${id}-delim`}
            className="input"
            value={flow.delimiter}
            disabled={kind === "xlsx"}
            aria-describedby={kind === "xlsx" ? `${id}-delim-hint` : undefined}
            onChange={(e) => flow.setDelimiter(e.target.value as "" | CsvDelimiter)}
          >
            <option value="">{t("catalogImport.upload.delimiter.auto")}</option>
            {DELIMITERS.map((d) => (
              <option key={d} value={d}>
                {t(`catalogImport.upload.delimiter.${d}`)}
              </option>
            ))}
          </select>
          {kind === "xlsx" ? (
            <p id={`${id}-delim-hint`} className="field__hint">
              {t("catalogImport.upload.delimiter.xlsxHint")}
            </p>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function FileName({ file }: Readonly<{ file: File | null }>): React.JSX.Element {
  const t = useT();
  if (!file) return <span className="import-step__why">{t("catalogImport.upload.file.none")}</span>;
  return (
    <span>
      <bdi dir="ltr">{file.name}</bdi>
      <span aria-hidden="true"> · </span>
      <bdi dir="ltr">
        {t("catalogImport.upload.file.size", {
          size: formatNumber(Math.max(1, Math.ceil(file.size / 1024))),
        })}
      </bdi>
    </span>
  );
}

function FileFieldset({
  flow,
  describedBy,
}: Readonly<{ flow: Flow; describedBy: string }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <fieldset className="import-panel">
      <legend>{t("catalogImport.upload.file.legend")}</legend>
      <input
        ref={inputRef}
        type="file"
        className="import-file-input"
        tabIndex={-1}
        aria-hidden="true"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => {
          flow.pick(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <div className="import-row">
        <GatedButton
          className="btn-secondary"
          aria-describedby={`${id}-req ${describedBy}`}
          onClick={() => inputRef.current?.click()}
        >
          {t(
            flow.file
              ? "catalogImport.upload.file.chooseAnother"
              : "catalogImport.upload.file.choose",
          )}
        </GatedButton>
        <FileName file={flow.file} />
      </div>
      <p id={`${id}-req`} className="import-step__why">
        {t("catalogImport.upload.file.requirements")}
      </p>
      <div className="import-row">
        {(["ar", "en"] as const).map((lang) => (
          <button
            key={lang}
            type="button"
            className="btn-ghost"
            onClick={() => void flow.downloadTemplate(lang)}
          >
            {t("catalogImport.upload.template.link")} · {t(`catalogImport.upload.template.${lang}`)}
          </button>
        ))}
      </div>
      {flow.templateFailed ? (
        <Banner variant="danger" message={t("catalogImport.upload.template.failed")} />
      ) : null}
      <AdvancedOptions flow={flow} kind={kindOf(flow.file)} />
    </fieldset>
  );
}

function UploadFeedback({ flow, id }: Readonly<{ flow: Flow; id: string }>): React.JSX.Element {
  const t = useT();
  const { failure } = flow;
  const wait = useWait(failure?.kind === "unclear" ? failure.retryAfterSec : undefined, failure);
  return (
    <>
      {flow.busy ? (
        <output className="import-panel" aria-busy="true">
          <b>{t("catalogImport.upload.busy.title")}</b>
          <span className="import-step__why">{t("catalogImport.upload.busy.body")}</span>
        </output>
      ) : null}
      <div id={id}>
        {failure?.kind === "refused" ? (
          <Banner
            variant="danger"
            message={`${t(errorKey(failure.code, failure.status))} ${t("catalogImport.upload.unchanged")}`}
            requestId={failure.requestId}
          />
        ) : null}
        {failure?.kind === "unclear" ? (
          <Banner
            variant="warning"
            title={t("catalogImport.upload.unclear.title")}
            message={
              wait > 0
                ? t("catalogImport.publish.wait", { count: wait })
                : t("catalogImport.upload.unclear.body")
            }
            requestId={failure.requestId}
            action={
              <GatedButton
                className="btn-secondary"
                busy={flow.busy}
                disabled={wait > 0}
                onClick={() => void flow.upload()}
              >
                {t("catalogImport.upload.unclear.resend")}
              </GatedButton>
            }
          />
        ) : null}
      </div>
    </>
  );
}

export function UploadStep({
  onUploaded,
}: Readonly<{ onUploaded: (batch: CatalogImportBatch) => void }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const flow = useUploadFlow(onUploaded);
  const blockedKey =
    !flow.mode && !flow.file ? "both" : !flow.mode ? "mode" : !flow.file ? "file" : null;
  return (
    <div className="import-step">
      <p className="import-step__lead">{t("catalogImport.upload.intro")}</p>
      {flow.openBatchId ? (
        <OpenBatchCard batchId={flow.openBatchId} onClosed={flow.closeOpenBatch} />
      ) : null}
      <ModeFieldset mode={flow.mode} setMode={flow.setMode} />
      <FileFieldset flow={flow} describedBy={flow.failure ? `${id}-err` : ""} />
      <UploadFeedback flow={flow} id={`${id}-err`} />
      <div className="import-step__actions">
        <GatedButton
          className="btn-primary"
          busy={flow.busy}
          disabled={blockedKey !== null}
          aria-describedby={blockedKey ? `${id}-why` : undefined}
          onClick={() => void flow.upload()}
        >
          {flow.busy ? t("catalogImport.upload.submitting") : t("catalogImport.upload.submit")}
        </GatedButton>
        {blockedKey ? (
          <span id={`${id}-why`} className="import-step__why">
            {t(`catalogImport.upload.blocked.${blockedKey}`)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
