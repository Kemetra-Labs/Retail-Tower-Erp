/**
 * RT-887 — the preload parser and the optional `sync.held` count (the
 * discount-held subset of `pending`). Absent stays absent, so a snapshot
 * with no held sale parses exactly as before; present must be a count.
 */
import { describe, expect, it } from 'vitest';

import { parseTerminalStatusSnapshot } from '../terminal-status.js';
import type { TerminalStatusSnapshot } from '../../shared/terminal-status/types.js';

const VALID: TerminalStatusSnapshot = {
  v: 1,
  connection: 'online',
  connectionSince: '2026-10-17T10:00:00.000Z',
  lastContactAt: null,
  sync: {
    pending: 2,
    heldPreviousPairing: 0,
    deadLetter: 0,
    oldestPendingAt: '2026-10-17T09:00:00.000Z',
    paused: null,
    lastSuccessAt: null,
  },
};

function withHeld(held: unknown): unknown {
  return { ...VALID, sync: { ...VALID.sync, held } };
}

describe('RT-887 parseTerminalStatusSnapshot — held', () => {
  it('keeps a held count', () => {
    expect(parseTerminalStatusSnapshot(withHeld(1))?.sync.held).toBe(1);
  });

  it('no held key in, no held key out', () => {
    const parsed = parseTerminalStatusSnapshot(VALID);
    expect(parsed).toEqual(VALID);
    expect(parsed?.sync).not.toHaveProperty('held');
  });

  it.each([
    ['a negative held', -1],
    ['a fractional held', 0.5],
    ['a string held', '1'],
    ['a null held', null],
  ])('rejects %s', (_label, held) => {
    expect(parseTerminalStatusSnapshot(withHeld(held))).toBeNull();
  });
});
