/**
 * RT-1312 Phase 1 (P1-D1) — the local facts a device heartbeat reports. Every
 * reader is a read only (it never writes a sale, a sync state, a shift or a
 * session) and never throws: an unreadable fact is unknown (`null`).
 */
import { compareCodeUnits } from '../../shared/compare-code-units.js';
import type { DatabaseHandle } from '../db/client.js';
import type { SaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import type { UpdateState, UpdateStatus } from '../update/update-types.js';
import type { SaleQueueCounts } from './heartbeat-wire.js';

interface AllStatement {
  all(): unknown[];
}

/**
 * The newest applied local migration (`schema_migrations.name`), in the order the
 * migration runner applies files (code units); null when none is recorded or the
 * table cannot be read.
 */
export function readSchemaHead(db: Pick<DatabaseHandle, 'prepare'>): string | null {
  try {
    const rows = (db.prepare('SELECT name FROM schema_migrations') as AllStatement).all();
    const names = rows
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string');
    return names.sort(compareCodeUnits).pop() ?? null;
  } catch {
    return null;
  }
}

export interface SaleQueueReaderDeps {
  readonly stateRepo: Pick<SaleSyncStateRepo, 'readSyncStatus' | 'readOldestUnheldPendingAt'>;
  readonly tenantId: string;
  readonly branchId: string;
  /** The CURRENT pairing's terminal id, read live (RT-221 scope); null when unpaired. */
  readonly currentTerminalId: () => string | null;
  /** The engine's discount-capture switch, as the terminal-status aggregate passes it (RT-887). */
  readonly discountCaptureSupported: boolean;
}

/**
 * The counts of the sale-sync status surface (RT-221: `pending` = this terminal's
 * unsent sales, `heldPreviousPairing` = an earlier pairing's, `deadLetter` = every
 * refused one) and the oldest unheld pending instant (RT-887). Counts only.
 */
export function createSaleQueueReader(deps: SaleQueueReaderDeps): () => SaleQueueCounts | null {
  return () => {
    try {
      const scope = {
        tenantId: deps.tenantId,
        branchId: deps.branchId,
        terminalId: deps.currentTerminalId(),
      };
      const counts = deps.stateRepo.readSyncStatus(scope);
      return {
        pending: counts.pending,
        deadLetter: counts.deadLetter,
        heldPreviousPairing: counts.heldPreviousPairing,
        oldestPendingAt: deps.stateRepo.readOldestUnheldPendingAt(
          scope,
          deps.discountCaptureSupported,
        ),
      };
    } catch {
      return null;
    }
  };
}

/** The states in which a version is downloaded and waiting to be installed. */
const WAITING: ReadonlySet<UpdateState> = new Set([
  'downloaded',
  'compat_blocked',
  'update_pending',
  'installing',
]);

/** `update_state` and `pending_version` from the updater status (RT-322). */
export function updaterFacts(status: Pick<UpdateStatus, 'state' | 'availableVersion'>): {
  updateState: UpdateState;
  pendingVersion: string | null;
} {
  const pendingVersion = WAITING.has(status.state) ? (status.availableVersion ?? null) : null;
  return { updateState: status.state, pendingVersion };
}
