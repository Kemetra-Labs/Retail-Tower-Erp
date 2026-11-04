import type { JSX } from 'react';

import './entry-band-ornament.css';

/**
 * RT-1093 (RT-1042 S4, OD-5) — the sign-in band's ornament: the skyline from
 * the brand bars, a ruler edge and the Tower grid, drawn as static SVG behind
 * the band's content. The geometry is the approved reference's
 * (docs/design/rt-1042/prototype.html `skyline()`), which draws two variants:
 * 1280×96 (28px bars, 10px gap) for the 96px band, and 1920×120 (40px bars,
 * 16px gap) for the 120px band at 1600 wide and up. Both render; the
 * stylesheet shows one. Strokes, their opacities (at most 40%) and the
 * removal rules live in entry-band-ornament.css, never here, so a colour is
 * named once, as a role.
 *
 * Decorative only: `aria-hidden`, no focusable element, no motion. Only the
 * sign-in band opts in (`EntryBand` `ornament`); lock, which appears mid-sale,
 * and pairing, Ready and boot never draw it.
 */
const BAR_HEIGHTS = [52, 78, 60, 104, 82, 116, 68, 92, 56, 98, 72, 64, 46] as const;
const BAR_INSET = 40;
const RULER_HEIGHT = 12;

type Variant = Readonly<{
  name: 'base' | 'wide';
  width: number;
  height: number;
  barWidth: number;
  barGap: number;
}>;

const BASE: Variant = { name: 'base', width: 1280, height: 96, barWidth: 28, barGap: 10 };
const WIDE: Variant = { name: 'wide', width: 1920, height: 120, barWidth: 40, barGap: 16 };

function Skyline({ variant }: Readonly<{ variant: Variant }>): JSX.Element {
  const { name, width, height, barWidth, barGap } = variant;
  const grid = `v5-entry-ornament-grid-${name}`;
  const ruler = `v5-entry-ornament-ruler-${name}`;
  return (
    <svg
      className={`v5-entry-band__ornament v5-entry-band__ornament--${name}`}
      data-testid={`entry-band-ornament-${name}`}
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="xMinYMax slice"
    >
      <defs>
        <pattern id={grid} width="26" height="26" patternUnits="userSpaceOnUse">
          <path className="v5-entry-band__ornament-grid" d="M26 0H0V26" fill="none" />
        </pattern>
        <pattern id={ruler} width="65" height={RULER_HEIGHT} patternUnits="userSpaceOnUse">
          <path
            className="v5-entry-band__ornament-ruler"
            d="M6.5 12V8M19.5 12V8M32.5 12V8M45.5 12V8M58.5 12V3"
            fill="none"
          />
        </pattern>
      </defs>
      <rect width={width} height={height} fill={`url(#${grid})`} />
      <rect y={height - RULER_HEIGHT} width={width} height={RULER_HEIGHT} fill={`url(#${ruler})`} />
      <g className="v5-entry-band__ornament-skyline" fill="none">
        {BAR_HEIGHTS.map((tick, i) => {
          const barHeight = Math.round((tick / 116) * (height - 24));
          return (
            <rect
              key={String(i)}
              x={BAR_INSET + i * (barWidth + barGap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx="3"
            />
          );
        })}
      </g>
    </svg>
  );
}

export function EntryBandOrnament(): JSX.Element {
  return (
    <>
      <Skyline variant={BASE} />
      <Skyline variant={WIDE} />
    </>
  );
}
