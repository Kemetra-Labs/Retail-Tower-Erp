import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-1022 — CSS and copy hygiene from the 2026-10-31 design audit.
 *
 * jsdom loads no stylesheet, so each guard reads the source and checks the one
 * rule the audit found drifting from DESIGN.md. None of this changes behaviour.
 */

const RENDERER = resolve(__dirname, '../..');

function read(relative: string): string {
  return readFileSync(resolve(RENDERER, relative), 'utf-8');
}

/** Source without block comments, so prose that names a retired class cannot trip a guard. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Source without JS line comments or block comments: what a user could actually see. */
function stripComments(source: string): string {
  return stripBlockComments(source).replace(/^\s*\/\/.*$/gm, '');
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.\\>[\]'()]/g, '\\$&').replace(/\s+/g, '\\s*');
  const rule = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`rule ${selector} not found`);
  return rule[1] ?? '';
}

const tailwind = stripBlockComments(read('styles/tailwind.css'));

const TEXT_INPUT_FOCUS = [
  "input[type='text']:focus-visible",
  "input[type='number']:focus-visible",
  "input[type='email']:focus-visible",
  "input[type='password']:focus-visible",
  "input[type='search']:focus-visible",
  'select:focus-visible',
  'textarea:focus-visible',
].join(',\\s*');

function textInputRule(css: string): string {
  const selectors = TEXT_INPUT_FOCUS.replace(/[[\]'()]/g, '\\$&');
  const match = new RegExp(`${selectors}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error('text-input :focus-visible rule not found');
  return match[1] ?? '';
}

describe('RT-1022 #1 — text-input focus is an instant outline ring (DESIGN.md:531)', () => {
  const focusBody = textInputRule(tailwind);

  it('draws the ring as an outline on the focus-ring token', () => {
    expect(focusBody).toMatch(/outline:\s*2px solid var\(--color-focus-ring\)/);
    expect(focusBody).toMatch(/outline-offset:\s*2px/);
    expect(focusBody).not.toMatch(/outline:\s*none/);
  });

  it('never draws the ring as a box-shadow', () => {
    expect(focusBody).not.toMatch(/box-shadow/);
  });

  it('transitions border-color only, so the ring appears instantly', () => {
    const base = /input\[type='text'\],[^{]*textarea\s*\{([^}]*)\}/.exec(tailwind)?.[1] ?? '';
    const transition = /transition:\s*([^;]+);/.exec(base)?.[1] ?? '';
    expect(transition).toMatch(/border-color/);
    expect(transition).not.toMatch(/box-shadow/);
  });
});

describe('RT-1022 #2 — dead CSS is gone', () => {
  // Built from parts so a grep over src/renderer for the retired names finds no hit in this file.
  const RETIRED = [
    ['.v4', '-field'],
    ['.account-row', '__kind'],
    ['.held-tray', '__label'],
    ['.dialog', '-panel'],
  ].map((parts) => parts.join(''));

  it.each(RETIRED)('tailwind.css declares no %s rule', (selector) => {
    expect(tailwind).not.toContain(selector);
  });

  it('keeps .dialog-overlay, which session-lock-concealment pins', () => {
    expect(ruleBody(tailwind, '.dialog-overlay')).toMatch(
      /background:\s*var\(--color-overlay-scrim\)/,
    );
  });
});

describe('RT-1022 #3 — no colour or spacing literal in scan-notice and .voucher-error', () => {
  it('scan-notice.css has no rgb() shadow below the overlay level', () => {
    const css = stripBlockComments(read('scan/scan-notice.css'));
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).not.toMatch(/box-shadow/);
  });

  it('scan-notice.css has no colour literal and no spacing literal', () => {
    const css = stripBlockComments(read('scan/scan-notice.css'));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const spacing = /(?:margin|padding|gap|inset)[\w-]*:\s*([^;]+);/g;
    const literals = [...css.matchAll(spacing)]
      .map((match) => match[1] ?? '')
      .filter((value) => /\d+(?:px|rem|em)\b/.test(value));
    expect(literals).toEqual([]);
  });

  it('.voucher-error margin comes from the spacing scale', () => {
    const body = ruleBody(tailwind, '.voucher-error');
    expect(body).not.toMatch(/\d+px/);
    expect(body).toMatch(/margin:[^;]*var\(--space-1\)/);
  });
});

describe('RT-1022 #4 — void and sales spacing is on the --space-* scale', () => {
  it.each(['v5/void/void.css', 'v5/manager/sales/sales.css'])(
    '%s has no 6px or 10px value',
    (file) => {
      expect(stripBlockComments(read(file))).not.toMatch(/(?<![\w.-])(6|10)px\b/);
    },
  );
});

describe('RT-1022 #5 — the manager tile boundary is Control Edge (DESIGN.md:601)', () => {
  // Both files declare `.v5-manager-tile`; the dashboard loads both, so both must agree.
  it.each(['v5/manager/home/manager-home.css', 'v5/manager/manager.css'])(
    '%s uses --color-border-strong, not the hairline',
    (file) => {
      const css = stripBlockComments(read(file));
      expect(ruleBody(css, '.v5-manager-tile')).toMatch(
        /border:\s*1px solid var\(--color-border-strong\)/,
      );
    },
  );
});

describe('RT-1022 #6 — no em dash in the three touched copy sources', () => {
  const SOURCES = [
    'ui/payments/VoucherEntry.tsx',
    'v5/manager/sales/history/HistoryDetail.tsx',
    'v5/recovery/RecoveryActionDialog.tsx',
  ];

  // The same intent as returns-messages.test.ts ("uses no em dash"), read from
  // the source because these strings sit inline in JSX rather than in a map.
  it.each(SOURCES)('%s renders no em dash', (file) => {
    const visible = stripComments(read(file))
      .split('\n')
      .filter((line) => line.includes('—'));
    expect(visible).toEqual([]);
  });

  it('the voucher format message uses a Western digit, not «٣»', () => {
    const source = stripComments(read('ui/payments/VoucherEntry.tsx'));
    const message = /className="voucher-error">([^<]+)</.exec(source)?.[1] ?? '';
    expect(message).toMatch(/[؀-ۿ]/);
    expect(message).not.toMatch(/[٠-٩]/);
    expect(message).toMatch(/\b3\b/);
  });
});
