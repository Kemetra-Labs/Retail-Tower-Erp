import { create } from 'zustand';

import type { ManualDiscountReasonCode } from '../../shared/cart/manual-discount';

/**
 * RT-855 — what the renderer itself knows about each manual discount it
 * added: the canonical token it sent, the reason chosen in the sheet, and the
 * approver's display name (the manager picked in the RT-114 prompt, or the
 * manager's own session). `cart.snapshot` deliberately carries none of this
 * (an opaque placeholder: no magnitude, no attribution), so a Sale screen that
 * re-reads its cart (Checkout and back, a remount) looks it up here by
 * placeholder id. Display only: nothing here is sent to main or trusted.
 */
export interface DiscountDetail {
  readonly token: string;
  readonly reasonCode: ManualDiscountReasonCode | null;
  readonly approverName: string | null;
}

interface DiscountDetailsStore {
  byPlaceholder: Readonly<Record<string, DiscountDetail>>;
  remember: (placeholderId: string, detail: DiscountDetail) => void;
  forget: (placeholderId: string) => void;
  reset: () => void;
}

export const useDiscountDetailsStore = create<DiscountDetailsStore>((set) => ({
  byPlaceholder: {},
  remember: (placeholderId, detail) => {
    set((s) => ({ byPlaceholder: { ...s.byPlaceholder, [placeholderId]: detail } }));
  },
  forget: (placeholderId) => {
    set((s) => {
      if (!(placeholderId in s.byPlaceholder)) return s;
      const next = Object.fromEntries(
        Object.entries(s.byPlaceholder).filter(([id]) => id !== placeholderId),
      );
      return { byPlaceholder: next };
    });
  },
  reset: () => {
    set({ byPlaceholder: {} });
  },
}));
