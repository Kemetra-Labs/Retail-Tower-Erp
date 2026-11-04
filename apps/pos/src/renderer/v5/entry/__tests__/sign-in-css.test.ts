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
const laptop =
  profileRule.exec(
    mediaBlocks(css, /\(min-width:\s*1280px\) and \(max-width:\s*1599px\)[^{]*/),
  )?.[1] ?? '';
const forced = mediaBlocks(css, /\(forced-colors:\s*active\)/);

/** The last profile body that sets `--name` wins, as the cascade does (later blocks win). */
function resolved(bodies: readonly string[], name: string): number {
  for (const body of [...bodies].reverse()) {
    if (new RegExp(`--${name}:`).test(body)) return pxVar(body, name);
  }
  throw new Error(`--${name} is set by no profile`);
}

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

  it("adds no Mint: the band's one Mint tile is entry-band.css's (RT-1096)", () => {
    expect(css).not.toMatch(/var\(--color-mint\)/);
  });

  it('restyles no band colour: the band itself stays the one entry band', () => {
    const band = rules(css).filter(([selector]) => /\.v5-entry-band$/.test(selector));
    expect(band.length).toBeGreaterThan(0);
    for (const [, body] of band) {
      expect(body).not.toMatch(/(?:^|[;\s])(background|color)\s*:/);
    }
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

  it('does not shrink the commit below the entry density (56px compact, 60px comfortable)', () => {
    expect(css).not.toMatch(/--entry-commit:/);
  });

  it('a long picked name truncates in the dock instead of spilling out', () => {
    expect(css).toMatch(
      /:has\(\.v5-entry__badge\) \.v5-entry__auth-who\s*\{[^}]*align-items:\s*stretch[^}]*min-inline-size:\s*0/,
    );
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
  });

  // entry.css: the auth-body padding and the commit height, comfortable (≥1280) and compact.
  const ENTRY = { comfortable: { pad: 20, commit: 60 }, compact: { pad: 16, commit: 56 } };
  const GAP = 12; // the auth body's gap (--space-3)
  const KEY_GAP = 8; // the keypad's gap (--space-2)

  it.each([
    ['1920×1080', 1080, [base, pilot], ENTRY.comfortable],
    ['1280×800', 800, [base], ENTRY.comfortable],
    ['1366×768', 768, [base, laptop], ENTRY.comfortable],
    ['1024×768', 768, [base, compact], ENTRY.compact],
    ['1024×600', 600, [base, compact, short], ENTRY.compact],
  ] as const)(
    'the dock fits under the band — %s (head, slot, dots, four key rows, commit)',
    (_label, height, bodies, entry) => {
      const v = (name: string): number => resolved(bodies, name);
      const commit = /--entry-commit:/.test(bodies.join('\n')) ? v('entry-commit') : entry.commit;
      const dock =
        v('signin-dock-head') +
        2 * entry.pad +
        v('signin-slot') +
        GAP +
        v('signin-dots') +
        GAP +
        (4 * v('entry-key') + 3 * KEY_GAP) +
        GAP +
        commit;
      expect(dock).toBeLessThanOrEqual(height - v('signin-band'));
      // The commit keeps the 56px commit size, even at the 600px floor.
      expect(commit).toBeGreaterThanOrEqual(56);
    },
  );

  it('the band stays positioned for the ornament layer, and sign-in.css draws none itself', () => {
    expect(css).toMatch(/\.v5-entry--sign-in \.v5-entry-band\s*\{[^}]*position:\s*relative/);
    // RT-1093: the drawing lives in entry-band-ornament.css, loaded only with the sign-in opt-in.
    expect(css).not.toMatch(/orn|skyline|ruler/);
  });
});

describe('RT-1092 sign-in.css — Windows contrast themes', () => {
  it('what sign-in adds on the band reads as CanvasText (the band maps in entry-band.css)', () => {
    expect(forced).toMatch(/\.v5-signin__context,[^{]*\{[^}]*color:\s*CanvasText/);
    expect(forced).toMatch(/\.v5-signin__sep\s*\{[^}]*background:\s*CanvasText/);
  });

  it('the logo card on the band keeps its CanvasText edge (RT-832 §2)', () => {
    expect(forced).toMatch(
      /\.v5-entry--sign-in \.v5-entry-band \.v5-brand-slot\s*\{[^}]*border-color:\s*CanvasText/,
    );
  });

  it('the placeholder dots read as unavailable', () => {
    expect(forced).toMatch(/\.v5-entry__dots--placeholder\s*\{[^}]*border-color:\s*GrayText/);
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

/**
 * RT-1093 (RT-1042 S4, OD-5) — the ornament's stylesheet and who may draw it.
 * Source checks: happy-dom resolves no layout; the captures (S8, RT-1097) are
 * the visual proof.
 */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');
const ornamentCss = stripComments(
  readFileSync(resolve(__dirname, '../entry-band-ornament.css'), 'utf-8'),
);
const ornamentForced = mediaBlocks(ornamentCss, /\(forced-colors:\s*active\)/);
const ornamentSmall = mediaBlocks(
  ornamentCss,
  /\(max-width:\s*1279px\),\s*\(max-height:\s*767px\)/,
);

describe('RT-1093 entry-band-ornament.css', () => {
  it('names the roles: no raw colour literal', () => {
    expect(ornamentCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(ornamentCss).not.toMatch(/rgba?\(|hsla?\(/);
  });

  it('is static and flat: no animation, no transition, no gradient, no shadow', () => {
    expect(ornamentCss).not.toMatch(/animation|transition|@keyframes|gradient\(|box-shadow|filter/);
  });

  it('uses Mint only for strokes inside the ornament layer, never on a light surface', () => {
    const uses = rules(ornamentCss).filter(([, body]) => /--color-mint/.test(body));
    expect(uses).toHaveLength(3);
    for (const [selector, body] of uses) {
      expect(selector).toMatch(/^\.v5-entry-band__ornament-(grid|ruler|skyline)$/);
      expect(body).toMatch(/(?:^|[;\s])stroke\s*:\s*var\(--color-mint\)/);
      expect(body).not.toMatch(/(?:^|[;\s])(?:fill|background|color)\s*:\s*var\(--color-mint\)/);
    }
  });

  it('keeps every stroke at 40% opacity or less', () => {
    const opacities = [...ornamentCss.matchAll(/stroke-opacity:\s*([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(opacities).toHaveLength(3);
    for (const o of opacities) expect(o).toBeLessThanOrEqual(0.4);
  });

  it('sits behind the content and never takes events', () => {
    const layer = /\.v5-entry-band__ornament\s*\{([^}]*)\}/.exec(ornamentCss)?.[1] ?? '';
    expect(layer).toMatch(/position:\s*absolute/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(ornamentCss).toMatch(/\.v5-entry-band--ornament\s*\{[^}]*isolation:\s*isolate/);
  });

  it('is not drawn below 1280 wide or 768 high', () => {
    expect(ornamentSmall).toMatch(/\.v5-entry-band__ornament\s*\{[^}]*display:\s*none/);
  });

  it('is not drawn under forced colours', () => {
    expect(ornamentForced).toMatch(/\.v5-entry-band__ornament\s*\{[^}]*display:\s*none/);
    expect(ornamentForced).not.toMatch(/--color-mint/);
  });

  it('the shared band stylesheet is unchanged: no ornament rule leaks into it', () => {
    const bandCss = stripComments(readFileSync(resolve(__dirname, '../entry-band.css'), 'utf-8'));
    expect(bandCss).not.toMatch(/orn|skyline|ruler/);
  });

  it('only the sign-in band opts in (lock, takeover, pairing, Ready and boot never pass it)', () => {
    const root = resolve(__dirname, '../../..');
    for (const file of [
      'session/LockScreen.tsx',
      'ui/operator/TakeoverPrompt.tsx',
      'v5/entry/EntryCard.tsx',
      'v5/foundation/RouteLoading.tsx',
    ]) {
      expect(readFileSync(resolve(root, file), 'utf-8'), file).not.toMatch(/\bornament\b/);
    }
    expect(readFileSync(resolve(root, 'v5/entry/SignInBand.tsx'), 'utf-8')).toMatch(
      /^\s*ornament\s*$/m,
    );
  });
});
