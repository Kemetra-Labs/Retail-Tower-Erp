import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { handleFor } from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import { createBrandingCache } from '../branding-cache.js';
import { createBrandingClient } from '../branding-client.js';
import { createBrandingService } from '../branding-service.js';
import { createBrandingWorker } from '../branding-worker.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';
import {
  TENANT_A,
  TENANT_B,
  VERSION_B,
  fakePairing,
  logoBody,
  noLogoBody,
  paired,
  pngBase64,
  scriptedFetch,
  silentLogger,
} from './__helpers__/branding-fixture.js';

/**
 * RT-475 acceptance (Jira AC): offline restart, version change, fallback and
 * tenant isolation after a re-pair. Real migration 0060 on sql.js, the real
 * client on the shared transport (scripted fetch), the real worker and service.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  return db;
}

/** A terminal process: the cache, service and worker over one database. */
function terminal(
  db: SqlJsDatabase,
  pairing: ReturnType<typeof fakePairing>,
  fetchAnswers: Parameters<typeof scriptedFetch>[0],
  tenantId = TENANT_A,
) {
  const cache = createBrandingCache(handleFor(db));
  const scripted = scriptedFetch(fetchAnswers);
  let changed = 0;
  const worker = createBrandingWorker({
    client: createBrandingClient({ baseUrl: 'https://bc.test', fetch: scripted.fetch }),
    cache,
    pairing,
    readDeviceToken: () => Promise.resolve('device-token'),
    tenantId,
    now: () => '2026-11-01T09:00:00.000Z',
    onChanged: () => {
      changed += 1;
    },
    tickIntervalMs: 3_600_000,
    logger: silentLogger,
  });
  const service = createBrandingService({ cache, pairing });
  return { cache, worker, service, sent: scripted.sent, changes: () => changed };
}

function count(db: SqlJsDatabase, table: string): number {
  const result = db.exec(`SELECT COUNT(*) FROM ${table}`);
  return Number(result[0]?.values[0]?.[0] ?? -1);
}

describe('RT-475 AC — offline restart', () => {
  it('a cached logo shows after a restart with the network off', async () => {
    const pairing = fakePairing(paired(TENANT_A, 100));
    const firstDb = freshDb();
    const first = terminal(firstDb, pairing, [{ status: 200, body: logoBody() }]);
    expect(await first.worker.runTickOnce()).toBe('ok');

    // Restart: a new process over the same database file, network down.
    const persisted = new SQL.Database(firstDb.export());
    const second = terminal(persisted, pairing, ['offline']);
    const snapshot = await second.service.snapshot();
    expect(snapshot.kind).toBe('logo');
    expect(await second.worker.runTickOnce()).toBe('unreachable');
    expect((await second.service.snapshot()).kind).toBe('logo');
  });

  it('the restarted worker revalidates with If-None-Match and keeps the cache on 304', async () => {
    const db = freshDb();
    const pairing = fakePairing(paired(TENANT_A, 100));
    const run = terminal(db, pairing, [{ status: 200, body: logoBody() }, { status: 304 }]);
    await run.worker.runTickOnce();
    expect(await run.worker.runTickOnce()).toBe('not_modified');
    expect(run.sent[0]).toBeNull();
    expect(run.sent[1]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(run.changes()).toBe(1);
    expect((await run.service.snapshot()).kind).toBe('logo');
  });
});

describe('RT-475 AC — version change', () => {
  it('a new version replaces the cache and the old renditions are removed', async () => {
    const db = freshDb();
    const pairing = fakePairing(paired(TENANT_A, 100));
    const run = terminal(db, pairing, [
      { status: 200, body: logoBody({ revision: 1, tag: 1 }) },
      { status: 200, body: logoBody({ revision: 2, version: VERSION_B, tag: 2 }) },
    ]);
    await run.worker.runTickOnce();
    const oldPng = pngBase64(240, 60, 1);
    expect(await run.worker.runTickOnce()).toBe('ok');

    const snapshot = await run.service.snapshot();
    if (snapshot.kind !== 'logo') throw new Error(`expected logo, got ${snapshot.kind}`);
    expect(snapshot.slots.boot.src1x).toBe(`data:image/png;base64,${pngBase64(240, 60, 2)}`);
    expect(count(db, 'tenant_branding_logo')).toBe(1);
    const stored = db.exec('SELECT version, renditions_json FROM tenant_branding_logo');
    expect(stored[0]?.values[0]?.[0]).toBe(VERSION_B);
    expect(String(stored[0]?.values[0]?.[1])).not.toContain(oldPng);
  });

  it('a removed logo (logo: null) deletes the cached renditions', async () => {
    const db = freshDb();
    const pairing = fakePairing(paired(TENANT_A, 100));
    const run = terminal(db, pairing, [
      { status: 200, body: logoBody() },
      { status: 200, body: noLogoBody() },
    ]);
    await run.worker.runTickOnce();
    await run.worker.runTickOnce();
    expect(count(db, 'tenant_branding_logo')).toBe(0);
    expect((await run.service.snapshot()).kind).toBe('none');
  });
});

describe('RT-475 AC — fallback', () => {
  it('nothing cached shows today’s screen (none)', async () => {
    const run = terminal(freshDb(), fakePairing(paired(TENANT_A, 100)), []);
    expect(await run.service.snapshot()).toEqual({ v: 1, kind: 'none' });
  });

  it('a tenant with no logo shows today’s screen (RT-832: the slot collapses)', async () => {
    const run = terminal(freshDb(), fakePairing(paired(TENANT_A, 100)), [
      { status: 200, body: noLogoBody() },
    ]);
    await run.worker.runTickOnce();
    expect((await run.service.snapshot()).kind).toBe('none');
  });

  it('a corrupt logo record shows the tenant name and the next read is unconditional', async () => {
    const db = freshDb();
    const run = terminal(db, fakePairing(paired(TENANT_A, 100)), [
      { status: 200, body: logoBody() },
      'offline',
    ]);
    await run.worker.runTickOnce();
    db.run(
      `UPDATE tenant_branding_logo SET renditions_json = replace(renditions_json, 'iVBOR', 'iVBOQ')`,
    );

    expect(await run.service.snapshot()).toEqual({
      v: 1,
      kind: 'name',
      displayName: 'صيدلية النور',
    });
    expect(count(db, 'tenant_branding_logo')).toBe(0);
    await run.worker.runTickOnce();
    expect(run.sent[1]).toBeNull();
  });

  it('a tampered digest also falls back to the name', async () => {
    const db = freshDb();
    const run = terminal(db, fakePairing(paired(TENANT_A, 100)), [
      { status: 200, body: logoBody() },
    ]);
    await run.worker.runTickOnce();
    db.run(`UPDATE tenant_branding_logo SET payload_sha256 = '${'0'.repeat(64)}'`);
    expect((await run.service.snapshot()).kind).toBe('name');
  });

  it('a corrupt name record purges both records and shows today’s screen', async () => {
    const db = freshDb();
    const run = terminal(db, fakePairing(paired(TENANT_A, 100)), [
      { status: 200, body: logoBody() },
    ]);
    await run.worker.runTickOnce();
    db.run(`UPDATE tenant_branding_name SET tenant_display_name = 'Other Pharmacy'`);
    expect((await run.service.snapshot()).kind).toBe('none');
    expect(count(db, 'tenant_branding_name') + count(db, 'tenant_branding_logo')).toBe(0);
  });

  it('an off-contract 200 never replaces a good cache', async () => {
    const db = freshDb();
    const run = terminal(db, fakePairing(paired(TENANT_A, 100)), [
      { status: 200, body: logoBody() },
      { status: 200, body: { ...logoBody(), extra: true } },
    ]);
    await run.worker.runTickOnce();
    expect(await run.worker.runTickOnce()).toBe('unreadable');
    expect((await run.service.snapshot()).kind).toBe('logo');
  });
});

describe('RT-475 AC — tenant isolation after a re-pair', () => {
  async function cachedFor(status: PairingStatus) {
    const db = freshDb();
    const pairing = fakePairing(status, 100);
    const run = terminal(db, pairing, [{ status: 200, body: logoBody() }]);
    await run.worker.runTickOnce();
    expect((await run.service.snapshot()).kind).toBe('logo');
    return { db, pairing, run };
  }

  it('a re-pair to another tenant never shows the previous logo and clears the cache', async () => {
    const { db, pairing, run } = await cachedFor(paired(TENANT_A, 100));
    pairing.state.status = paired(TENANT_B, 101);
    expect((await run.service.snapshot()).kind).toBe('none');
    expect(count(db, 'tenant_branding_name') + count(db, 'tenant_branding_logo')).toBe(0);
  });

  it('a re-pair to the same tenant clears the cache too (new pairing epoch)', async () => {
    const { db, pairing, run } = await cachedFor(paired(TENANT_A, 100));
    pairing.state.status = paired(TENANT_A, 101);
    expect((await run.service.snapshot()).kind).toBe('none');
    expect(count(db, 'tenant_branding_name')).toBe(0);
  });

  it('an unpair clears the cache', async () => {
    const { db, pairing, run } = await cachedFor(paired(TENANT_A, 100));
    pairing.state.status = { kind: 'unpaired' };
    expect((await run.service.snapshot()).kind).toBe('none');
    expect(count(db, 'tenant_branding_name') + count(db, 'tenant_branding_logo')).toBe(0);
  });

  it('a device revocation keeps the cache (FR-32) for the same pairing only', async () => {
    const { db, pairing, run } = await cachedFor(paired(TENANT_A, 100));
    pairing.state.status = { kind: 'invalid', reason: 'device_revoked' };
    expect((await run.service.snapshot()).kind).toBe('logo');
    pairing.state.storedEpoch = 101;
    expect((await run.service.snapshot()).kind).toBe('none');
    expect(count(db, 'tenant_branding_name')).toBe(0);
  });

  it('a read that started before a re-pair is never written into the new pairing', async () => {
    const db = freshDb();
    const pairing = fakePairing(paired(TENANT_A, 100));
    const cache = createBrandingCache(handleFor(db));
    const worker = createBrandingWorker({
      client: {
        read: () => {
          pairing.state.status = paired(TENANT_B, 101);
          return Promise.resolve({ kind: 'ok', branding: expectBranding() });
        },
      },
      cache,
      pairing,
      readDeviceToken: () => Promise.resolve('device-token'),
      tenantId: TENANT_A,
      now: () => '2026-11-01T09:00:00.000Z',
      onChanged: () => undefined,
      tickIntervalMs: 3_600_000,
      logger: silentLogger,
    });
    expect(await worker.runTickOnce()).toBe('superseded');
    expect(count(db, 'tenant_branding_name')).toBe(0);
  });

  it('a worker of the previous tenant skips once the terminal is re-paired', async () => {
    const pairing = fakePairing(paired(TENANT_B, 101));
    const run = terminal(freshDb(), pairing, [{ status: 200, body: logoBody() }], TENANT_A);
    expect(await run.worker.runTickOnce()).toBe('skipped');
    expect(run.sent).toHaveLength(0);
  });
});

function expectBranding() {
  return {
    tenant_display_name: 'Other',
    revision: 1,
    logo: null,
  } as const;
}
