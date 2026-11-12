import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleFor } from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { DatabaseHandle } from '../../db/client.js';
import { createCashierAdmissionClient } from '../../operator/cashier-admission-client.js';
import { createInMemorySecretStore } from '../../secrets/in-memory.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';
import { makeSecretKey, type SecretStore } from '../../../shared/secret-store.js';
import {
  createRevocationRecheckTokenRead,
  createSendableDeviceTokenReader,
} from '../device-token.js';
import { bindPairingStoreDb, createPairingStore, type PersistInput } from '../store.js';

/**
 * RT-1348 (RT-1345 S3, D3) — the pairing records the Backend-Core origin it was
 * made against, and a terminal started against another origin reports
 * `invalid / other_server`: the device token is never sent there, and the
 * mismatch is never read as a revocation.
 *
 * Runs the PRODUCTION `bindPairingStoreDb` SQL against sql.js with the full
 * migration stack (0061 included).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirnameForFile, '..', '..', '..', '..', 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

const KEY = makeSecretKey('terminal.device-token');
const TOKEN = 'device-token-SENTINEL-1348';
const ORIGIN_A = 'https://api.lab.example';
/** The same server spelled differently: the origin is what is compared. */
const ORIGIN_A_SPELLED = 'HTTPS://API.LAB.EXAMPLE:443/base/';
const ORIGIN_B = 'https://api.pilot.example';
/** An API address with no usable origin (nothing to compare against). */
const UNUSABLE = 'not a url';
const NOW = new Date('2026-11-12T09:00:00.000Z');

const OTHER_SERVER: PairingStatus = { kind: 'invalid', reason: 'other_server' };

function pairing(terminal_id = 'term-1'): PersistInput {
  return {
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id,
    terminal_label: 'Till 1',
    paired_at: 1_760_000_000,
    branch_name: 'Branch',
    branch_address: 'Addr',
    tenant_tax_registration_id: 'TRN',
    device_token: TOKEN,
  };
}

let SQL: SqlJsStatic | undefined;
let raw: SqlJsDatabase;
let handle: DatabaseHandle;
let secrets: SecretStore;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  raw = new SQL.Database();
  for (const name of ALL_MIGRATIONS)
    raw.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  handle = handleFor(raw);
  secrets = createInMemorySecretStore();
});

afterEach(() => {
  raw.close();
});

/** A store as the terminal builds it at boot: bound to the origin it was started against. */
function storeFor(apiBaseUrl: string) {
  return createPairingStore({
    secretStore: secrets,
    db: bindPairingStoreDb(handle),
    deviceTokenKey: KEY,
    apiBaseUrl,
    now: () => NOW,
  });
}

const storedOrigin = (): unknown =>
  raw.exec('SELECT api_origin FROM terminal_assignment WHERE id = 1')[0]?.values[0]?.[0];

/** A pairing row as an older build wrote it: no `api_origin` column value at all. */
function writeLegacyRow(): void {
  raw.run(
    `INSERT OR REPLACE INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id)
     VALUES (1, 'tenant-1', 'branch-1', 'term-1', 'Till 1', 1760000000, 'Branch', 'Addr', 'TRN')`,
  );
}

function readerFor(s: ReturnType<typeof storeFor>) {
  return createSendableDeviceTokenReader({
    pairingStore: s,
    secretStore: secrets,
    deviceTokenKey: KEY,
  });
}

describe('RT-1348 — the pairing stores its backend origin', () => {
  it('persist writes the origin the terminal was started against', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    expect(storedOrigin()).toBe(ORIGIN_A);
  });

  it('a re-pair against another origin replaces the stored origin', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    await storeFor(ORIGIN_B).persist({ ...pairing('term-2'), paired_at: 1_760_000_100 });
    expect(storedOrigin()).toBe(ORIGIN_B);
  });

  it('an unparseable API address is stored as NULL (a legacy-shaped row)', async () => {
    await storeFor(UNUSABLE).persist(pairing());
    expect(storedOrigin()).toBeNull();
  });
});

describe('RT-1348 — same origin works', () => {
  it('reports paired and hands the token out', async () => {
    const s = storeFor(ORIGIN_A);
    await s.persist(pairing());
    expect((await s.getStatus()).kind).toBe('paired');
    expect(s.isOtherServer()).toBe(false);
    expect(await readerFor(s)()).toBe(TOKEN);
  });

  it('keeps working after a restart (a fresh store over the same database)', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    const restarted = storeFor(ORIGIN_A);
    expect((await restarted.getStatus()).kind).toBe('paired');
    expect(await readerFor(restarted)()).toBe(TOKEN);
  });
});

describe('RT-1348 — the same server spelled differently is still the same server', () => {
  it('case, default port, path and trailing slash do not matter', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    const s = storeFor(ORIGIN_A_SPELLED);
    expect((await s.getStatus()).kind).toBe('paired');
    expect(s.isOtherServer()).toBe(false);
  });
});

describe('RT-1348 — another origin: the message, and the token is never sent', () => {
  async function pairedOnAThenStartedOnB() {
    await storeFor(ORIGIN_A).persist(pairing());
    return storeFor(ORIGIN_B);
  }

  it('reports invalid / other_server', async () => {
    const s = await pairedOnAThenStartedOnB();
    expect(await s.getStatus()).toEqual(OTHER_SERVER);
    expect(s.isOtherServer()).toBe(true);
  });

  it('the sendable-token reader returns null', async () => {
    const s = await pairedOnAThenStartedOnB();
    expect(await readerFor(s)()).toBeNull();
  });

  it('a device-bearer client built on it sends nothing to the other origin', async () => {
    const s = await pairedOnAThenStartedOnB();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    const client = createCashierAdmissionClient({
      baseUrl: ORIGIN_B,
      fetch: fetchSpy,
      getDeviceToken: readerFor(s),
    });
    expect(await client.listRoster()).toEqual({ kind: 'no_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the "Check again" token read returns null too, even when the row is revoked', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    storeFor(ORIGIN_A).markDeviceRevoked();
    const s = storeFor(ORIGIN_B);
    const recheck = createRevocationRecheckTokenRead({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await recheck()).toBeNull();
  });

  it('is never recorded as a revocation (nothing is written to the row)', async () => {
    const s = await pairedOnAThenStartedOnB();
    expect(s.markDeviceRevoked()).toBeNull();
    expect(
      raw.exec('SELECT device_revoked_at FROM terminal_assignment WHERE id = 1')[0]?.values[0]?.[0],
    ).toBeNull();
    expect(s.isDeviceRevoked()).toBe(false);
  });

  it('offers no usable pairing epoch, so a sign-in cannot start under it', async () => {
    const s = await pairedOnAThenStartedOnB();
    expect(s.getPairingEpoch()).toBeNull();
  });

  it('the pairing is untouched: starting on the original origin again works', async () => {
    await pairedOnAThenStartedOnB();
    const back = storeFor(ORIGIN_A);
    expect((await back.getStatus()).kind).toBe('paired');
    expect(await readerFor(back)()).toBe(TOKEN);
  });

  it('the existing recovery path works: a re-pair against this origin makes it paired', async () => {
    const s = await pairedOnAThenStartedOnB();
    await s.persist({ ...pairing('term-2'), paired_at: 1_760_000_100 });
    expect((await s.getStatus()).kind).toBe('paired');
    expect(storedOrigin()).toBe(ORIGIN_B);
  });

  it('a stored origin against an unparseable current origin is another server', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    expect(await storeFor(UNUSABLE).getStatus()).toEqual(OTHER_SERVER);
  });

  it('is not an invalid state for an unpaired terminal', async () => {
    expect(await storeFor(ORIGIN_B).getStatus()).toEqual({ kind: 'unpaired' });
  });
});

describe('RT-1348 — a legacy pairing (no stored origin) adopts the current origin once', () => {
  it('keeps working before it adopts: paired, token handed out', async () => {
    const s = storeFor(ORIGIN_A);
    await secrets.set(KEY, TOKEN);
    writeLegacyRow();
    expect(s.isOtherServer()).toBe(false);
    expect((await s.getStatus()).kind).toBe('paired');
    expect(await readerFor(s)()).toBe(TOKEN);
    expect(storedOrigin()).toBeNull();
  });

  it('adoptApiOrigin writes the current origin when none is stored', async () => {
    const s = storeFor(ORIGIN_A);
    await secrets.set(KEY, TOKEN);
    writeLegacyRow();
    s.adoptApiOrigin();
    expect(storedOrigin()).toBe(ORIGIN_A);
  });

  it('adopts once: a later start on another origin is then the other server', async () => {
    await secrets.set(KEY, TOKEN);
    writeLegacyRow();
    storeFor(ORIGIN_A).adoptApiOrigin();
    expect(await storeFor(ORIGIN_B).getStatus()).toEqual(OTHER_SERVER);
  });

  it('never overwrites an origin that is already stored', async () => {
    await storeFor(ORIGIN_A).persist(pairing());
    const onB = storeFor(ORIGIN_B);
    onB.adoptApiOrigin();
    expect(storedOrigin()).toBe(ORIGIN_A);
  });

  it('adopts nothing when the current origin is unparseable', async () => {
    await secrets.set(KEY, TOKEN);
    writeLegacyRow();
    storeFor(UNUSABLE).adoptApiOrigin();
    expect(storedOrigin()).toBeNull();
  });

  it('adopts nothing when no pairing is stored', () => {
    storeFor(ORIGIN_A).adoptApiOrigin();
    expect(storedOrigin()).toBeUndefined();
  });
});

describe('RT-1348 — a real revocation on the same origin behaves exactly as before', () => {
  it('markDeviceRevoked records it and getStatus reports device_revoked', async () => {
    const s = storeFor(ORIGIN_A);
    await s.persist(pairing());
    expect(s.markDeviceRevoked()).toEqual({
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'term-1',
    });
    expect(await s.getStatus()).toEqual({ kind: 'invalid', reason: 'device_revoked' });
    expect(await readerFor(s)()).toBeNull();
    expect(storedOrigin()).toBe(ORIGIN_A);
  });

  it('"Check again" still reads the sealed token while revoked on the same origin', async () => {
    const s = storeFor(ORIGIN_A);
    await s.persist(pairing());
    s.markDeviceRevoked();
    const recheck = createRevocationRecheckTokenRead({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await recheck()).toBe(TOKEN);
  });
});
