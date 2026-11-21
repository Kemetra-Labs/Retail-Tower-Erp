/**
 * RT-1509 step 2, «ربط الأعمدة»: confirm which file column feeds which field. The server's
 * `suggestedMapping` pre-fills the selects and nothing is applied by itself; every column ends
 * explicit (decision 419), so a column with no suggestion is pre-set to «سيتم تجاهله» (D6), named in a
 * summary above «تحقق». Pressing «تحقق» saves the mapping and validates in one go: each call is its
 * own answer, and a refusal stays here with the marked columns.
 *
 * The duplicate-target and missing-required hints are the same rules the server re-applies
 * (`422 mapping_invalid`); they only spare a round trip. The server decides.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import {
  type CanonicalField,
  type CatalogImportBatch,
  type ColumnMapping,
  type CsvDelimiter,
  type MappingTarget,
  consoleReplaceCatalogImportFile,
  consoleSetCatalogImportMapping,
  consoleValidateCatalogImport,
} from "@/lib/catalog-import-queries";
import { useId, useRef, useState } from "react";
import { type ImportOutcome, errorKey } from "./catalogImportLogic";
import { ValidatingNote, fieldLabelKey, outcomeOf, useBrowserTime } from "./importParts";
import type { StepProps } from "./stepTypes";

const FIELDS: readonly CanonicalField[] = [
  "sku",
  "barcode",
  "plu",
  "name",
  "description",
  "category",
  "brand",
  "tax_category",
  "is_active",
  "price",
  "currency",
];
const BARCODE_MAX = 5;
const NOT_IMPORTED: readonly MappingTarget[] = ["price", "currency"];
const DELIMITERS: readonly CsvDelimiter[] = ["comma", "semicolon", "tab"];
const FILE_ACCEPT =
  ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Targets = Record<number, MappingTarget>;
type Failure = Exclude<ImportOutcome<unknown>, { kind: "ok" }>;
type Phase = "idle" | "mapping" | "validating" | "replacing";

const SPECIAL_KEYS: Partial<Record<MappingTarget, MessageKey>> = {
  barcode: "catalogImport.target.barcode",
  name: "catalogImport.target.name",
  tax_category: "catalogImport.target.tax_category",
  price: "catalogImport.target.price",
  currency: "catalogImport.target.currency",
  ignore: "catalogImport.target.ignore",
};

function targetLabelKey(target: MappingTarget): MessageKey {
  return SPECIAL_KEYS[target] ?? fieldLabelKey(target as CanonicalField);
}

function initialTargets(batch: CatalogImportBatch): Targets {
  const out: Targets = {};
  for (const column of batch.columns) out[column.columnNumber] = "ignore";
  for (const entry of batch.mapping ?? batch.suggestedMapping)
    out[entry.columnNumber] = entry.target;
  return out;
}

/** How many columns each target holds, and which rules the current choice breaks. */
function checkTargets(targets: Targets, mode: CatalogImportBatch["mode"]) {
  const counts = new Map<MappingTarget, number>();
  for (const target of Object.values(targets)) counts.set(target, (counts.get(target) ?? 0) + 1);
  const duplicated = (target: MappingTarget): boolean =>
    target !== "ignore" && (counts.get(target) ?? 0) > (target === "barcode" ? BARCODE_MAX : 1);
  const missingRequired = mode !== "update" && (!counts.get("name") || !counts.get("tax_category"));
  return {
    duplicated,
    missingRequired,
    blocked: missingRequired || Object.values(targets).some(duplicated),
  };
}

function noteOf(
  target: MappingTarget,
  confirmed: boolean,
  suggested: MappingTarget | undefined,
): "ignored" | "notImported" | "suggested" | "confirmed" {
  if (target === "ignore") return "ignored";
  if (NOT_IMPORTED.includes(target)) return "notImported";
  return !confirmed && suggested === target ? "suggested" : "confirmed";
}

const NOTE_BADGE = {
  ignored: " badge--warning",
  notImported: " badge--pending",
  suggested: " badge--success",
  confirmed: "",
} as const;

function MapRow({
  column,
  target,
  note,
  bad,
  onChange,
}: Readonly<{
  column: CatalogImportBatch["columns"][number];
  target: MappingTarget;
  note: keyof typeof NOTE_BADGE;
  bad: boolean;
  onChange: (next: MappingTarget) => void;
}>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const header = column.header || t("catalogImport.map.header.empty");
  return (
    <tr>
      <th scope="row">{header}</th>
      <td>
        {column.samples.map((s) => (
          <bdi key={s} dir="ltr" className="import-sample">
            {s}{" "}
          </bdi>
        ))}
      </td>
      <td>
        <select
          className="input"
          value={target}
          aria-label={t("catalogImport.map.select", { header })}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${id}-dup` : undefined}
          onChange={(e) => onChange(e.target.value as MappingTarget)}
        >
          {[...FIELDS, "ignore" as const].map((f) => (
            <option key={f} value={f}>
              {t(targetLabelKey(f))}
            </option>
          ))}
        </select>
        {bad ? (
          <p id={`${id}-dup`} className="field__error">
            {t("catalogImport.map.duplicate", {
              field: t(fieldLabelKey(target as CanonicalField)),
            })}
          </p>
        ) : null}
        {NOT_IMPORTED.includes(target) ? (
          <p className="field__hint">{t("catalogImport.map.priceNotice")}</p>
        ) : null}
      </td>
      <td>
        <span className={`badge${NOTE_BADGE[note]}`}>
          {t(`catalogImport.map.note.${note}` as MessageKey)}
        </span>
      </td>
    </tr>
  );
}

function MapTable({
  batch,
  targets,
  setTargets,
  check,
}: Readonly<{
  batch: CatalogImportBatch;
  targets: Targets;
  setTargets: (next: Targets) => void;
  check: ReturnType<typeof checkTargets>;
}>): React.JSX.Element {
  const t = useT();
  const suggested = new Map(batch.suggestedMapping.map((e) => [e.columnNumber, e.target]));
  return (
    <div className="import-table-wrap">
      <table className="import-table">
        <caption>{t("catalogImport.map.caption", { count: batch.columns.length })}</caption>
        <thead>
          <tr>
            <th scope="col">{t("catalogImport.map.col.file")}</th>
            <th scope="col">{t("catalogImport.map.col.samples")}</th>
            <th scope="col">{t("catalogImport.map.col.target")}</th>
            <th scope="col">{t("catalogImport.map.col.note")}</th>
          </tr>
        </thead>
        <tbody>
          {batch.columns.map((column) => {
            const target = targets[column.columnNumber] ?? "ignore";
            return (
              <MapRow
                key={column.columnNumber}
                column={column}
                target={target}
                note={noteOf(target, batch.mapping !== null, suggested.get(column.columnNumber))}
                bad={check.duplicated(target)}
                onChange={(next) => setTargets({ ...targets, [column.columnNumber]: next })}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MapBanners({
  batch,
  targets,
  notice,
  missingRequired,
  failure,
}: Readonly<{
  batch: CatalogImportBatch;
  targets: Targets;
  notice: StepProps["notice"];
  missingRequired: boolean;
  failure: Failure | null;
}>): React.JSX.Element {
  const t = useT();
  const time = useBrowserTime();
  const previous = batch.warnings.find((w) => w.code === "file_previously_published");
  const ignored = batch.columns.filter((c) => targets[c.columnNumber] === "ignore");
  const refused = failure?.kind === "refused" && failure.code === "mapping_invalid";
  return (
    <>
      {notice === "replaced" ? (
        <Banner
          variant="info"
          title={t("catalogImport.map.replaced.title")}
          message={t("catalogImport.map.replaced.body")}
        />
      ) : null}
      {previous ? (
        <Banner
          variant="info"
          title={t("catalogImport.map.previouslyPublished.title")}
          message={t("catalogImport.map.previouslyPublished.body", {
            date: time(previous.publishedAt),
          })}
        />
      ) : null}
      {ignored.length > 0 ? (
        <Banner
          variant="warning"
          title={t("catalogImport.map.ignored.title", { count: ignored.length })}
          message={t("catalogImport.map.ignored.body", {
            names: ignored
              .map((c) => `«${c.header || t("catalogImport.map.header.empty")}»`)
              .join("، "),
          })}
        />
      ) : null}
      {missingRequired ? (
        <Banner variant="danger" message={t("catalogImport.map.requiredMissing")} />
      ) : null}
      {failure ? (
        <Banner
          variant="danger"
          title={refused ? t("catalogImport.map.refused.title") : undefined}
          message={t(
            failure.kind === "refused"
              ? errorKey(failure.code, failure.status)
              : errorKey(undefined, failure.status),
          )}
          requestId={failure.requestId}
        />
      ) : null}
    </>
  );
}

function SaveProfile({
  save,
  setSave,
  profile,
  setProfile,
}: Readonly<{
  save: boolean;
  setSave: (v: boolean) => void;
  profile: string;
  setProfile: (v: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const id = useId();
  return (
    <div className="import-panel">
      <label className="import-row">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => setSave(e.target.checked)}
          style={{ accentColor: "var(--color-primary)" }}
        />
        <b>{t("catalogImport.map.save.label")}</b>
      </label>
      {save ? (
        <div className="field">
          <label htmlFor={id}>{t("catalogImport.map.save.name")}</label>
          <input
            id={id}
            className="input"
            maxLength={100}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The map step's two writes (save the mapping, then validate) and the file replacement. */
function useMapFlow(props: StepProps, targets: Targets, setTargets: (next: Targets) => void) {
  const { batch, cache, go, setNotice, bumpRun } = props;
  const [save, setSave] = useState(false);
  const [profile, setProfile] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sheet, setSheet] = useState("");
  const [delimiter, setDelimiter] = useState<"" | CsvDelimiter>("");

  function stop(outcome: Failure): void {
    setPhase("idle");
    setFailure(outcome);
    if (outcome.kind === "refused" && outcome.code === "version_conflict") void cache.reread();
  }

  async function submit(): Promise<void> {
    setFailure(null);
    setNotice(null);
    setPhase("mapping");
    const columns: ColumnMapping[] = batch.columns.map((c) => ({
      columnNumber: c.columnNumber,
      target: targets[c.columnNumber] ?? "ignore",
    }));
    const name = save && profile.trim() ? profile.trim() : undefined;
    const mapped = await outcomeOf(() =>
      consoleSetCatalogImportMapping(batch.batchId, batch.version, columns, name),
    );
    if (mapped.kind !== "ok") return stop(mapped);
    cache.store(mapped.data);
    setPhase("validating");
    const validated = await outcomeOf(() =>
      consoleValidateCatalogImport(batch.batchId, mapped.data.version),
    );
    if (validated.kind !== "ok") return stop(validated);
    cache.store(validated.data);
    bumpRun();
    setPhase("idle");
    go("validate");
  }

  async function replace(file: File): Promise<void> {
    setFailure(null);
    setPhase("replacing");
    const csv = batch.file.kind === "csv";
    const outcome = await outcomeOf(() =>
      consoleReplaceCatalogImportFile(
        batch.batchId,
        file,
        {
          fileName: file.name,
          sheet: csv || sheet.trim() === "" ? undefined : sheet.trim(),
          delimiter: !csv || delimiter === "" ? undefined : delimiter,
        },
        batch.version,
      ),
    );
    if (outcome.kind !== "ok") return stop(outcome);
    setPhase("idle");
    cache.store(outcome.data);
    setNotice("replaced");
    setTargets(initialTargets(outcome.data));
  }

  return {
    save,
    setSave,
    profile,
    setProfile,
    phase,
    failure,
    sheet,
    setSheet,
    delimiter,
    setDelimiter,
    submit,
    replace,
  };
}

function ReplaceOptions({
  kind,
  flow,
}: Readonly<{ kind: "csv" | "xlsx"; flow: ReturnType<typeof useMapFlow> }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  return (
    <details>
      <summary>{t("catalogImport.map.replace.title")}</summary>
      <p className="import-step__why">{t("catalogImport.map.replace.hint")}</p>
      <div className="import-options">
        {kind === "xlsx" ? (
          <div className="field">
            <label htmlFor={id}>{t("catalogImport.upload.sheet.label")}</label>
            <input
              id={id}
              className="input"
              value={flow.sheet}
              placeholder={t("catalogImport.upload.sheet.placeholder")}
              onChange={(e) => flow.setSheet(e.target.value)}
            />
          </div>
        ) : (
          <div className="field">
            <label htmlFor={id}>{t("catalogImport.upload.delimiter.label")}</label>
            <select
              id={id}
              className="input"
              value={flow.delimiter}
              onChange={(e) => flow.setDelimiter(e.target.value as "" | CsvDelimiter)}
            >
              <option value="">{t("catalogImport.upload.delimiter.auto")}</option>
              {DELIMITERS.map((d) => (
                <option key={d} value={d}>
                  {t(`catalogImport.upload.delimiter.${d}`)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </details>
  );
}

function MapActions({
  props,
  flow,
  blocked,
}: Readonly<{
  props: StepProps;
  flow: ReturnType<typeof useMapFlow>;
  blocked: boolean;
}>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const { phase } = flow;
  const working = phase === "mapping" || phase === "validating";
  return (
    <>
      <div className="import-step__actions">
        <GatedButton
          className="btn-primary"
          busy={working}
          disabled={blocked || props.locked || phase === "replacing"}
          aria-describedby={blocked ? `${id}-blocked` : undefined}
          onClick={() => void flow.submit()}
        >
          {phase === "mapping"
            ? t("catalogImport.map.submitting")
            : phase === "validating"
              ? t("catalogImport.validate.busy.button")
              : t("catalogImport.map.submit")}
        </GatedButton>
        <input
          ref={fileRef}
          type="file"
          className="import-file-input"
          tabIndex={-1}
          aria-hidden="true"
          accept={FILE_ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void flow.replace(file);
          }}
        />
        <GatedButton
          className="btn-ghost"
          busy={phase === "replacing"}
          disabled={props.locked || working}
          onClick={() => fileRef.current?.click()}
        >
          {phase === "replacing"
            ? t("catalogImport.map.replace.busy")
            : t("catalogImport.map.replace.action")}
        </GatedButton>
        <button
          type="button"
          className="btn-danger-quiet import-step__actions-end"
          disabled={phase !== "idle" || props.locked}
          onClick={props.requestCancel}
        >
          {t("catalogImport.cancel.action")}
        </button>
      </div>
      {blocked ? (
        <p id={`${id}-blocked`} className="import-step__why">
          {t("catalogImport.map.blocked")}
        </p>
      ) : null}
    </>
  );
}

function MapIntro({ batch }: Readonly<{ batch: CatalogImportBatch }>): React.JSX.Element {
  const t = useT();
  const { sheetName, csvDelimiter } = batch.file;
  return (
    <p className="import-step__lead">
      {t("catalogImport.map.intro")}{" "}
      {sheetName ? t("catalogImport.map.sheetRead", { sheet: sheetName }) : null}
      {csvDelimiter
        ? t("catalogImport.map.delimiterRead", {
            delimiter: t(`catalogImport.upload.delimiter.${csvDelimiter}`),
          })
        : null}
    </p>
  );
}

export function MapStep(props: Readonly<StepProps>): React.JSX.Element {
  const { batch, notice } = props;
  const [targets, setTargets] = useState(() => initialTargets(batch));
  const flow = useMapFlow(props, targets, setTargets);
  const check = checkTargets(targets, batch.mode);
  return (
    <div className="import-step">
      <MapIntro batch={batch} />
      <MapBanners
        batch={batch}
        targets={targets}
        notice={notice}
        missingRequired={check.missingRequired}
        failure={flow.failure}
      />
      <MapTable batch={batch} targets={targets} setTargets={setTargets} check={check} />
      <SaveProfile
        save={flow.save}
        setSave={flow.setSave}
        profile={flow.profile}
        setProfile={flow.setProfile}
      />
      {flow.phase === "validating" ? <ValidatingNote rows={batch.file.dataRowCount} /> : null}
      <MapActions props={props} flow={flow} blocked={check.blocked} />
      <ReplaceOptions kind={batch.file.kind} flow={flow} />
    </div>
  );
}
