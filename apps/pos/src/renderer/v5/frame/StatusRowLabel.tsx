import type { JSX } from 'react';
import { STATUS_ROW_LABEL, type StatusRowName } from '../../terminal-status/status-copy';

/**
 * RT-1023 (owner decision 2026-10-31) — a status row's one-word name, shown
 * under its glyph in the slim rail only (`status-indicator.css`). Hidden from
 * assistive tech, which reads the row's full text instead, so names and the
 * connection row's announcement do not change.
 */
export function StatusRowLabel({ name }: Readonly<{ name: StatusRowName }>): JSX.Element {
  return (
    <span className="v5-status__label" aria-hidden="true">
      {STATUS_ROW_LABEL[name]}
    </span>
  );
}
