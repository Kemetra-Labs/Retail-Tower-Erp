import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

import { FIRST_ENABLED_TENDER_TILE } from './payment-surface-logic.js';

/**
 * RT-1226 — the I-9 duplicate-press guards of the settle commit and the method
 * tiles, moved out of the PaymentSurface body unchanged.
 */

/** A held or doubled Enter right after focus moved here is not a decision to settle. */
const COMMIT_ARM_MS = 400;

/**
 * I-9 duplicate-submit: the Enter that applied the cash can repeat (key held)
 * or be tapped twice, and focus has just moved onto the settle commit. Swallow
 * an Enter that is a key repeat or arrives inside the arm window. Pointer and
 * programmatic clicks are not affected.
 */
export function guardCommitKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  commitFocusedAtRef: RefObject<number>,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const tooSoon = Date.now() - commitFocusedAtRef.current < COMMIT_ARM_MS;
  if (event.repeat || tooSoon) event.preventDefault();
}

/**
 * RT-761 (same I-9 pattern as the settle commit): arriving at Checkout puts
 * focus on the first method tile, and the Enter that left the Sale on
 * «المتابعة إلى الدفع» can repeat (key held) or be tapped twice. Swallow an
 * Enter/Space that is a key repeat or lands inside the arm window, so it never
 * starts a payment. Pointer clicks and later, deliberate keys are not affected.
 * In Chromium, preventing the keydown also suppresses Enter's click and the click
 * that Space would fire on keyup; another engine would need the keyup guarded too.
 */
export function guardTileKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  tileFocusedAtRef: RefObject<number>,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.repeat) {
    event.preventDefault();
    return;
  }
  // The arm window belongs to the tile that arrival focus landed on; a tile the
  // cashier has since tabbed to activates normally.
  const onArrivalTile = event.currentTarget === document.querySelector(FIRST_ENABLED_TENDER_TILE);
  if (onArrivalTile && Date.now() - tileFocusedAtRef.current < COMMIT_ARM_MS) {
    event.preventDefault();
  }
}
