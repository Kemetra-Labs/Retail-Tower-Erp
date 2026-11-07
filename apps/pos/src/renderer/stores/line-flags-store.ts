import { create } from 'zustand';

import type { ProductSnapshotDisplay } from '../../shared/catalogue/product-snapshot.js';

/**
 * RT-242 (D-C1, M-S9) — the awareness flags of the product each cart line was
 * added from, keyed by `line_id`.
 *
 * No cart read model carries product flags (`cart.lines.add` and
 * `cart.snapshot` return a name and a price only), so the renderer keeps what
 * it saw at add time. Display only (I-17: no prescription workflow). The map
 * survives a remount of the Sale (Back from Checkout) because it lives here,
 * not in the screen. It is renderer-session state, so RT-1178 also refills it
 * from every `cart.snapshot` the Sale applies (`rememberSnapshot`): main reads
 * each line's flags from the local catalogue, so a line read back after a
 * reload or an app restart keeps its badge.
 */
export type LineFlags = Pick<
  ProductSnapshotDisplay,
  'controlled_substance' | 'prescription_required'
>;

interface LineFlagsState {
  readonly byLine: Readonly<Record<string, LineFlags>>;
  /** Record the flags of the product a confirmed add landed on; unflagged products are not stored. */
  remember(lineId: string, product: LineFlags): void;
  /** RT-1178 — record the flags of every flagged line in a cart snapshot. */
  rememberSnapshot(lines: ReadonlyArray<LineFlags & { readonly line_id: string }>): void;
  reset(): void;
}

export const useLineFlagsStore = create<LineFlagsState>((set, get) => ({
  byLine: {},
  remember: (lineId, product) => {
    if (!product.controlled_substance && !product.prescription_required) return;
    set((s) => ({
      byLine: {
        ...s.byLine,
        [lineId]: {
          controlled_substance: product.controlled_substance,
          prescription_required: product.prescription_required,
        },
      },
    }));
  },
  rememberSnapshot: (lines) => {
    for (const line of lines) get().remember(line.line_id, line);
  },
  reset: () => {
    set({ byLine: {} });
  },
}));
