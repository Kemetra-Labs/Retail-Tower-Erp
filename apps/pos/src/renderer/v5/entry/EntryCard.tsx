import type { JSX, ReactNode } from 'react';

import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import { EntryBand } from './EntryBand';
import './entry.css';

/**
 * RT-244 PR2 (G-1 references) — the Ready and pairing screens: one centred
 * card of about 440px with one sentence and one commit. On Ready the terminal
 * label is the card's one fact.
 *
 * RT-1096 (RT-1042 S7): the root opts into the entry-surface Ink and Mint roles
 * and carries the Ink band (`EntryBand`) instead of the sign-in strip, so the
 * sign-in recomposition (S3) and this screen do not share a header.
 *
 * `rootProps` carries the route's test id and data attributes, which the boot
 * router tests read from the root element.
 */
export function EntryCardScreen({
  children,
  rootProps,
}: Readonly<{
  children: ReactNode;
  rootProps: Readonly<Record<string, string>>;
}>): JSX.Element {
  return (
    <main className="v5-entry" dir="rtl" lang="ar" data-entry-surface="" {...rootProps}>
      <EntryBand />
      <div className="v5-entry__center">{children}</div>
    </main>
  );
}

/** The card's leading glyph: decorative, the heading beside it carries the meaning. */
export function EntryCardIcon({ name }: Readonly<{ name: IconName }>): JSX.Element {
  return (
    <span className="v5-entry__card-icon" aria-hidden="true">
      <Icon name={name} size="lg" />
    </span>
  );
}
