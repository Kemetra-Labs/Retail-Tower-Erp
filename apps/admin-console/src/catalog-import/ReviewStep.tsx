/**
 * RT-1509 step 4, «المراجعة»: give every `needs_review` row a decision and every `error` row an
 * exclusion (or a fixed file). A filtered list plus a row drawer (UX-10.31, D5); decisions apply one
 * at a time and the server records each and returns the new counts, which are the only counts shown.
 *
 * The offered resolutions are derived from the documented rules (G4) and the server stays
 * authoritative: `422 resolution_not_allowed` reloads the row, `409 version_conflict` re-reads the
 * batch. «سُجّل» is said only after the server returned the decision; the catalogue has not changed,
 * so nothing here says «تم التحديث».
 *
 * The list holds the rows still without a decision plus the rows decided in this visit (each can be
 * undone with «إزالة القرار»); the contract has no filter for "decided" rows, so rows decided in an
 * earlier visit are counted in the server's counts but not listed.
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { type MessageKey, formatNumber, useT } from "@/i18n";
import {
  type CatalogImportBatch,
  type CatalogImportRow,
  type ImportIdentifier,
  type ProductRef,
  type ResolveAction,
  consoleResolveCatalogImportRow,
} from "@/lib/catalog-import-queries";
import { useId, useRef, useState } from "react";
import {
  type ImportOutcome,
  createBlockedByIdentifier,
  errorKey,
  offeredResolutions,
  undecidedCount,
} from "./catalogImportLogic";
import { RowIssues, RowProduct, outcomeOf } from "./importParts";
import type { StepProps } from "./stepTypes";
import { useImportRows } from "./useCatalogImport";

type Choice = "create" | "exclude" | { update: string };
type Failure = Exclude<ImportOutcome<unknown>, { kind: "ok" }>;
type Recorded = { row: CatalogImportRow; cleared: boolean };

function reasonKey(row: CatalogImportRow): MessageKey {
  return row.reviewReason
    ? (`catalogImport.review.reason.${row.reviewReason}` as MessageKey)
    : "catalogImport.review.reason.error";
}

function Identifiers({ ids }: Readonly<{ ids: readonly ImportIdentifier[] }>): React.JSX.Element {
  return (
    <>
      {ids.map((id, i) => (
        <span key={`${id.type}-${id.value}`}>
          {i > 0 ? " · " : ""}
          <bdi dir="ltr">{id.value}</bdi>
        </span>
      ))}
    </>
  );
}

function decisionText(t: ReturnType<typeof useT>, row: CatalogImportRow): string {
  const r = row.resolution;
  if (!r) return t("catalogImport.review.decided.none");
  if (r.action === "create_new") return t("catalogImport.review.decided.create");
  if (r.action === "exclude") return t("catalogImport.review.decided.exclude");
  const known: ProductRef[] = [...row.outcome.candidates];
  if (row.outcome.matchedProduct) known.push(row.outcome.matchedProduct);
  const target = known.find((p) => p.productId === r.productId);
  return t("catalogImport.review.decided.update", { name: target?.name ?? "" });
}

/** The reason an identifier was left out of a decided row, as copy. */
function notAddedReason(row: CatalogImportRow): MessageKey {
  if (row.reviewReason === "sku_mismatch") return "catalogImport.review.notAdded.sku";
  return row.reviewReason === "store_scoped_conflict"
    ? "catalogImport.review.notAdded.store"
    : "catalogImport.review.notAdded.other";
}

/** Both review lists (needs a decision, has an error) as one, plus the decision flow. */
function useReview({ batch, cache, run }: StepProps) {
  const reviewRows = useImportRows(batch.batchId, "needs_review", run);
  const errorRows = useImportRows(batch.batchId, "error", run);
  const [open, setOpen] = useState<number | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState<ResolveAction | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const openers = useRef(new Map<number, HTMLButtonElement>());
  const rows = [...reviewRows.rows, ...errorRows.rows].sort((a, b) => a.rowNumber - b.rowNumber);

  function reloadRows(): void {
    reviewRows.reload();
    errorRows.reload();
  }

  function refused(outcome: Failure): void {
    setFailure(outcome);
    if (outcome.kind !== "refused") return;
    if (outcome.code === "version_conflict") void cache.reread();
    if (outcome.code === "version_conflict" || outcome.code === "resolution_not_allowed")
      reloadRows();
  }

  async function decide(row: CatalogImportRow, action: ResolveAction, productId?: string) {
    setBusy(action);
    setFailure(null);
    setRecorded(null);
    const outcome = await outcomeOf(() =>
      consoleResolveCatalogImportRow(batch.batchId, row.rowNumber, {
        expectedVersion: batch.version,
        action,
        productId,
      }),
    );
    setBusy(null);
    if (outcome.kind !== "ok") return refused(outcome);
    const answer = outcome.data;
    cache.patch((b) => ({
      ...b,
      version: answer.version,
      counts: answer.counts,
      previewHash: answer.previewHash,
      publishable: answer.publishable,
    }));
    reviewRows.replaceRow(answer.row);
    errorRows.replaceRow(answer.row);
    setRecorded({ row: answer.row, cleared: action === "clear" });
    setOpen(null);
    setChoice(null);
    const opener = openers.current.get(row.rowNumber);
    if (opener) setTimeout(() => opener.focus(), 0);
  }

  function apply(row: CatalogImportRow): void {
    if (choice === null) return;
    if (choice === "create") void decide(row, "create_new");
    else if (choice === "exclude") void decide(row, "exclude");
    else void decide(row, "update_product", choice.update);
  }

  return {
    rows,
    loading: reviewRows.loading || errorRows.loading,
    loadError: reviewRows.error ?? errorRows.error,
    hasMore: reviewRows.hasMore || errorRows.hasMore,
    moreFailed: reviewRows.moreFailed || errorRows.moreFailed,
    loadingMore: reviewRows.loadingMore || errorRows.loadingMore,
    loadMore: () => {
      reviewRows.loadMore();
      errorRows.loadMore();
    },
    reloadRows,
    open,
    setOpen: (n: number | null) => {
      setOpen(n);
      setChoice(null);
      setFailure(null);
    },
    choice,
    setChoice,
    busy,
    failure,
    recorded,
    openers,
    decide,
    apply,
  };
}

type Review = ReturnType<typeof useReview>;

function FailureBanner({ failure }: Readonly<{ failure: Failure }>): React.JSX.Element {
  const t = useT();
  const code = failure.kind === "refused" ? failure.code : undefined;
  if (code === "version_conflict") {
    return (
      <Banner
        variant="warning"
        title={t("catalogImport.review.versionConflict.title")}
        message={t("catalogImport.review.versionConflict.body")}
      />
    );
  }
  if (code === "resolution_not_allowed") {
    return (
      <Banner
        variant="danger"
        title={t("catalogImport.review.notAllowed.title")}
        message={t("catalogImport.review.notAllowed.body")}
        requestId={failure.requestId}
      />
    );
  }
  return (
    <Banner
      variant="danger"
      message={t(errorKey(code, failure.status))}
      requestId={failure.requestId}
    />
  );
}

function RecordedBanners({ recorded }: Readonly<{ recorded: Recorded }>): React.JSX.Element {
  const t = useT();
  const { row, cleared } = recorded;
  const notAdded = row.outcome.identifiersNotAdded;
  if (cleared) {
    return (
      <Banner
        variant="success"
        message={t("catalogImport.review.cleared", { row: row.rowNumber })}
      />
    );
  }
  return (
    <>
      <Banner
        variant="success"
        message={t("catalogImport.review.recorded", {
          row: row.rowNumber,
          outcome: decisionText(t, row),
        })}
      />
      {notAdded.length > 0 ? (
        <Banner
          variant="info"
          message={t("catalogImport.review.notAdded", {
            ids: notAdded.map((i) => i.value).join("، "),
            reason: t(notAddedReason(row)),
          })}
        />
      ) : null}
    </>
  );
}

function ReviewRow({
  row,
  open,
  review,
}: Readonly<{ row: CatalogImportRow; open: boolean; review: Review }>): React.JSX.Element {
  const t = useT();
  return (
    <tr aria-selected={open || undefined}>
      <th scope="row" className="is-num">
        <bdi dir="ltr">{row.rowNumber}</bdi>
      </th>
      <td>
        <span className={`badge ${row.status === "error" ? "badge--danger" : "badge--warning"}`}>
          {t(reasonKey(row))}
        </span>
      </td>
      <td>
        <span className={`badge${row.resolution ? " badge--success" : ""}`}>
          {decisionText(t, row)}
        </span>
      </td>
      <td>
        <button
          type="button"
          className="btn-ghost"
          aria-expanded={open}
          aria-label={t("catalogImport.review.openRow", { row: row.rowNumber })}
          ref={(el) => {
            if (el) review.openers.current.set(row.rowNumber, el);
          }}
          onClick={() => review.setOpen(row.rowNumber)}
        >
          {t("catalogImport.review.open")}
        </button>
      </td>
    </tr>
  );
}

function ReviewList({ review }: Readonly<{ review: Review }>): React.JSX.Element {
  const t = useT();
  if (review.loading)
    return <ListState state="loading" label={t("catalogImport.review.loading")} />;
  if (review.loadError) {
    return (
      <Banner
        variant="danger"
        message={t("catalogImport.review.rowsFailed")}
        requestId={review.loadError.requestId}
        action={
          <button type="button" className="btn-secondary" onClick={review.reloadRows}>
            {t("catalogImport.reload")}
          </button>
        }
      />
    );
  }
  if (review.rows.length === 0) {
    return (
      <ListState
        state="empty"
        emptyMessage={t("catalogImport.review.empty")}
        emptyHint={t("catalogImport.review.emptyHint")}
      />
    );
  }
  return (
    <>
      <div className="import-table-wrap">
        <table className="import-table">
          <caption>{t("catalogImport.review.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("catalogImport.review.col.row")}</th>
              <th scope="col">{t("catalogImport.review.col.reason")}</th>
              <th scope="col">{t("catalogImport.review.col.decision")}</th>
              <th scope="col">
                <span className="sr-only">{t("catalogImport.review.col.action")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {review.rows.map((row) => (
              <ReviewRow
                key={row.rowNumber}
                row={row}
                open={review.open === row.rowNumber}
                review={review}
              />
            ))}
          </tbody>
        </table>
      </div>
      {review.moreFailed ? (
        <Banner variant="danger" message={t("catalogImport.review.loadMoreFailed")} />
      ) : null}
      {review.hasMore ? (
        <div>
          <GatedButton
            className="btn-secondary"
            busy={review.loadingMore}
            onClick={review.loadMore}
          >
            {t("catalogImport.review.loadMore")}
          </GatedButton>
        </div>
      ) : null}
    </>
  );
}

function ReviewActions({
  props,
  undecided,
}: Readonly<{ props: StepProps; undecided: number }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  return (
    <div className="import-step__actions">
      <button
        type="button"
        className="btn-primary"
        disabled={undecided > 0 || props.locked}
        aria-describedby={undecided > 0 ? `${id}-why` : undefined}
        onClick={() => props.go("preview")}
      >
        {t("catalogImport.review.toPreview")}
      </button>
      {undecided > 0 ? (
        <span id={`${id}-why`} className="import-step__why">
          {t("catalogImport.review.undecided", { count: formatNumber(undecided) })}
        </span>
      ) : null}
      <button
        type="button"
        className="btn-danger-quiet import-step__actions-end"
        disabled={props.locked}
        onClick={props.requestCancel}
      >
        {t("catalogImport.cancel.action")}
      </button>
    </div>
  );
}

export function ReviewStep(props: Readonly<StepProps>): React.JSX.Element {
  const { batch } = props;
  const t = useT();
  const review = useReview(props);
  const counts = batch.counts;
  const undecided = undecidedCount(counts);
  const current = review.rows.find((r) => r.rowNumber === review.open) ?? null;
  return (
    <div className="import-step">
      <p className="import-step__lead">
        {t("catalogImport.review.title", { count: formatNumber(undecided) })}
        {counts
          ? ` · ${t("catalogImport.review.breakdown", {
              review: formatNumber(counts.needs_review),
              errors: formatNumber(counts.error),
            })}`
          : null}
      </p>
      {/* Counts after a decision, announced politely (no toast, UX-11.20). */}
      <output className="sr-only" aria-live="polite">
        {t("catalogImport.review.undecided", { count: formatNumber(undecided) })}
      </output>
      {review.recorded ? <RecordedBanners recorded={review.recorded} /> : null}
      {review.failure ? <FailureBanner failure={review.failure} /> : null}
      <ReviewList review={review} />
      <ReviewActions props={props} undecided={undecided} />
      {current ? (
        <Drawer
          title={t("catalogImport.review.drawerTitle", {
            row: current.rowNumber,
            reason: t(reasonKey(current)),
          })}
          dismissible={review.busy === null}
          onClose={() => review.setOpen(null)}
        >
          <RowDrawerBody batch={batch} row={current} review={review} />
        </Drawer>
      ) : null}
    </div>
  );
}

function Candidate({ candidate }: Readonly<{ candidate: ProductRef }>): React.JSX.Element {
  return (
    <span className="import-candidate">
      {candidate.name}
      <br />
      <span className="import-step__why">
        <Identifiers ids={candidate.identifiers} />
      </span>
    </span>
  );
}

function DecisionOptions({
  batchMode,
  row,
  review,
}: Readonly<{
  batchMode: CatalogImportBatch["mode"];
  row: CatalogImportRow;
  review: Review;
}>): React.JSX.Element {
  const t = useT();
  const name = useId();
  const offered = offeredResolutions(batchMode, row);
  const { choice, setChoice } = review;
  const updating = typeof choice === "object" && choice !== null ? choice.update : null;
  return (
    <fieldset className="import-decisions">
      <legend className="import-step__title">{t("catalogImport.review.decisions")}</legend>
      {offered.includes("create_new") ? (
        <label className="import-mode">
          <input
            type="radio"
            name={name}
            checked={choice === "create"}
            onChange={() => setChoice("create")}
          />
          <span>
            <b>{t("catalogImport.review.createNew")}</b>
          </span>
        </label>
      ) : null}
      {offered.includes("update_product")
        ? row.outcome.candidates.map((candidate) => (
            <label key={candidate.productId} className="import-mode">
              <input
                type="radio"
                name={name}
                checked={updating === candidate.productId}
                onChange={() => setChoice({ update: candidate.productId })}
              />
              <span>
                <b>{t("catalogImport.review.updateProduct")}</b>
                <Candidate candidate={candidate} />
              </span>
            </label>
          ))
        : null}
      {offered.includes("exclude") ? (
        <label className="import-mode">
          <input
            type="radio"
            name={name}
            checked={choice === "exclude"}
            onChange={() => setChoice("exclude")}
          />
          <span>
            <b>{t("catalogImport.review.exclude")}</b>
            <small>{t("catalogImport.review.excludeHint")}</small>
          </span>
        </label>
      ) : null}
    </fieldset>
  );
}

function RowDrawerBody({
  batch,
  row,
  review,
}: Readonly<{
  batch: CatalogImportBatch;
  row: CatalogImportRow;
  review: Review;
}>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const batchMode = batch.mode;
  const offered = offeredResolutions(batchMode, row);
  const { busy, choice } = review;
  const applying = busy !== null && busy !== "clear";
  return (
    <div className="import-step">
      <p className="import-step__why">
        {t.rich("catalogImport.review.inFile", { name: <RowProduct batch={batch} row={row} /> })}
      </p>
      <RowIssues row={row} />
      {row.status === "error" ? (
        <p className="import-step__why">{t("catalogImport.review.errorHint")}</p>
      ) : null}
      <DecisionOptions batchMode={batchMode} row={row} review={review} />
      {createBlockedByIdentifier(batchMode, row) && !offered.includes("create_new") ? (
        <p className="import-step__why">{t("catalogImport.review.createNotOffered")}</p>
      ) : null}
      {review.failure ? <FailureBanner failure={review.failure} /> : null}
      <div className="import-step__actions">
        <GatedButton
          className="btn-primary"
          busy={applying}
          disabled={choice === null || busy === "clear"}
          aria-describedby={choice === null ? `${id}-pick` : undefined}
          onClick={() => review.apply(row)}
        >
          {applying ? t("catalogImport.review.applying") : t("catalogImport.review.apply")}
        </GatedButton>
        {offered.includes("clear") ? (
          <GatedButton
            className="btn-secondary"
            busy={busy === "clear"}
            disabled={applying}
            onClick={() => void review.decide(row, "clear")}
          >
            {busy === "clear"
              ? t("catalogImport.review.removing")
              : t("catalogImport.review.remove")}
          </GatedButton>
        ) : null}
      </div>
      {choice === null ? (
        <p id={`${id}-pick`} className="import-step__why">
          {t("catalogImport.review.pickOne")}
        </p>
      ) : null}
    </div>
  );
}
