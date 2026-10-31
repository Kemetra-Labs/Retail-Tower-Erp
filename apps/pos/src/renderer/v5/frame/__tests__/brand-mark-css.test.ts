import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-1024 (UX-02, owner decision 2026-10-31: "soft tile") — the brand mark at
 * the top of the rail is decorative, so it must not wear the commit colour.
 * DESIGN.md Commit-Teal Rule: filled teal is for the primary commit; selection
 * is a Teal Wash with Tower Teal ink. happy-dom resolves no cascade, so these
 * read the source; the nav-rail captures are the visual proof.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const frame = strip(readFileSync(resolve(__dirname, '../frame.css'), 'utf-8'));
const tokens = strip(readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf-8'));

/** The declarations of the first top-level rule for `selector` (outside any @media). */
function baseRule(css: string, selector: string): string {
  const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const rule of topLevel.split('}')) {
    const [selectors, body] = rule.split('{');
    if (body === undefined || selectors === undefined) continue;
    if (selectors.split(',').some((s) => s.trim() === selector)) return body;
  }
  throw new Error(`no base rule for ${selector}`);
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('RT-1024 — the brand mark is a soft tile, not a commit-coloured fill', () => {
  const mark = baseRule(frame, '.v5-frame__brand-mark');

  it('paints the Teal Wash with Tower Teal ink', () => {
    expect(mark).toMatch(/background:\s*var\(--color-primary-soft\)/);
    expect(mark).toMatch(/(?<![-\w])color:\s*var\(--color-primary\)\s*;/);
  });

  it('no longer fills with the primary or draws white ink', () => {
    expect(mark).not.toMatch(/background:\s*var\(--color-primary\)\s*;/);
    expect(mark).not.toMatch(/--color-primary-on/);
  });

  it('keeps its size and radius', () => {
    expect(mark).toMatch(/inline-size:\s*32px/);
    expect(mark).toMatch(/block-size:\s*32px/);
    expect(mark).toMatch(/border-radius:\s*var\(--radius-control\)/);
  });

  it('the cross keeps at least 3:1 on the wash (WCAG 1.4.11)', () => {
    const tokenOf = (name: string): string => {
      const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
      if (!found?.[1]) throw new Error(`token ${name} is not a light hex value`);
      return found[1];
    };
    expect(
      contrast(tokenOf('--color-primary'), tokenOf('--color-primary-soft')),
    ).toBeGreaterThanOrEqual(3);
  });
});
