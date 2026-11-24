import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-1179: the Sale commit is 60px at comfortable density and 56px at compact, as DESIGN.md
 * requires and as Checkout's ledger slot already does. happy-dom resolves no cascade, so this is
 * a source tripwire; the 1024/1280 captures are the visual proof.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(resolve(__dirname, '..', 'live-sale.css'), 'utf-8'));

const COMMIT = '.v5-live-sale .v5-sale-checkout.v5-btn';
const COMPACT = '@container v5-screen (max-width: 1120px) or style(--v5-screen-height: compact)';
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The brace-balanced bodies of every compact container block, with their source offsets. */
function compactBlocks(): Array<{ start: number; body: string }> {
  const out: Array<{ start: number; body: string }> = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(COMPACT, from);
    if (at === -1) return out;
    let i = css.indexOf('{', at) + 1;
    const begin = i;
    let depth = 1;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ start: at, body: css.slice(begin, i - 1) });
    from = i;
  }
}

describe('Sale commit density (RT-1179)', () => {
  const base = new RegExp(`(^|\\})\\s*${escape(COMMIT)}\\s*\\{([^}]*)\\}`);
  const baseMatch = base.exec(css);

  it('is 60px at comfortable density', () => {
    expect(baseMatch?.[2]).toMatch(/min-block-size:\s*60px/);
  });

  it('is 56px at compact, in a container block after the base rule', () => {
    const rule = new RegExp(`${escape(COMMIT)}\\s*\\{[^}]*min-block-size:\\s*56px`);
    const after = compactBlocks().filter(
      (block) => baseMatch !== null && block.start > baseMatch.index && rule.test(block.body),
    );
    expect(after).toHaveLength(1);
  });
});
