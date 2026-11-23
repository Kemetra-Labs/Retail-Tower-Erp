import { describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve({ kind: 'ok' })));
vi.mock('electron', () => ({ ipcRenderer: { invoke } }));

import { availability } from '../availability.js';
import { AVAILABILITY_IPC_CHANNELS } from '../../shared/availability/channels.js';

/** RT-1578 — the availability preload is a thin invoke wire-up on three typed, read-only channels. */
describe('availability preload bridge', () => {
  it('exposes exactly status, bands and refresh', () => {
    expect(Object.keys(availability).sort()).toEqual(['bands', 'refresh', 'status']);
  });

  it('each member invokes its own channel with the request and nothing else', async () => {
    const ids = { product_ids: ['0192f5a2-3b4c-7d8e-9f01-000000000001'] };
    await availability.status({});
    await availability.bands(ids);
    await availability.refresh({});
    expect(invoke.mock.calls).toEqual([
      [AVAILABILITY_IPC_CHANNELS.STATUS, {}],
      [AVAILABILITY_IPC_CHANNELS.BANDS, ids],
      [AVAILABILITY_IPC_CHANNELS.REFRESH, {}],
    ]);
  });
});
