import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { SaleSyncStatusCounts } from '../../sales-sync/sale-sync-state-repo.js';
import { createSaleQueueReader, readSchemaHead, updaterFacts } from '../heartbeat-facts.js';

/**
 * RT-1312 Phase 1 — the local facts a heartbeat reports: the newest applied
 * migration, the sale-queue counts and the updater state. Each is a read; an
 * unreadable fact is unknown (null), never a default.
 */

beforeAll(async () => {
  await initCatalogueSql();
});

describe('readSchemaHead', () => {
  it('is the newest applied migration name in the runner order (code units)', () => {
    const db = freshCatalogueDb();
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT, checksum TEXT);
      INSERT INTO schema_migrations (name) VALUES ('0059_shift_count_attempts'),
        ('0060_tenant_branding_cache'), ('0001_init');`);
    expect(readSchemaHead(handleFor(db))).toBe('0060_tenant_branding_cache');
  });

  it('is null with no applied migration, or when the table cannot be read', () => {
    const db = freshCatalogueDb();
    db.exec('DROP TABLE IF EXISTS schema_migrations;');
    expect(readSchemaHead(handleFor(db))).toBeNull();
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY);');
    expect(readSchemaHead(handleFor(db))).toBeNull();
  });
});

describe('createSaleQueueReader', () => {
  const COUNTS: SaleSyncStatusCounts = {
    pending: 3,
    heldPreviousPairing: 2,
    deadLetter: 1,
    payloadDivergence: 1,
    lastSuccessAt: '2026-11-10T11:00:00.000Z',
  };

  it('reads the current terminal counts and the oldest unheld pending instant, counts only', () => {
    const stateRepo = {
      readSyncStatus: vi.fn(() => COUNTS),
      readOldestUnheldPendingAt: vi.fn(() => '2026-11-10T11:58:00.000Z'),
    };
    const read = createSaleQueueReader({
      stateRepo,
      tenantId: 't1',
      branchId: 'b1',
      currentTerminalId: () => 'term-2',
      discountCaptureSupported: true,
    });
    expect(read()).toEqual({
      pending: 3,
      deadLetter: 1,
      heldPreviousPairing: 2,
      oldestPendingAt: '2026-11-10T11:58:00.000Z',
    });
    const scope = { tenantId: 't1', branchId: 'b1', terminalId: 'term-2' };
    expect(stateRepo.readSyncStatus).toHaveBeenCalledWith(scope);
    expect(stateRepo.readOldestUnheldPendingAt).toHaveBeenCalledWith(scope, true);
  });

  it('is null (unknown) when the read throws', () => {
    const read = createSaleQueueReader({
      stateRepo: {
        readSyncStatus: () => {
          throw new Error('The database connection is not open');
        },
        readOldestUnheldPendingAt: () => null,
      },
      tenantId: 't1',
      branchId: 'b1',
      currentTerminalId: () => 'term-2',
      discountCaptureSupported: true,
    });
    expect(read()).toBeNull();
  });
});

describe('updaterFacts', () => {
  it('reports the state, and the version only once it is downloaded and waiting', () => {
    expect(updaterFacts({ state: 'downloading', availableVersion: '1.5.0' })).toEqual({
      updateState: 'downloading',
      pendingVersion: null,
    });
    for (const state of ['downloaded', 'compat_blocked', 'update_pending', 'installing'] as const) {
      expect(updaterFacts({ state, availableVersion: '1.5.0' })).toEqual({
        updateState: state,
        pendingVersion: '1.5.0',
      });
    }
    expect(updaterFacts({ state: 'update_pending' })).toEqual({
      updateState: 'update_pending',
      pendingVersion: null,
    });
  });
});
