/**
 * RT-1601 the proposal's lines: product, from → to, quantity, line warnings, the review decision and
 * the accept outcome. Review ("would accept" / "would reject") works in both phases and creates
 * nothing. In the live phase a line with no outcome can be selected for accept; selection is the
 * command context, and the row itself is not a click target (UX-10.3-.4).
 */
import { useT } from "@/i18n";
import { Machine, Quantity, Unit } from "@/inventory/parts";
import { CaptionedTable, StoreName } from "@/inventory/transfers/TransferParts";
import type {
  RedistributionProposal,
  RedistributionProposalLine,
  RedistributionReviewDecisionValue,
} from "@/lib/redistribution-queries";
import { OutcomeCell } from "./RedistributionParts";
import { lineActions, warningKey } from "./redistributionLogic";

export interface LinesProps {
  proposal: RedistributionProposal;
  storeNames: ReadonlyMap<string, string>;
  productName: (productId: string) => string | undefined;
  selected: ReadonlySet<string>;
  onToggle: (lineId: string) => void;
  /** A review is in flight for this line: its buttons wait. */
  reviewing: string | null;
  onReview: (lineId: string, decision: RedistributionReviewDecisionValue) => void;
}

function ProductCell({ id, name }: Readonly<{ id: string; name?: string }>): React.JSX.Element {
  return name ? <bdi dir="auto">{name}</bdi> : <Machine value={id} />;
}

function ReviewCell({
  line,
  canReview,
  busy,
  label,
  onReview,
}: Readonly<{
  line: RedistributionProposalLine;
  canReview: boolean;
  busy: boolean;
  label: string;
  onReview: LinesProps["onReview"];
}>): React.JSX.Element {
  const t = useT();
  const current = line.reviewDecision?.decision ?? null;
  const decided = current
    ? t(
        current === "would_accept"
          ? "redistribution.review.wouldAccept"
          : "redistribution.review.wouldReject",
      )
    : t("redistribution.review.none");
  if (!canReview) return <span>{decided}</span>;
  return (
    <fieldset className="redistribution__review" aria-label={label} disabled={busy}>
      {(["would_accept", "would_reject"] as const).map((decision) => (
        <button
          key={decision}
          type="button"
          className={current === decision ? "btn-primary" : "btn-secondary"}
          aria-pressed={current === decision}
          onClick={() => onReview(line.id, decision)}
        >
          {t(
            decision === "would_accept"
              ? "redistribution.review.wouldAccept"
              : "redistribution.review.wouldReject",
          )}
        </button>
      ))}
    </fieldset>
  );
}

function LineRow({
  line,
  props,
}: Readonly<{ line: RedistributionProposalLine; props: LinesProps }>): React.JSX.Element {
  const t = useT();
  const actions = lineActions(props.proposal, line);
  const name = props.productName(line.productId);
  const label = t("redistribution.lines.rowLabel", { product: name ?? line.productId });
  return (
    <tr className="data-table__row">
      {props.proposal.acceptEnabled ? (
        <td>
          {actions.accept ? (
            <input
              type="checkbox"
              checked={props.selected.has(line.id)}
              onChange={() => props.onToggle(line.id)}
              aria-label={t("redistribution.lines.select", { product: name ?? line.productId })}
            />
          ) : null}
        </td>
      ) : null}
      <td>
        <ProductCell id={line.productId} name={name} />
      </td>
      <td>
        {t.rich("redistribution.lines.route", {
          source: <StoreName id={line.sourceStoreId} names={props.storeNames} />,
          destination: <StoreName id={line.destinationStoreId} names={props.storeNames} />,
        })}
      </td>
      <td className="data-table__cell--num">
        <Quantity value={line.quantity} /> <Unit unit={line.stockingUnit} />
      </td>
      <td>
        {line.warnings.length === 0
          ? "—"
          : line.warnings.map((w) => t(warningKey(w.code))).join(" · ")}
      </td>
      <td>
        <ReviewCell
          line={line}
          canReview={actions.review}
          busy={props.reviewing === line.id}
          label={label}
          onReview={props.onReview}
        />
      </td>
      <td>{line.acceptOutcome ? <OutcomeCell outcome={line.acceptOutcome} /> : "—"}</td>
    </tr>
  );
}

export function RedistributionLines(props: Readonly<LinesProps>): React.JSX.Element {
  const t = useT();
  return (
    <CaptionedTable caption={t("redistribution.lines.caption")}>
      <thead>
        <tr>
          {props.proposal.acceptEnabled ? (
            <th scope="col">
              <span className="sr-only">{t("redistribution.lines.col.select")}</span>
            </th>
          ) : null}
          <th scope="col">{t("redistribution.lines.col.product")}</th>
          <th scope="col">{t("redistribution.lines.col.route")}</th>
          <th scope="col">{t("redistribution.lines.col.quantity")}</th>
          <th scope="col">{t("redistribution.lines.col.warnings")}</th>
          <th scope="col">{t("redistribution.lines.col.review")}</th>
          <th scope="col">{t("redistribution.lines.col.outcome")}</th>
        </tr>
      </thead>
      <tbody>
        {props.proposal.lines.map((line) => (
          <LineRow key={line.id} line={line} props={props} />
        ))}
      </tbody>
    </CaptionedTable>
  );
}
