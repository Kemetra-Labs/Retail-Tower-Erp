import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-1091 (RT-1042 S2) — the entry-surface Ink and Mint tokens.
 *
 * Owner decision OD-1 (2026-11-03) adopts the Console's four Ink roles for the
 * entry screens only; docs/DESIGN.md "Colour on the entry screens" holds the
 * values. This slice adds the tokens with no consumer, so the guard pins three
 * things the consumers (S3 sign-in, S6 lock, S7 pairing / Ready / boot) rely on:
 *
 *   1. the four names and their values, hand-copied from DESIGN.md;
 *   2. the scope: declared on `[data-entry-surface]` only, and in no :root,
 *      dark register or @theme, so they cannot resolve on the sale, checkout
 *      or recovery surfaces (and Tailwind emits no `bg-ink` / `text-mint`);
 *   3. the contrast pairs, computed from the parsed values.
 *
 * It does not forbid consumers: S3, S6 and S7 add them without editing this file.
 */

const RENDERER = resolve(__dirname, '../..');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tailwind = stripComments(readFileSync(resolve(RENDERER, 'styles/tailwind.css'), 'utf-8'));

/** Declarations of the first top-level rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  const decls = new Map<string, string>();
  for (const part of (match[1] ?? '').split(';')) {
    const [name, ...value] = part.split(':');
    if (name !== undefined && value.length > 0) decls.set(name.trim(), value.join(':').trim());
  }
  return decls;
}

/** The body of a top-level block whose opener is `selector`, braces balanced (for `@theme`). */
function blockBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no block for ${selector}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error(`unbalanced block for ${selector}`);
}

const ENTRY_SCOPE = '[data-entry-surface]';

/** DESIGN.md "Colour on the entry screens", hand-copied. Names are the Console's (RT-414). */
const ROLES: ReadonlyArray<[string, string]> = [
  ['--color-ink', '#0a2125'],
  ['--color-on-ink', '#ffffff'],
  ['--color-ink-muted', '#a9c2c5'],
  ['--color-mint', '#5fe0cf'],
];
const NAMES = ROLES.map(([name]) => name);

const scope = declarations(tailwind, ENTRY_SCOPE);
const value = (name: string): string => scope.get(name) ?? '';

/** WCAG relative luminance / contrast ratio for two #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => {
    const h = hex.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('RT-1091 — entry-surface Ink and Mint: names and values (OD-1)', () => {
  it.each(ROLES)('%s is %s', (name, hex) => {
    expect(value(name)).toBe(hex);
  });

  it('declares exactly the four Console roles, nothing else', () => {
    expect([...scope.keys()].sort()).toEqual([...NAMES].sort());
  });

  it('adds no Mint role beyond --color-mint (Ink text on a Mint tile is --color-ink)', () => {
    expect(NAMES.filter((name) => name.includes('mint'))).toEqual(['--color-mint']);
  });
});

describe("RT-1091 — entry-surface Ink and Mint: scope (OD-1, DESIGN.md Don'ts)", () => {
  const rootBlock = declarations(tailwind, ':root');
  const darkBlock = declarations(tailwind, ":root[data-theme='dark']");
  const themeBlock = blockBody(tailwind, '@theme');

  it.each(NAMES)(
    '%s is not a :root token, so it does not resolve outside an entry surface',
    (name) => {
      expect(rootBlock.has(name)).toBe(false);
    },
  );

  it.each(NAMES)('%s is not in the dark register: Ink is dark in both themes', (name) => {
    expect(darkBlock.has(name)).toBe(false);
  });

  it('adds nothing to @theme, so Tailwind emits no global bg-ink / text-mint utility', () => {
    for (const name of NAMES) expect(themeBlock).not.toContain(name);
  });

  it('is declared once, on the opt-in attribute and nowhere else', () => {
    for (const name of NAMES) {
      const declared = [...tailwind.matchAll(new RegExp(`(?:^|[;{\\s])${name}\\s*:`, 'g'))];
      expect(declared, name).toHaveLength(1);
    }
  });

  it("the hook is not FitGuard's `data-surface`: FitGuard does not set it, and the scope is a distinct attribute", () => {
    const fitGuard = readFileSync(resolve(RENDERER, 'v5/foundation/FitGuard.tsx'), 'utf-8');
    expect(fitGuard).toContain('data-surface={');
    expect(fitGuard).not.toContain('data-entry-surface');
    expect(tailwind).not.toMatch(/\[data-surface\b/);
  });
});

/** Source files under the renderer directories that own the sale, checkout and recovery surfaces. */
const NON_ENTRY_DIRS = [
  'sale',
  'returns',
  'ui/payments',
  'v5/sale',
  'v5/checkout',
  'v5/recovery',
  'v5/park',
  'v5/void',
  'v5/shift',
  'v5/manager',
  'v5/frame',
  'v5/printer',
  'routes/app',
  'ui/receipts',
  'ui/states',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return /\.(css|ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe('RT-1091 — entry-surface Ink and Mint: kept off the sale, checkout and recovery surfaces', () => {
  const files = NON_ENTRY_DIRS.flatMap((dir) => sourceFiles(resolve(RENDERER, dir)));
  const usage = new RegExp(
    `${NAMES.map((name) => `${name}(?![a-z0-9-])`).join('|')}|data-entry-surface`,
  );

  it('scans a non-trivial number of files (the sweep cannot silently go blind)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('none of them uses an Ink or Mint role, or opts into the entry scope', () => {
    const offenders = files.filter((file) =>
      usage.test(stripComments(readFileSync(file, 'utf-8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern catches a violation (mutation check)', () => {
    expect(usage.test('background: var(--color-ink);')).toBe(true);
    expect(usage.test('color: var(--color-ink-muted)')).toBe(true);
    expect(usage.test('<main data-entry-surface>')).toBe(true);
    expect(usage.test('background: var(--color-primary);')).toBe(false);
  });
});

describe('RT-1091 — entry-surface Ink and Mint: contrast pairs', () => {
  const ink = value('--color-ink');
  const onInk = value('--color-on-ink');
  const muted = value('--color-ink-muted');
  const mint = value('--color-mint');
  const white = '#ffffff'; // the light card surface DESIGN.md measures Mint against

  it('on-ink text on Ink clears AAA (16.7:1)', () => {
    expect(contrastRatio(onInk, ink)).toBeGreaterThanOrEqual(7);
  });

  it('ink-muted text on Ink is the 8.9:1 DESIGN.md names, and clears AA', () => {
    const ratio = contrastRatio(muted, ink);
    expect(ratio).toBeCloseTo(8.9, 1);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('Mint on Ink clears AA as text and the 3:1 non-text floor (10.4:1)', () => {
    expect(contrastRatio(mint, ink)).toBeGreaterThanOrEqual(4.5);
  });

  it('the Ink glyph on a Mint tile clears AA (10.4:1)', () => {
    expect(contrastRatio(ink, mint)).toBeGreaterThanOrEqual(4.5);
  });

  it('Mint on a light surface is the 1.6:1 that bans it there', () => {
    const ratio = contrastRatio(mint, white);
    expect(ratio).toBeCloseTo(1.6, 1);
    expect(ratio).toBeLessThan(3);
  });
});
