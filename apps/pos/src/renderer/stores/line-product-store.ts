import { create } from 'zustand';

/**
 * RT-1578 (RT-1511 S3) — the catalogue `product_id` each cart line was added from, keyed by `line_id`.
 *
 * The cart read model carries no product id (RT-1178 keeps the catalogue item_ref out of the renderer), so,
 * like the add-time flags, the renderer keeps what it saw at add time. It only feeds the availability badge
 * on the cart line (display only, spec 013 FR-5): a line read back after a reload or restart has no entry,
 * and then shows no badge rather than a guess.
 */
interface LineProductState {
  readonly byLine: Readonly<Record<string, string>>;
  remember(lineId: string, productId: string): void;
  reset(): void;
}

export const useLineProductStore = create<LineProductState>((set) => ({
  byLine: {},
  remember: (lineId, productId) => {
    set((s) => ({ byLine: { ...s.byLine, [lineId]: productId } }));
  },
  reset: () => {
    set({ byLine: {} });
  },
}));
