/**
 * RT-1403 S2 (M1) — the terminal's ONE cash drawer, as a slot a payout holds while it works.
 *
 * A return payout (RT-15) and a void payout (RT-1403) both kick the same drawer and hand out cash,
 * so they share one slot: while one runs, the other is refused (`another_payout_in_progress`),
 * never queued (a hidden cash operation must not start later on its own). Process-local by design:
 * cross-process exclusion relies on RT-203's Electron single-instance lock (one app process per
 * terminal), as the returns payout always did.
 */
export interface DrawerSlot {
  /** Take the slot; null while another payout holds it. The release is idempotent. */
  tryAcquire(): (() => void) | null;
  /** True while a payout holds the slot. */
  busy(): boolean;
}

export function createDrawerSlot(): DrawerSlot {
  let held = false;
  return {
    tryAcquire() {
      if (held) return null;
      held = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held = false;
      };
    },
    busy: () => held,
  };
}

/** The slot of this terminal: composed once into the returns and the void payout (production). */
export const terminalDrawerSlot: DrawerSlot = createDrawerSlot();
