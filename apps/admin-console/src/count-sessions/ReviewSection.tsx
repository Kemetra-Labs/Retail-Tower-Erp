import { TableScrollRegion } from "@/components/DataTableScroll";
/**
 * RT-1425 — variance review (decision 831) and approval (833, G6-2, G6-10).
 *
 * Each line shows exactly what the server computed: expected at the cut, counted
 * (the sum of its positions), variance, flags and per-position observations,
 * rendered as sent and never parsed or summed here. A flagged line (divergence,
 * stale snapshot, pending) needs the reviewer's explicit acknowledgement, kept as
 * the exact `lineVersion` seen: a line that changed after review no longer counts
 * as acknowledged, and a refusal on a stale version re-reads the lines. A line the
 * server refuses (unmapped, UOM mismatch, count-up without valuation history)
 * cannot post and cannot be acknowledged into posting; the rest proceeds.
 *
 * Approve is offered once every page of lines is loaded. The approver separation
 * and the owner's small-merchant exception are decided by the server: this view
 * only notes that the viewer took part, and shows the typed refusal or the
 * resulting marker. Recount sends listed products back to capture (`cut_taken`).
 */
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { inventoryStatusKey } from "@/inventory/inventoryLogic";
import { Machine, Quantity, ReadError, StaleError } from "@/inventory/parts";
import {
  type CountSession,
  type CountVarianceLine,
  approveCountSession,
  requestCountRecount,
} from "@/lib/count-session-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useRef, useState } from "react";
import { OutcomeBanner, ProductLabel } from "./CountParts";
import {
  type Acknowledged,
  type CountOutcome,
  REASON_MAX,
  buildApproveCommand,
  canApprove,
  flagKey,
  isAcknowledged,
  isRefusedLine,
  isStaleLine,
  needsAcknowledgement,
  pendingAcknowledgements,
  refusalKey,
  settlesAttempt,
  tookPart,
} from "./countLogic";
import { type AllLines, useCountCommand } from "./useCounts";

interface Controls {
  /** Present only while the session is `submitted`: the reviewer's controls. */
  acked: Acknowledged;
  recount: ReadonlySet<string>;
  onAck: (line: CountVarianceLine, on: boolean) => void;
  onRecount: (productId: string, on: boolean) => void;
}

function LineRow({
  line,
  names,
  locationNames,
  controls,
}: Readonly<{
  line: CountVarianceLine;
  names: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  controls: Controls | null;
}>) {
  const t = useT();
  const label = names.get(line.productId) ?? line.productId;
  return (
    <tr className="data-table__row data-table__row--static" data-testid="count-line">
      <th scope="row">
        <ProductLabel id={line.productId} names={names} />
        <ul className="counts__positions">
          {line.observations.map((o) => (
            <li key={`${o.locationId}-${o.inventoryStatus}`}>
              <bdi dir="auto">{locationNames.get(o.locationId) ?? o.locationId}</bdi> ·{" "}
              {t(inventoryStatusKey(o.inventoryStatus))} · <Quantity value={o.countedQuantity} />
            </li>
          ))}
        </ul>
      </th>
      <td className="num">
        <Quantity value={line.expectedQuantity} /> <Machine value={line.stockingUnit} />
      </td>
      <td className="num">
        <Quantity value={line.countedQuantity} />
      </td>
      <td className="num" data-testid="count-variance">
        <Quantity value={line.varianceQuantity} />
      </td>
      <td>
        {line.flags.length === 0 ? <span className="muted">{t("counts.value.none")}</span> : null}
        {line.flags.map((f) => (
          <span key={f} className="badge badge--warning">
            {t(flagKey(f))}
          </span>
        ))}
        {line.refusal ? (
          <p className="counts__refusal" role="note">
            {t(refusalKey(line.refusal.code))}
          </p>
        ) : null}
      </td>
      <td>
        {controls && needsAcknowledgement(line) ? (
          <label className="counts__check">
            <input
              type="checkbox"
              checked={isAcknowledged(line, controls.acked)}
              onChange={(e) => controls.onAck(line, e.target.checked)}
              aria-label={t("counts.review.acknowledgeLine", { product: label })}
            />
            {t("counts.review.acknowledge")}
          </label>
        ) : null}
        {!controls && line.acknowledgement ? (
          <span className="badge badge--success">{t("counts.review.acknowledged")}</span>
        ) : null}
        {isRefusedLine(line) ? (
          <span className="badge badge--danger">{t("counts.review.cannotPost")}</span>
        ) : null}
        {controls ? (
          <label className="counts__check">
            <input
              type="checkbox"
              checked={controls.recount.has(line.productId)}
              onChange={(e) => controls.onRecount(line.productId, e.target.checked)}
              aria-label={t("counts.review.recountLine", { product: label })}
            />
            {t("counts.review.recount")}
          </label>
        ) : null}
      </td>
    </tr>
  );
}

function LinesTable({
  lines,
  names,
  locationNames,
  controls,
}: Readonly<{
  lines: readonly CountVarianceLine[];
  names: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  controls: Controls | null;
}>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {t("counts.review.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("counts.review.col.product")}</th>
              <th scope="col" className="num">
                {t("counts.review.col.expected")}
              </th>
              <th scope="col" className="num">
                {t("counts.review.col.counted")}
              </th>
              <th scope="col" className="num">
                {t("counts.review.col.variance")}
              </th>
              <th scope="col">{t("counts.review.col.flags")}</th>
              <th scope="col">{t("counts.review.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <LineRow
                key={l.productId}
                line={l}
                names={names}
                locationNames={locationNames}
                controls={controls}
              />
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function useReviewActions(session: CountSession, lines: AllLines) {
  const command = useCountCommand();
  const approveKey = useRef(new KeyedAttempt());
  const recountKey = useRef(new KeyedAttempt());
  const [acked, setAcked] = useState<Acknowledged>({});
  const [recount, setRecount] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

  const controls: Controls = {
    acked,
    recount,
    onAck: (line, on) =>
      setAcked((cur) => {
        const { [line.productId]: _removed, ...rest } = cur;
        return on ? { ...cur, [line.productId]: line.lineVersion } : rest;
      }),
    onRecount: (id, on) =>
      setRecount((cur) => {
        const next = new Set(cur);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
  };

  const approve = async () => {
    const body = buildApproveCommand(lines.rows, acked);
    const key = approveKey.current.keyFor(JSON.stringify(body));
    const result = await command.run(() =>
      approveCountSession(session.storeId, session.id, body, key),
    );
    setOutcome(result);
    if (settlesAttempt(result)) approveKey.current.settle();
    // A line changed after review: re-read every line; stale acknowledgements drop themselves.
    if (isStaleLine(result)) lines.retry();
  };

  const sendRecount = async () => {
    const trimmed = reason.trim();
    if (!trimmed) return setReasonMissing(true);
    setReasonMissing(false);
    const body = { productIds: [...recount], reason: trimmed };
    const key = recountKey.current.keyFor(JSON.stringify(body));
    const result = await command.run(() =>
      requestCountRecount(session.storeId, session.id, body, key),
    );
    setOutcome(result);
    if (settlesAttempt(result)) recountKey.current.settle();
    if (result.kind === "ok") setRecount(new Set());
  };

  return { controls, approve, sendRecount, reason, setReason, reasonMissing, outcome, command };
}

function ReviewActions({
  session,
  lines,
  actions,
}: Readonly<{
  session: CountSession;
  lines: AllLines;
  actions: ReturnType<typeof useReviewActions>;
}>) {
  const t = useT();
  const { context } = useActiveContextValue();
  const { controls, command } = actions;
  const pending = pendingAcknowledgements(lines.rows, controls.acked).length;
  const ready = canApprove(lines.rows, lines.complete, controls.acked);
  return (
    <div className="counts__review-actions">
      {tookPart(session, context?.user?.id) ? (
        <p className="counts__note" data-testid="count-took-part">
          {t("counts.approve.tookPart")}
        </p>
      ) : null}
      <p className="counts__note" aria-live="polite" data-testid="count-ack-progress">
        {lines.complete
          ? t("counts.approve.pending", { count: pending })
          : t("counts.approve.loadingLines")}
      </p>
      <OutcomeBanner outcome={actions.outcome} title={t("counts.approve.failed")} />
      <div className="counts__buttons">
        <GatedButton
          type="button"
          className="btn-primary"
          busy={command.isPending}
          disabled={!ready}
          onClick={actions.approve}
        >
          {command.isPending ? t("common.loading") : t("counts.approve.action")}
        </GatedButton>
      </div>
      <div className="field">
        <label htmlFor="count-recount-reason">{t("counts.recount.reason")}</label>
        <textarea
          id="count-recount-reason"
          className="input"
          rows={2}
          maxLength={REASON_MAX}
          value={actions.reason}
          aria-invalid={actions.reasonMissing ? true : undefined}
          onChange={(e) => actions.setReason(e.target.value)}
        />
        <InlineError
          message={actions.reasonMissing ? t("counts.recount.error.reason") : undefined}
        />
      </div>
      <GatedButton
        type="button"
        className="btn-secondary"
        busy={command.isPending}
        disabled={controls.recount.size === 0}
        onClick={actions.sendRecount}
      >
        {t("counts.recount.action", { count: controls.recount.size })}
      </GatedButton>
    </div>
  );
}

export function ReviewSection({
  session,
  lines,
  names,
  locationNames,
  index,
}: Readonly<{
  session: CountSession;
  lines: AllLines;
  names: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  index: number;
}>) {
  const t = useT();
  const actions = useReviewActions(session, lines);
  const reviewing = session.state === "submitted";
  let body: React.JSX.Element;
  if (lines.isLoading) {
    body = <ListState state="loading" label={t("counts.review.loadingNoun")} />;
  } else if (lines.error) {
    body = (
      <div className="counts__body">
        <ReadError
          error={lines.error}
          failedKey="counts.review.loadFailed"
          notFoundKey="counts.session.notFound"
          onRetry={lines.retry}
        />
      </div>
    );
  } else if (lines.rows.length === 0) {
    body = <ListState state="empty" emptyMessage={t("counts.review.empty")} />;
  } else {
    body = (
      <>
        <LinesTable
          lines={lines.rows}
          names={names}
          locationNames={locationNames}
          controls={reviewing ? actions.controls : null}
        />
        <div className="counts__body">
          <StaleError error={lines.inlineError} onRetry={lines.retry} />
        </div>
      </>
    );
  }
  return (
    <DetailPanel id="count-review" index={index} title={t("counts.review.title")}>
      <div className="counts__body">
        <p className="counts__note">{t("counts.review.sub")}</p>
      </div>
      {body}
      {reviewing ? (
        <div className="counts__body">
          <ReviewActions session={session} lines={lines} actions={actions} />
        </div>
      ) : null}
    </DetailPanel>
  );
}
