import type { JSX } from 'react';
import { ToneIcon, type Tone } from '../foundation/ToneIcon';

/**
 * RT-243 W1-C (freeze 15 §4 A4) — the completion list of facts, built from
 * state lines. It renders exactly what its caller passes, so the rule lives at
 * the call site: an item is `success` only when the fact is proven for THIS
 * sale (freeze 15 §4 status roles). A fact that is pending or not proven is
 * `info`; a degraded one is `warning`; a fact the terminal cannot establish is
 * left out rather than shown as success.
 *
 * `neutral` is a proven value that is not a status, such as the change to hand
 * back (M-P5): it carries no tone glyph and no tone colour.
 */
export type ProofTone = Tone | 'neutral';

export interface ProofItem {
  readonly id: string;
  readonly tone: ProofTone;
  readonly label: string;
  /** A human amount or reference; rendered as an isolated LTR run. */
  readonly value?: string;
  /**
   * How large the value reads: `hero` for the settled amount (FR-16, the
   * dominant figure), `strong` for a figure the cashier acts on (M-P5).
   */
  readonly emphasis?: 'hero' | 'strong';
  /**
   * A secondary reference under the line, such as the exact sale number next to
   * its short form (UX-10 "scan short, inspect exact"). An isolated LTR run the
   * cashier can select and copy; it never carries a status.
   */
  readonly detail?: string;
  readonly detailTestId?: string | undefined;
  readonly testId?: string | undefined;
  readonly valueTestId?: string | undefined;
}

interface ProofListProps {
  readonly items: readonly ProofItem[];
  readonly label: string;
}

export function ProofList({ items, label }: ProofListProps): JSX.Element {
  return (
    <ul className="v5-proof-list" aria-label={label}>
      {items.map((item) => (
        <li
          key={item.id}
          className="v5-proof-line"
          data-tone={item.tone}
          data-emphasis={item.emphasis}
          data-testid={item.testId}
        >
          {item.tone !== 'neutral' && <ToneIcon tone={item.tone} />}
          <span className="v5-proof-line__label">{item.label}</span>
          {item.value !== undefined && (
            <bdi className="v5-proof-line__value" dir="ltr" data-testid={item.valueTestId}>
              {item.value}
            </bdi>
          )}
          {item.detail !== undefined && (
            <bdi className="v5-proof-line__detail" dir="ltr" data-testid={item.detailTestId}>
              {item.detail}
            </bdi>
          )}
        </li>
      ))}
    </ul>
  );
}
