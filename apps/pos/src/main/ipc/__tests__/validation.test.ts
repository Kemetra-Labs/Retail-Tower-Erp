/**
 * RT-1207 — the shared IPC argument guards. These tests pin the behaviour the
 * handler modules had before the copies were merged: arrays, null, class
 * instances and mixed-case UUIDs must be accepted or rejected exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  closed,
  createIpcRunner,
  isObjectLike,
  isPlainObject,
  UUID_ANYCASE_RE,
  UUID_LOWER_RE,
} from '../validation.js';

class Widget {
  readonly a = 1;
}

const LOWER = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const UPPER = LOWER.toUpperCase();
const MIXED = '0190F5a2-7b3c-7D4e-8f90-a1b2c3d4e5F6';

describe('isPlainObject (rejects arrays)', () => {
  it.each([
    ['object literal', {}],
    ['populated object', { a: 1 }],
    ['null-prototype object', Object.create(null)],
    ['class instance', new Widget()],
    ['Date', new Date(0)],
    ['Map', new Map()],
  ])('accepts %s', (_name, value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([
    ['empty array', []],
    ['populated array', [1, 2]],
    ['null', null],
    ['undefined', undefined],
    ['string', 'x'],
    ['number', 1],
    ['boolean', true],
    ['function', () => 1],
    ['symbol', Symbol('s')],
  ])('rejects %s', (_name, value) => {
    expect(isPlainObject(value)).toBe(false);
  });
});

describe('isObjectLike (accepts arrays)', () => {
  it.each([
    ['object literal', {}],
    ['empty array', []],
    ['populated array', [1]],
    ['class instance', new Widget()],
  ])('accepts %s', (_name, value) => {
    expect(isObjectLike(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'x'],
    ['number', 0],
    ['function', () => 1],
  ])('rejects %s', (_name, value) => {
    expect(isObjectLike(value)).toBe(false);
  });
});

describe('closed', () => {
  it('accepts an empty object and any subset of the allowed keys', () => {
    expect(closed({}, ['a'])).toBe(true);
    expect(closed({ a: 1 }, ['a', 'b'])).toBe(true);
    expect(closed({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
  });

  it('rejects an extra key', () => {
    expect(closed({ a: 1, c: 3 }, ['a', 'b'])).toBe(false);
    expect(closed({ a: 1 }, [])).toBe(false);
  });

  it('accepts an empty object against an empty key list', () => {
    expect(closed({}, [])).toBe(true);
  });

  it('rejects arrays even when they carry no own enumerable keys', () => {
    expect(closed([], ['a'])).toBe(false);
    expect(closed([1], ['0'])).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(closed(null, ['a'])).toBe(false);
    expect(closed(undefined, ['a'])).toBe(false);
    expect(closed('a', ['a'])).toBe(false);
    expect(closed(1, ['a'])).toBe(false);
  });

  it('accepts a class instance whose own keys are allowed', () => {
    expect(closed(new Widget(), ['a'])).toBe(true);
    expect(closed(new Widget(), ['b'])).toBe(false);
  });

  it('only looks at own enumerable keys', () => {
    const inherited = Object.create({ smuggled: 1 }) as Record<string, unknown>;
    inherited['a'] = 1;
    expect(closed(inherited, ['a'])).toBe(true);
  });
});

describe('UUID patterns', () => {
  it('UUID_LOWER_RE accepts lower-case only', () => {
    expect(UUID_LOWER_RE.test(LOWER)).toBe(true);
    expect(UUID_LOWER_RE.test(UPPER)).toBe(false);
    expect(UUID_LOWER_RE.test(MIXED)).toBe(false);
  });

  it('UUID_ANYCASE_RE accepts any case', () => {
    expect(UUID_ANYCASE_RE.test(LOWER)).toBe(true);
    expect(UUID_ANYCASE_RE.test(UPPER)).toBe(true);
    expect(UUID_ANYCASE_RE.test(MIXED)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', LOWER.slice(1)],
    ['trailing char', `${LOWER}0`],
    ['leading space', ` ${LOWER}`],
    ['trailing newline', `${LOWER}\n`],
    ['no dashes', LOWER.replaceAll('-', '')],
    ['non-hex', LOWER.replace('a', 'g')],
  ])('both reject %s', (_name, value) => {
    expect(UUID_LOWER_RE.test(value)).toBe(false);
    expect(UUID_ANYCASE_RE.test(value)).toBe(false);
  });

  it('neither pattern is global or sticky, so test() carries no state between calls', () => {
    expect(UUID_LOWER_RE.global).toBe(false);
    expect(UUID_ANYCASE_RE.sticky).toBe(false);
    expect(UUID_ANYCASE_RE.test(LOWER)).toBe(true);
    expect(UUID_ANYCASE_RE.test(LOWER)).toBe(true);
  });
});

describe('createIpcRunner', () => {
  const REFUSED = { kind: 'refused', reason: 'x_unavailable' } as const;

  function setup() {
    const warn = vi.fn();
    const runner = createIpcRunner({ warn }, 'x:failed', () => REFUSED);
    return { warn, ...runner };
  }

  it('returns the value of a resolving async callback without logging', async () => {
    const { runIpc, warn } = setup();
    await expect(runIpc('op', () => Promise.resolve(7))).resolves.toBe(7);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the value of a synchronous callback', async () => {
    const { runIpc, warn } = setup();
    await expect(runIpc('op', () => 'ok')).resolves.toBe('ok');
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers the refusal and logs only op and error name when a callback rejects', async () => {
    const { runIpc, warn } = setup();
    class BoomError extends Error {
      constructor() {
        super('secret detail 1234');
        this.name = 'BoomError';
      }
    }
    await expect(runIpc('op', () => Promise.reject(new BoomError()))).resolves.toBe(REFUSED);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ op: 'op', error: 'BoomError' }, 'x:failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
  });

  it('answers the refusal when a callback throws synchronously', async () => {
    const { runIpc } = setup();
    await expect(
      runIpc('op', () => {
        throw new TypeError('nope');
      }),
    ).resolves.toBe(REFUSED);
  });

  it('logs the typeof for a thrown non-Error', async () => {
    const { runIpc, warn } = setup();
    await runIpc('op', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- pinning the non-Error branch
      throw 'a string';
    });
    expect(warn).toHaveBeenCalledWith({ op: 'op', error: 'string' }, 'x:failed');
  });

  it('unavailable logs and answers the refusal directly', () => {
    const { unavailable, warn } = setup();
    expect(unavailable('listApprovers', new RangeError('r'))).toBe(REFUSED);
    expect(warn).toHaveBeenCalledWith({ op: 'listApprovers', error: 'RangeError' }, 'x:failed');
  });

  it('builds a fresh refusal per failure when the factory does', () => {
    const warn = vi.fn();
    const { unavailable } = createIpcRunner({ warn }, 'x:failed', () => ({ kind: 'refused' }));
    expect(unavailable('a', new Error('e'))).not.toBe(unavailable('a', new Error('e')));
  });
});
