import { describe, expect, it } from 'vitest';

import { makeSecretKey } from '../../../shared/secret-store.js';
import { createSendableDeviceTokenReader } from '../../pairing/device-token.js';
import {
  createPairingStore,
  type PairingStoreDb,
  type PersistInput,
  type StoredAssignmentRow,
} from '../../pairing/store.js';
import { openDeviceToken } from '../../pairing/token-binding.js';
import { createInMemorySecretStore } from '../../secrets/in-memory.js';

/**
 * RT-373 — the pairing store keeps the credential's `expires_at` inside the
 * RT-306 sealed envelope (one atomic secret write, no migration) and swaps a
 * rotated token in under the SAME pairing binding.
 */

const KEY = makeSecretKey('terminal.device-token');
const OLD = 'old-' + 'a'.repeat(24);
const NEW = 'new-' + 'b'.repeat(24);
const EXPIRES = '2027-03-01T00:00:00.000Z';
const NEW_EXPIRES = '2027-05-30T00:00:00.000Z';

function must<T>(value: T | null): T {
  if (value === null) throw new Error('expected a value');
  return value;
}

function fakeDb(): PairingStoreDb {
  let row: StoredAssignmentRow | null = null;
  return {
    readAssignment: () => (row === null ? null : { ...row }),
    writeAssignment: (next) => {
      row = { ...next, device_revoked_at: null };
    },
    deleteAssignment: () => {
      row = null;
    },
    markDeviceRevoked: (at) => {
      if (row !== null && typeof row.device_revoked_at !== 'number') {
        row = { ...row, device_revoked_at: at };
      }
    },
    clearDeviceRevoked: () => {
      if (row !== null) row = { ...row, device_revoked_at: null };
    },
    transaction: (fn) => fn(),
  };
}

function pairing(overrides: Partial<PersistInput> = {}): PersistInput {
  return {
    device_token: OLD,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'Till 1',
    paired_at: 1_790_000_000,
    branch_name: null,
    branch_address: null,
    tenant_tax_registration_id: null,
    ...overrides,
  };
}

function harness() {
  const secretStore = createInMemorySecretStore();
  const store = createPairingStore({ secretStore, db: fakeDb(), deviceTokenKey: KEY });
  const sendable = createSendableDeviceTokenReader({
    pairingStore: store,
    secretStore,
    deviceTokenKey: KEY,
  });
  return { secretStore, store, sendable };
}

describe('RT-373 pairing store — expires_at beside the sealed token', () => {
  it('a pairing response with expires_at stores it in the sealed envelope', async () => {
    const { store, secretStore } = harness();
    await store.persist(pairing({ expires_at: EXPIRES }));

    const opened = openDeviceToken(must(await secretStore.get(KEY)));
    expect(opened).toMatchObject({ kind: 'bound', token: OLD, expiresAt: EXPIRES });
    await expect(store.readRotationCredential()).resolves.toEqual({
      token: OLD,
      binding: {
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'terminal-1',
        paired_at: 1_790_000_000,
      },
      expiresAt: EXPIRES,
    });
  });

  it('a pairing without expires_at (pre-RT-367 server) reads as unknown expiry', async () => {
    const { store } = harness();
    await store.persist(pairing());
    await expect(store.readRotationCredential()).resolves.toMatchObject({
      token: OLD,
      expiresAt: null,
    });
  });

  it('a legacy (pre-RT-306) token is still rotatable, with unknown expiry', async () => {
    const { store, secretStore } = harness();
    await store.persist(pairing());
    await secretStore.set(KEY, OLD); // the pre-RT-306 raw format
    await expect(store.readRotationCredential()).resolves.toMatchObject({
      token: OLD,
      expiresAt: null,
    });
  });

  it('unpaired or revoked → no credential to rotate', async () => {
    const { store } = harness();
    await expect(store.readRotationCredential()).resolves.toBeNull();
    await store.persist(pairing({ expires_at: EXPIRES }));
    store.markDeviceRevoked();
    await expect(store.readRotationCredential()).resolves.toBeNull();
  });
});

describe('RT-373 pairing store — replacing the rotated token', () => {
  it('seals the new token and expiry under the same binding; the sendable reader hands out the new token', async () => {
    const { store, sendable } = harness();
    await store.persist(pairing({ expires_at: EXPIRES }));
    const cred = must(await store.readRotationCredential());

    await expect(store.replaceRotatedToken(cred.binding, NEW, NEW_EXPIRES)).resolves.toBe(
      'replaced',
    );

    await expect(sendable()).resolves.toBe(NEW);
    await expect(store.getStatus()).resolves.toMatchObject({ kind: 'paired' });
    await expect(store.readRotationCredential()).resolves.toMatchObject({
      token: NEW,
      expiresAt: NEW_EXPIRES,
    });
  });

  it('a rotation that lands after a re-pair is dropped (stale); the new pairing keeps its token', async () => {
    const { store, sendable } = harness();
    await store.persist(pairing({ expires_at: EXPIRES }));
    const cred = must(await store.readRotationCredential());
    await store.persist(
      pairing({ device_token: 'repaired-' + 'c'.repeat(20), paired_at: 1_790_000_500 }),
    );

    await expect(store.replaceRotatedToken(cred.binding, NEW, NEW_EXPIRES)).resolves.toBe('stale');
    await expect(sendable()).resolves.toBe('repaired-' + 'c'.repeat(20));
  });

  it('a rotation that lands after a confirmed revocation is dropped (stale)', async () => {
    const { store, secretStore } = harness();
    await store.persist(pairing({ expires_at: EXPIRES }));
    const cred = must(await store.readRotationCredential());
    store.markDeviceRevoked();

    await expect(store.replaceRotatedToken(cred.binding, NEW, NEW_EXPIRES)).resolves.toBe('stale');
    expect(openDeviceToken(must(await secretStore.get(KEY)))).toMatchObject({ token: OLD });
  });

  it('a failing secret write leaves the old sealed token in place and rejects', async () => {
    const { store, secretStore, sendable } = harness();
    await store.persist(pairing({ expires_at: EXPIRES }));
    const cred = must(await store.readRotationCredential());
    const realSet = secretStore.set.bind(secretStore);
    secretStore.set = () => Promise.reject(new Error('disk full'));

    await expect(store.replaceRotatedToken(cred.binding, NEW, NEW_EXPIRES)).rejects.toThrow();
    secretStore.set = realSet;
    await expect(sendable()).resolves.toBe(OLD);
  });
});
