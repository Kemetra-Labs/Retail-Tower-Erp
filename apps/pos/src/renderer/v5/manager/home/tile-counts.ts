import { useEffect, useState } from 'react';

import type { ListStuckShiftsResponse } from '../../../../shared/bridge-api';
import { pluralAr, type ArabicPluralForms } from '../../../../shared/formatters/arabic-plural';
import type { RecoveryHeldView } from '../../../../shared/operator/recovery';
import { HOME_COPY } from './home-copy';

/**
 * RT-1193 — one attention count per manager-home tile, from reads that already
 * exist. A count is a figure plus text; it exists only for a clean answer above
 * zero. Loading, a refusal, a failed read and a missing bridge all give `null`,
 * so the tile shows nothing and never «0».
 */
export interface TileCount {
  readonly figure: number;
  readonly text: string;
}

function counted(figure: number, forms: ArabicPluralForms): TileCount | null {
  return Number.isSafeInteger(figure) && figure > 0
    ? { figure, text: pluralAr(figure, forms) }
    : null;
}

/**
 * The recovery tile: a stuck payment first (it blocks the terminal), otherwise
 * the held sales. The two are never summed into one unlabelled figure.
 */
export function recoveryTileCount(view: RecoveryHeldView | null): TileCount | null {
  if (view === null) return null;
  if (view.stuck !== null) return counted(1, HOME_COPY.counts.stuckPayment);
  return counted(view.held.length, HOME_COPY.counts.heldSales);
}

export function stuckShiftsTileCount(answer: ListStuckShiftsResponse): TileCount | null {
  return answer.kind === 'stuck_shifts'
    ? counted(answer.shifts.length, HOME_COPY.counts.stuckShifts)
    : null;
}

/** A read of the count; `null` = nothing to call (no bridge), so nothing shows. */
export type TileCountRead = () => Promise<TileCount | null> | null;

/**
 * Runs `read` once while `enabled`. `read` must have a stable identity (a
 * module-level function). A rejected read and an unmounted tile leave `null`.
 */
export function useTileCount(enabled: boolean, read: TileCountRead): TileCount | null {
  const [count, setCount] = useState<TileCount | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const pending = read();
    if (pending === null) return;
    let live = true;
    pending.then(
      (next) => {
        if (live) setCount(next);
      },
      () => {
        if (live) setCount(null);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, read]);
  return enabled ? count : null;
}
