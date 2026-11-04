import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-1092 (RT-1042 S3) — guards for the sign-in screen's B-lite stylesheet.
 * happy-dom resolves no layout, so these are source checks (tripwires); the
 * fit captures and the packaged run (S8, RT-1097) are the visual proof.
 */

const css = readFileSync(resolve(__dirname, '../sign-in.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Each top-level or nested rule as [selector, body]. */
function rules(source: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push([(match[1] ?? '').trim(), match[2] ?? '']);
  }
  return out;
}

/** The concatenated bodies of every `@media <query>` block. */
function mediaBlocks(source: string, query: RegExp): string {
  const out: string[] = [];
  const opener = new RegExp(`@media\\s*${query.source}\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(source.slice(start, i - 1));
  }
  return out.join('\n');
}

function pxVar(body: string, name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)px`).exec(body);
  if (match === null) throw new Error(`--${name} has no px value here`);
  return Number(match[1]);
}

const profileRule = /\.v5-entry\.v5-entry--sign-in\s*\{([^}]*)\}/;
const base = profileRule.exec(css)?.[1] ?? '';
const pilot = profileRule.exec(mediaBlocks(css, /\(min-width:\s*1600px\)/))?.[1] ?? '';
const compact = profileRule.exec(mediaBlocks(css, /\(max-width:\s*1279px\)/))?.[1] ?? '';
const short = profileRule.exec(mediaBlocks(css, /\(max-height:\s*767px\)/))?.[1] ?? '';
const forced = mediaBlocks(css, /\(forced-colors:\s*active\)/);

describe('RT-1092 sign-in.css — tokens and scope', () => {
  it('pins no raw colour literal: every colour is a token or a system colour', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(|hsla?\(/);
  });

  it('is flat: no shadow (OD-4, Borders Before Shadows)', () => {
    expect(css).not.toMatch(/box-shadow/);
  });

  it('uses Ink and Mint only on the band (OD-1)', () => {
    const outside = rules(css).filter(
      ([selector, body]) =>
        /--color-(ink|on-ink|ink-muted|mint)\b/.test(body) && !/v5-signin__/.test(selector),
    );
    expect(outside).toEqual([]);
    const off = rules(css).filter(
      ([selector, body]) =>
        /--color-(ink|on-ink|ink-muted|mint)\b/.test(body) &&
        /v5-entry__(who|auth|dots|dot|key|commit|badge|roster|panel)/.test(selector),
    );
    expect(off).toEqual([]);
  });

  it('never puts Mint on a light surface: it only fills the band mark tile', () => {
    const mint = rules(css).filter(([, body]) => /var\(--color-mint\)/.test(body));
    expect(mint.map(([selector]) => selector)).toEqual(['.v5-signin__mark']);
  });

  it('every rule is scoped to the sign-in screen, never the shared entry root', () => {
    for (const [selector] of rules(css)) {
      if (selector.startsWith('--') || selector === '') continue;
      for (const part of selector.split(/,(?![^(]*\))/)) {
        expect(part, part).toMatch(/v5-signin__|v5-entry--sign-in/);
      }
    }
  });
});

describe('RT-1092 sign-in.css — fit (OD-7, OD-11)', () => {
  it.each([
    ['1280×800', base],
    ['1920×1080', pilot],
    ['1024×768', compact],
    ['1024×600', short],
  ])('every key and roster card clears the 44px floor — %s', (_label, body) => {
    for (const name of ['entry-key', 'entry-tile']) {
      expect(pxVar(body, name), `--${name}`).toBeGreaterThanOrEqual(44);
    }
  });

  it('the commit stays at or above 44px at 1024×600', () => {
    expect(pxVar(short, 'entry-commit')).toBeGreaterThanOrEqual(44);
  });

  it('three roster columns at 1280 and up, two below (OD-11)', () => {
    expect(base).toMatch(/--signin-cols:\s*3/);
    expect(compact).toMatch(/--signin-cols:\s*2/);
    expect(short).toMatch(/--signin-cols:\s*2/);
  });

  it('the dock column holds three 44px keys with their gaps and padding at every size', () => {
    for (const body of [base, pilot, compact, short]) {
      const dock = /--signin-dock:/.test(body)
        ? pxVar(body, 'signin-dock')
        : pxVar(base, 'signin-dock');
      expect(dock).toBeGreaterThanOrEqual(3 * 44 + 2 * 8 + 2 * 20 + 1);
    }
  });

  it('the dock head and the feedback slot hold one height, so the keypad never moves', () => {
    expect(css).toMatch(
      /\.v5-entry--sign-in \.v5-entry__auth \.v5-entry__panel-head\s*\{[^}]*block-size:\s*var\(--signin-dock-head\)/,
    );
    expect(css).toMatch(
      /\.v5-entry--sign-in \.v5-entry__feedback\s*\{[^}]*min-block-size:\s*var\(--signin-slot\)/,
    );
    // Sized for the longest refusal (terminal_has_unresolved_payment, three lines) at 1024×600.
    expect(pxVar(base, 'signin-slot')).toBeGreaterThanOrEqual(84);
  });

  it('the band leaves a positioned layer for the S4 ornament, without drawing one', () => {
    expect(css).toMatch(/\.v5-signin__band\s*\{[^}]*position:\s*relative/);
    expect(css).not.toMatch(/orn|skyline|ruler/);
  });
});

describe('RT-1092 sign-in.css — Windows contrast themes', () => {
  it('the band maps to Canvas / CanvasText with a 1px edge', () => {
    const band = /\.v5-signin__band\s*\{([^}]*)\}/.exec(forced)?.[1] ?? '';
    expect(band).toMatch(/background:\s*Canvas\b/);
    expect(band).toMatch(/color:\s*CanvasText/);
    expect(band).toMatch(/border-block-end:\s*1px solid CanvasText/);
  });

  it('the Mint tile keeps a visible boundary', () => {
    expect(forced).toMatch(/\.v5-signin__mark\s*\{[^}]*border:\s*1px solid CanvasText/);
  });

  it('only an available commit takes the system highlight', () => {
    const rule =
      /\.v5-entry__commit\.v5-btn:not\(:disabled, \[aria-disabled='true'\]\)\s*\{([^}]*)\}/.exec(
        forced,
      )?.[1] ?? '';
    expect(rule).toMatch(/background:\s*Highlight/);
    expect(rule).toMatch(/color:\s*HighlightText/);
    expect(rule).toMatch(/forced-color-adjust:\s*none/);
  });
});
