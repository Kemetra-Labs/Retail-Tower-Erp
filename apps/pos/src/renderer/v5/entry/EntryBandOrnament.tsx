import type { JSX } from 'react';

import './entry-band-ornament.css';

/**
 * RT-1093 (RT-1042 S4, OD-5) — the sign-in band's ornament: the skyline from
 * the brand bars, a ruler edge and the Tower grid, drawn as one static SVG
 * behind the band's content. The geometry is the approved reference's
 * (docs/design/rt-1042/prototype.html `skyline()`); the strokes, their
 * opacities (at most 40%) and the removal rules live in
 * entry-band-ornament.css, never here, so a colour is named once, as a role.
 *
 * Decorative only: `aria-hidden`, no focusable element, no motion. Only the
 * sign-in band opts in (`EntryBand` `ornament`); lock, which appears mid-sale,
 * and pairing, Ready and boot never draw it.
 */
const W = 1920; // the viewBox below is 0 0 1920 120
const H = 120;
const BAR_HEIGHTS = [52, 78, 60, 104, 82, 116, 68, 92, 56, 98, 72, 64, 46] as const;
const BAR_WIDTH = 40;
const BAR_GAP = 16;
const BAR_INSET = 40;
const RULER_HEIGHT = 12;

const SKYLINE = BAR_HEIGHTS.map((tick, i) => {
  const height = Math.round((tick / 116) * (H - 24));
  return {
    x: BAR_INSET + i * (BAR_WIDTH + BAR_GAP),
    y: H - height,
    height,
  };
});

export function EntryBandOrnament(): JSX.Element {
  return (
    <svg
      className="v5-entry-band__ornament"
      data-testid="entry-band-ornament"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1920 120"
      preserveAspectRatio="xMinYMax slice"
    >
      <defs>
        <pattern id="v5-entry-ornament-grid" width="26" height="26" patternUnits="userSpaceOnUse">
          <path className="v5-entry-band__ornament-grid" d="M26 0H0V26" fill="none" />
        </pattern>
        <pattern
          id="v5-entry-ornament-ruler"
          width="65"
          height={RULER_HEIGHT}
          patternUnits="userSpaceOnUse"
        >
          <path
            className="v5-entry-band__ornament-ruler"
            d="M6.5 12V8M19.5 12V8M32.5 12V8M45.5 12V8M58.5 12V3"
            fill="none"
          />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#v5-entry-ornament-grid)" />
      <rect
        y={H - RULER_HEIGHT}
        width={W}
        height={RULER_HEIGHT}
        fill="url(#v5-entry-ornament-ruler)"
      />
      <g className="v5-entry-band__ornament-skyline" fill="none">
        {SKYLINE.map((bar) => (
          <rect key={bar.x} x={bar.x} y={bar.y} width={BAR_WIDTH} height={bar.height} rx="3" />
        ))}
      </g>
    </svg>
  );
}
