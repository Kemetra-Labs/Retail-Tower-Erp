import { useId, type JSX, type ReactNode } from 'react';

import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Notice } from '../foundation/Notice';
import { formatShiftTime } from '../shift/shift-format';

/**
 * RT-654 — small pieces shared by the void screen and its dialog.
 *
 * - The sale number is an LTR monospace ID run and amounts are LTR runs in the
 *   money family (RT-833); each is its own <bdi dir="ltr">. Arabic text never
 *   takes the mono face (DESIGN.md numerals).
 * - A refusal is a V5 warning notice. It keeps the `alert` role the screen
 *   announced it with before (ShiftAlert), so the outer box announces and the
 *   notice itself stays quiet: one announcement per message.
 */
export function VoidCode({
  value,
  className,
}: Readonly<{ value: string; className?: string }>): JSX.Element {
  return (
    <bdi dir="ltr" className={className === undefined ? 'v5-void-id' : `v5-void-id ${className}`}>
      {value}
    </bdi>
  );
}

export function VoidMoney({
  minor,
  className,
}: Readonly<{ minor: number; className?: string }>): JSX.Element {
  return (
    <bdi
      dir="ltr"
      className={className === undefined ? 'v5-void-money' : `v5-void-money ${className}`}
    >
      {formatCheckoutMoney(minor)}
    </bdi>
  );
}

export function VoidAlert({ message }: Readonly<{ message: string }>): JSX.Element {
  return (
    <div role="alert" className="v5-void-alert">
      <Notice tone="warning" announce={false}>
        {message}
      </Notice>
    </div>
  );
}

/** An absolute Arabic date and time: the text face with tabular digits (never monospace). */
export function VoidTime({ iso }: Readonly<{ iso: string }>): JSX.Element {
  return (
    <time className="v5-void-when" dateTime={iso}>
      {formatShiftTime(iso)}
    </time>
  );
}

/** A void-screen panel: a heading row and its body; `hug` sizes it to its content. */
export function VoidPanel(
  props: Readonly<{ title: string; hug?: boolean; children: ReactNode }>,
): JSX.Element {
  const headingId = useId();
  return (
    <section
      className={props.hug === true ? 'v5-void-panel v5-void-panel--hug' : 'v5-void-panel'}
      aria-labelledby={headingId}
    >
      <div className="v5-void-panel-head">
        <h2 id={headingId}>{props.title}</h2>
      </div>
      {props.children}
    </section>
  );
}
