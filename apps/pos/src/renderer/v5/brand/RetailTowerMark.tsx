import type { JSX } from 'react';

/**
 * RT-1096 (RT-1042 S7, OD-8) — the three-bar «Retail Tower» mark the entry band
 * sets on its Mint tile. It is the board placeholder until the owner supplies
 * the new logo, so it is one swap point. Decorative: the wordmark beside it
 * names the product, and the tile that holds it is `aria-hidden`.
 */
export function RetailTowerMark(): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" width="60%" height="60%" fill="currentColor" focusable="false">
      <rect x="8" y="36" width="12" height="20" rx="3" />
      <rect x="26" y="22" width="12" height="34" rx="3" />
      <rect x="44" y="8" width="12" height="48" rx="3" />
    </svg>
  );
}
