import { describe, expect, it, vi } from 'vitest';

import type { Network, PairSuccessBody } from '../../pairing/network.js';
import { createPairingService } from '../../pairing/service.js';
import type { PairingStore } from '../../pairing/store.js';

// service.ts imports addBreadcrumb from @sentry/electron/main (as in service.test.ts).
vi.mock('@sentry/electron/main', () => ({ addBreadcrumb: vi.fn() }));

/** RT-373 — the pair response's `expires_at` reaches the store, to be sealed with the token. */

function body(expiresAt: string | null | undefined): PairSuccessBody {
  return {
    device_token: 'tok-' + 'z'.repeat(24),
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'Till 1',
    branch_name: 'Main',
    branch_address: 'Street 1',
    tenant_tax_registration_id: 'TAX-1',
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
}

async function persistedWith(expiresAt: string | null | undefined): Promise<unknown> {
  const persist = vi.fn(() => Promise.resolve());
  const network: Network = {
    pair: vi.fn(() =>
      Promise.resolve({ ok: true as const, status: 200 as const, body: body(expiresAt) }),
    ),
  };
  const service = createPairingService({
    store: { persist } as unknown as PairingStore,
    network,
    pairingLog: () => {},
    clock: () => new Date('2026-12-01T00:00:00.000Z'),
  });
  await service.submit('VALIDCODE');
  return (persist.mock.calls[0] as unknown[] | undefined)?.[0];
}

describe('RT-373 pairing passes the credential expiry to the store', () => {
  it('a response with expires_at persists it', async () => {
    expect(await persistedWith('2027-03-01T00:00:00.000Z')).toMatchObject({
      expires_at: '2027-03-01T00:00:00.000Z',
    });
  });

  it.each([
    ['null', null],
    ['absent', undefined],
    ['empty', ''],
  ])('a response with expires_at %s persists no expiry (unknown)', async (_name, value) => {
    expect(await persistedWith(value)).not.toHaveProperty('expires_at');
  });
});
