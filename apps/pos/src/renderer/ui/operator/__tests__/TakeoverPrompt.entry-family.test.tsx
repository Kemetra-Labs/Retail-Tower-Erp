import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { TakeoverPrompt } from '../TakeoverPrompt.js';
import type { OperatorBridgeAPI } from '../../../../shared/bridge-api.js';

/**
 * RT-1096 (RT-1042 §3 item 4) — the takeover prompt in the entry family.
 *
 * Structure is asserted on the rendered DOM; the stylesheet is checked as source,
 * because happy-dom resolves no layout (the captures are the visual proof).
 * Behaviour, copy and test ids are covered by TakeoverPrompt.test.tsx unchanged.
 */

afterEach(cleanup);

const bridge = {
  confirmTakeover: vi.fn(),
  cancelTakeover: vi.fn(),
} as unknown as OperatorBridgeAPI;

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tailwind = strip(readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf-8'));

/** Every `.takeover-prompt*` rule outside the forced-colours block, as selector -> body. */
function takeoverRules(css: string): Array<[string, string]> {
  return [...css.matchAll(/(\.takeover-prompt[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => [
    (selector ?? '').trim(),
    body ?? '',
  ]);
}

function forcedBlock(css: string): string {
  const start = css.indexOf('@media (forced-colors: active)');
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  return '';
}

describe('TakeoverPrompt structure', () => {
  it('is an entry-surface dialog with the shared Ink band and the card inside', () => {
    render(<TakeoverPrompt operator={bridge} pending_takeover_id="p1" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-entry-surface');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'takeover-prompt-title');

    const band = dialog.querySelector('.v5-entry-band');
    expect(band).toHaveAttribute('data-testid', 'entry-band');
    expect(band).toHaveTextContent('Retail Tower');
    expect(band).not.toHaveClass('v5-entry-band--ornament');
    expect(dialog.querySelector('.v5-entry-band__ornament')).toBeNull();

    const card = dialog.querySelector('.takeover-prompt__stage > .takeover-prompt__content');
    expect(card).not.toBeNull();
    expect(card).toContainElement(screen.getByTestId('takeover-prompt-title'));
    expect(card).toContainElement(screen.getByTestId('takeover-prompt-confirm'));
    expect(band).not.toContainElement(screen.getByTestId('takeover-prompt-title'));
  });

  it('no longer uses the legacy v4-screen frame or an overlay scrim', () => {
    const { container } = render(<TakeoverPrompt operator={bridge} pending_takeover_id="p1" />);
    expect(container.querySelector('[class*="v4-"]')).toBeNull();
    expect(
      takeoverRules(tailwind)
        .map(([, body]) => body)
        .join(''),
    ).not.toMatch(/overlay-scrim|shadow-overlay/);
  });
});

describe('TakeoverPrompt stylesheet', () => {
  const rules = takeoverRules(tailwind);

  it('never spells a colour', () => {
    const joined = rules.map(([, body]) => body).join('\n');
    expect(joined).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(joined).not.toMatch(/rgba?\(/i);
  });

  it('is flat: no shadow, no gradient (OD-4)', () => {
    const joined = rules.map(([, body]) => body).join('\n');
    expect(joined).not.toMatch(/box-shadow\s*:\s*(?!none)/);
    expect(joined).not.toMatch(/gradient\(/);
  });

  it('is RTL-native: logical properties only', () => {
    const joined = rules.map(([, body]) => body).join('\n');
    expect(joined).not.toMatch(/(?:^|[;\s])(?:left|right|margin-left|margin-right)\s*:/);
    expect(joined).not.toMatch(/(?:padding|border)-(?:left|right)/);
    expect(joined).not.toMatch(/(?:^|[;\s])(?:width|height)\s*:/);
  });

  it('maps the root and card to system colours under forced colours (the band maps itself in entry-band.css)', () => {
    const section = tailwind.slice(tailwind.indexOf('.takeover-prompt__actions {'));
    const forced = forcedBlock(section);
    expect(forced).toMatch(/\.takeover-prompt\s*\{[^}]*background-color\s*:\s*Canvas/);
    expect(forced).toMatch(/\.takeover-prompt__content\s*\{[^}]*border-color\s*:\s*CanvasText/);
    expect(forced).not.toMatch(/var\(--color-mint\)|var\(--color-ink\)/);
  });
});
