import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-1096 (RT-1042 S7) — source checks for the entry band's stylesheet and the
 * boot screen's additions. happy-dom resolves no layout; the captures are the
 * visual proof.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const band = strip(readFileSync(resolve(__dirname, '../entry-band.css'), 'utf-8'));
const routeStates = strip(
  readFileSync(resolve(__dirname, '../../foundation/route-states.css'), 'utf-8'),
);

function forcedBlock(source: string): string {
  const start = source.indexOf('@media (forced-colors: active)');
  if (start === -1) return '';
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(source.indexOf('{', start) + 1, i);
  }
  return '';
}

describe('RT-1096 entry-band.css', () => {
  it('names the roles, never spells a colour', () => {
    expect(band).toMatch(/var\(--color-ink\)/);
    expect(band).toMatch(/var\(--color-on-ink\)/);
    expect(band).toMatch(/var\(--color-mint\)/);
    expect(band).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(band).not.toMatch(/rgba?\(/i);
  });

  it('puts Mint only on the mark tile, never as text or on a light surface', () => {
    const uses = [...band.matchAll(/([^{}]+)\{([^}]*var\(--color-mint\)[^}]*)\}/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, selector, body] of uses) {
      expect(selector?.trim()).toBe('.v5-entry-band__mark');
      expect(body).toMatch(/background\s*:\s*var\(--color-mint\)/);
      expect(body).not.toMatch(/(?:^|[;\s])color\s*:\s*var\(--color-mint\)/);
    }
  });

  it('has no shadow and no gradient (flat, OD-4)', () => {
    expect(band).not.toMatch(/box-shadow\s*:\s*(?!none)/);
    expect(band).not.toMatch(/gradient\(/);
  });

  it('under forced colours the band is Canvas with a 1px CanvasText edge and no Mint', () => {
    const forced = forcedBlock(band);
    expect(forced).toMatch(/background\s*:\s*Canvas/);
    expect(forced).toMatch(/color\s*:\s*CanvasText/);
    expect(forced).toMatch(/border-block-end\s*:\s*1px solid CanvasText/);
    expect(forced).not.toMatch(/var\(--color-mint\)/);
  });

  it('keeps the band short enough for the 1024×600 floor', () => {
    expect(band).toMatch(/--entry-band-size:\s*52px/);
  });
});

describe('RT-1096 boot screen stylesheet', () => {
  it('adds the entry modifier without touching the shared state rules', () => {
    expect(routeStates).toMatch(/\.v5-route-state--entry\s*\{/);
    expect(routeStates).toMatch(/\.v5-route-state__stage\s*\{/);
  });
});
