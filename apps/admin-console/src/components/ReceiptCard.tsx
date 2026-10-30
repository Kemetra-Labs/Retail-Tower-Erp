/**
 * RT-992 receipt card (DESIGN.md §12.2, D-V5): a section-panel surface split by
 * a dashed perforation with half-circle notches at both inline edges. For KPI
 * cards and the payment summary only.
 *
 * It is one `<article>` named by its label. Top part: label, figure and an
 * optional icon tile at the inline end. Bottom part: the caller's children (the
 * delta chip and its comparison text). The perforation and its notches are
 * decoration (`aria-hidden`); the figure stays the caller's text, so the card
 * reads the same with no colour and no ornament.
 */
import { useId } from "react";
import type { ReactNode } from "react";
import "./receipt-card.css";

export function ReceiptCard({
  label,
  figure,
  icon,
  children,
}: Readonly<{
  /** The card's name: what the figure is. */
  label: ReactNode;
  /** The figure, already formatted (wrap digits in `<bdi dir="ltr">`). */
  figure: ReactNode;
  /** A decorative icon for the tile at the inline end. */
  icon?: ReactNode;
  /** The bottom part: delta chip and comparison text. */
  children: ReactNode;
}>): React.JSX.Element {
  const labelId = useId();
  return (
    <article className="receipt-card" aria-labelledby={labelId}>
      <div className="receipt-card__top">
        <div className="receipt-card__body">
          <span id={labelId} className="receipt-card__label">
            {label}
          </span>
          <span className="receipt-card__figure">{figure}</span>
        </div>
        {icon ? (
          <span className="receipt-card__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </div>
      <div className="receipt-card__perf" aria-hidden="true">
        <span className="receipt-card__rule" />
        <span className="receipt-card__notch receipt-card__notch--start" aria-hidden="true" />
        <span className="receipt-card__notch receipt-card__notch--end" aria-hidden="true" />
      </div>
      <div className="receipt-card__bottom">{children}</div>
    </article>
  );
}
