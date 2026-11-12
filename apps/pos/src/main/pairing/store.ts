import type { Logger } from 'pino';

import type { DatabaseHandle } from '../db/client.js';
import type { SecretKey, SecretStore } from '../../shared/secret-store.js';
import type { PairingStatus } from '../../shared/pairing-types.js';

import { isOtherServer, normalizeApiOrigin } from './api-origin.js';
import {
  bindingOf,
  openDeviceToken,
  sameBinding,
  sealDeviceToken,
  type OpenedDeviceToken,
  type PairingBinding,
} from './token-binding.js';

/**
 * 002-terminal-pairing T011 — pairingStore.
 *
 * The single module that touches both halves of pairing state on the
 * terminal: the device_token in the SecretStore, and the
 * terminal_assignment row in SQLite. No other module gets a SQL cursor
 * for that table (data-model.md § terminal_assignment).
 *
 * Status derivation (data-model.md):
 *
 *   token  | row     | status     | reason
 *   :----- | :------ | :--------- | :--------------
 *   missing| absent  | unpaired   | n/a
 *   ok     | present | paired     | n/a
 *   missing| present | invalid    | orphaned_row    (row sits alone)
 *   ok     | absent  | invalid    | missing_token   (token sits alone)
 *   any    | revoked | invalid    | device_revoked  (RT-215; checked FIRST, review F7)
 *   garbled| any     | invalid    | decrypt_failed  (DPAPI cannot decrypt)
 *   other  | present | invalid    | inconsistent    (RT-306; token sealed for another
 *          |         |            |                  pairing, or unreadable)
 *   any    | other   | invalid    | other_server    (RT-1348; the row's `api_origin` is not
 *          | origin  |            |                  this process's; checked BEFORE the rest,
 *          |         |            |                  the token is never read or sent)
 *
 * Reason mapping rationale: `orphaned_row` describes the row's state
 * (it is orphaned); `missing_token` describes what is missing relative
 * to the row that exists. `decrypt_failed` overrides any orphan-direction
 * reason because the SecretStore is unhealthy on this machine — that is
 * the operator's first concern. The pairing-types.ts:17-22 docstring
 * sentences match this mapping verbatim.
 *
 * R1 mitigation: this module's only direct DB interaction goes through
 * the `PairingStoreDb` interface. Production binds it to a
 * better-sqlite3 `DatabaseHandle`; tests pass a sql.js-backed adapter.
 *
 * Security policy (Constitution VII + spec NFR-4 / FR-9 / FR-10):
 *   - The device_token is read from / written to the SecretStore by key
 *     and never echoed to any logger.
 *   - getStatus()'s return type is `PairingStatus`, which carries no
 *     token field — the renderer therefore never sees a token even if
 *     a future bug exposes the result.
 */

/** Row shape for the single-row terminal_assignment table. */
export interface TerminalAssignmentRow {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  terminal_label: string;
  /** Unix epoch seconds. */
  paired_at: number;
  // ── Added 2026-05-28 by 008 T094a (PR #272 pinned the contract;
  //    migration 0027 added the columns; this PR populates them).
  //
  //    The three branch / tax-registration fields come from
  //    `TerminalPairResponse` per Data-Pulse-2 PR #388 (merged
  //    2026-05-28; squash commit 6c9dda2). They populate the local
  //    `terminal_assignment` row at pair-time and are consumed by the
  //    receipt template + print pipeline.
  //
  //    Nullability: declared as `string | null` rather than
  //    optional (`?:`) because the migration 0027 added the SQL
  //    columns as NULLABLE without DEFAULT. Existing dev terminals
  //    paired before 2026-05-28 have a row in terminal_assignment
  //    with NULL for these fields; re-pair populates them.
  //    A future migration may enforce NOT NULL once dev fixtures
  //    have all been re-paired (see migration 0027 comment block).
  //
  //    RT-1183 (RT-1165 S3): the three printer columns that migration
  //    0027 also added (the printer USB vendor / product IDs and the
  //    COM port) are no longer written or read. The pair response may
  //    still carry them; the POS ignores them. The columns stay in the
  //    table, unused and nullable (no migration; dropping them is a
  //    separate owner decision). Rows already holding values are left
  //    as they are until the terminal is re-paired, which replaces the
  //    whole row.
  branch_name: string | null;
  branch_address: string | null;
  tenant_tax_registration_id: string | null;
  /**
   * RT-1348 (RT-1345 D3, migration 0061) — the normalized Backend-Core origin the
   * pairing was made against. `null` / absent: a pairing from before 0061 (it
   * adopts the current origin once Backend-Core accepts its token), or one made
   * while the API address could not be parsed. Optional so a row written before
   * 0061 still type-checks.
   */
  api_origin?: string | null;
}

/**
 * RT-215 — the row as read back: the pairing fields plus the durable
 * device-revoked marker (migration 0042). Optional so an adapter written
 * before 0042 still type-checks; `undefined` and `null` both mean "not
 * revoked".
 */
export interface StoredAssignmentRow extends TerminalAssignmentRow {
  /** Unix epoch seconds when the revocation was confirmed; null when not revoked. */
  device_revoked_at?: number | null;
}

/** RT-215 — the identity of the pairing that was revoked (audit attribution). */
export interface RevokedTerminalScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

/**
 * Narrow surface the pairing store needs from the database. Production
 * adapter binds this to a `DatabaseHandle` (better-sqlite3); tests pass a
 * sql.js-backed implementation. The interface is intentionally small —
 * only the operations the store performs against terminal_assignment.
 */
export interface PairingStoreDb {
  /** Read the single row, or null if absent. */
  readAssignment(): StoredAssignmentRow | null;
  /** Write/replace the single row at id = 1. */
  writeAssignment(row: TerminalAssignmentRow): void;
  /** Delete the single row (idempotent). */
  deleteAssignment(): void;
  /**
   * RT-215 — set `device_revoked_at` on the single row if it is not set yet
   * (idempotent: the first confirmation time is kept). A re-pair's
   * `writeAssignment` (INSERT OR REPLACE) resets it to NULL.
   */
  markDeviceRevoked(atEpochSeconds: number): void;
  /**
   * RT-215 10897-A — set `device_revoked_at` back to NULL on the single row
   * (a "Check again" the server answered 2xx). Idempotent.
   */
  clearDeviceRevoked(): void;
  /**
   * RT-1348 — set `api_origin` on the single row ONLY while it is NULL (a legacy
   * pairing adopts the origin once; an origin already stored is never replaced).
   * Optional so an adapter written before 0061 still type-checks: without it
   * adoption is a no-op.
   */
  adoptApiOrigin?(origin: string): void;
  /** Run `fn` inside BEGIN/COMMIT; rollback + rethrow on error. */
  transaction<T>(fn: () => T): T;
}

export interface PairingStore {
  /**
   * Inspect both halves of state and return a discriminated PairingStatus
   * for the renderer to route on. Cheap; one SecretStore read + one row
   * read. Read-only — never mutates state, even on partial corruption.
   */
  getStatus(): Promise<PairingStatus>;

  /**
   * #380 (F-007) — the SYNCHRONOUS real-terminal-id accessor. Returns the
   * `terminal_assignment` row's `terminal_id`, or null when unpaired.
   *
   * Why a separate sync method rather than reading it off `getStatus()`:
   * `getStatus()` is async ONLY because it must `await` the device-token
   * decrypt (safeStorage) to distinguish paired/invalid. The `terminal_id`
   * itself is a plaintext column read synchronously from SQLite
   * (`db.readAssignment()`) and needs no token. The payment / sales / cart
   * session adapters are SYNC closures invoked per-operation; they need the
   * real terminal_id without taking an async hop (making them async would
   * ripple through the whole payment handler chain). This accessor gives
   * them that sync seam and reflects pairing state at CALL time, so a
   * terminal that pairs mid-process resolves correctly.
   *
   * Constitution VIII: the terminal_id is device-scope identity (not the
   * operator/branch), and it is NOT a secret — so exposing it synchronously
   * here, separate from the encrypted token path, is correct.
   */
  getCurrentTerminalId(): string | null;

  /**
   * RT-215 rev546b S-2 — the STORED pairing epoch (`paired_at`) whatever the
   * status, revoked included; null when no row exists. For the offline grant
   * wrapper's prior-epoch floor ONLY (RT-113 F4 `prior + 1`): a send path must
   * use `getStatus()` / `getPairingEpoch()`, which are null while revoked.
   * Optional so the many read-only fakes stay valid.
   */
  getStoredPairingEpoch?(): number | null;

  /**
   * Persist a successful pairing: write the device_token to the
   * SecretStore AND insert the assignment row, in a single
   * transactional unit. Rolls back the SecretStore write if the SQL
   * write fails. Idempotent on re-pair (overwrites both halves).
   *
   * NOTE: T010-T017 (US1) does not call this from any application path
   * yet; T022+ (US2) wires it to the successful submit response.
   */
  persist(input: PersistInput): Promise<void>;

  /**
   * Drop both halves. Idempotent: a missing entry is not an error.
   * The only call path that wipes pairing state.
   */
  clear(): Promise<void>;
}

/**
 * RT-215 — the device-revoked capability. Kept off {@link PairingStore} so the
 * many read-only consumers (and their fakes) do not grow a write method; only
 * the revocation flow is handed this.
 */
export interface DeviceRevocationStore {
  /**
   * Record that Backend-Core confirmed this terminal's device credential is
   * revoked. Durable (the pairing row) and immediate (an in-memory latch set
   * FIRST, so the token stops being sendable even if the row write fails —
   * that failure is then rethrown for the caller to log). Idempotent.
   *
   * Returns the revoked pairing's scope, or null when nothing is paired (then
   * nothing is recorded). The device token is NOT deleted: it stays sealed,
   * is never sent again, and a re-pair (`persist`) overwrites it.
   *
   * Fail closed (review F1): nothing automatic un-revokes it. The sealed token
   * is never sent by a normal path again (owner approval (3), RT-215 10875).
   * The two ways out are a re-pair with a new code, or the ONE user-initiated
   * "Check again" that the server answers 2xx ({@link clearDeviceRevoked},
   * RT-215 10897-A / 10906).
   */
  markDeviceRevoked(): RevokedTerminalScope | null;

  /**
   * RT-215 10897-A (owner approval 10906) — clear a revocation after the
   * user-initiated "Check again" was answered 2xx. ONLY that flow calls it.
   *
   * Durable FIRST, then in memory: a failing row write is rethrown and the
   * terminal stays revoked (fail closed). The pairing epoch changes, so a
   * sign-in captured under the revocation stays stale. Returns the pairing's
   * scope, or null (nothing done) when the terminal is not revoked.
   */
  clearDeviceRevoked(): RevokedTerminalScope | null;

  /**
   * RT-215 / Codex P1 4181556645 — SYNC: true while the pairing row is
   * revoked (durable marker or the in-memory latch).
   */
  isDeviceRevoked(): boolean;

  /**
   * RT-215 / Codex P1 4181556645 — SYNC identity of the current USABLE
   * pairing: null while unpaired or revoked; otherwise a value that changes on
   * every pairing in this process (a re-pair, even of the same terminal id).
   * Sign-in and takeover capture it at request start and re-check it right
   * before creating the session, so a late success under a revoked or
   * replaced pairing is dropped. Not a secret; never leaves the main process.
   */
  getPairingEpoch(): string | null;

  /** See {@link PairingStore.getStoredPairingEpoch} (required on the real store). */
  getStoredPairingEpoch(): number | null;

  /**
   * RT-306 — SYNC identity of the STORED pairing row whatever its status,
   * revoked included; null when no row exists. For the "Check again" token read
   * only, which runs while revoked: it sends nothing unless the sealed token is
   * bound to this row. Not a secret; never leaves the main process.
   */
  getStoredPairingBinding(): PairingBinding | null;
}

/**
 * RT-1348 (RT-1345 D3) — the pairing's backend origin. Kept off
 * {@link PairingStore} for the same reason as {@link DeviceRevocationStore}:
 * read-only consumers and their fakes do not grow methods.
 */
export interface ApiOriginBinding {
  /**
   * SYNC: true when the stored pairing was made against another Backend-Core
   * origin than the one this process is configured for. Nothing is sent to the
   * other origin while it is true; it is NOT a revocation. False when nothing
   * is stored (a legacy pairing, or no pairing).
   */
  isOtherServer: () => boolean;
  /**
   * A legacy pairing (no stored origin) adopts the current origin the first time
   * Backend-Core accepts its device token. Idempotent; never replaces an origin
   * that is already stored; a no-op when nothing is paired or the current origin
   * is unusable.
   */
  adoptApiOrigin: () => void;
}

export interface PersistInput extends TerminalAssignmentRow {
  /** Opaque server-issued token. SECRET — never logged. */
  device_token: string;
}

export interface CreatePairingStoreOptions {
  secretStore: SecretStore;
  db: PairingStoreDb;
  /**
   * The SecretStore key under which the device token is held. Injected so
   * tests can use a known key and so a future feature could rotate the
   * key name without a code-wide find/replace.
   */
  deviceTokenKey: SecretKey;
  /** RT-215 — wall clock for `device_revoked_at`. Defaults to `new Date()`. */
  now?: () => Date;
  /**
   * RT-1348 — the API address this process was started with
   * (`resolveApiBaseUrl()`). Its normalized origin (null when unusable) is what a
   * pairing stamps, and a stored origin that differs reads as another server.
   * Left out (`undefined`), no origin is stamped or compared: only for fakes.
   */
  apiBaseUrl?: string;
  /** RT-1348 — logs the origin transitions (`pairing.api_origin.*`). */
  logger?: Pick<Logger, 'info' | 'warn'>;
}

type TokenState =
  | { kind: 'present'; opened: OpenedDeviceToken }
  | { kind: 'absent' }
  | { kind: 'decrypt_failed' };

/**
 * The status of an UNREVOKED row and the token half (the revoked check runs
 * first, before and after the token read — see `getStatus`).
 */
function statusFrom(tokenState: TokenState, row: StoredAssignmentRow | null): PairingStatus {
  // decrypt_failed dominates the rest: the operator's first concern is
  // "the SecretStore is unhealthy on this machine". The orphan
  // direction beneath does not matter for the recovery flow.
  if (tokenState.kind === 'decrypt_failed') return { kind: 'invalid', reason: 'decrypt_failed' };
  const tokenPresent = tokenState.kind === 'present';
  if (row === null)
    return tokenPresent ? { kind: 'invalid', reason: 'missing_token' } : { kind: 'unpaired' };
  if (tokenState.kind !== 'present') return { kind: 'invalid', reason: 'orphaned_row' };
  // RT-306: a token sealed for another pairing (a crash mid-re-pair) or one that
  // cannot be read back is never reported paired, so it is never sent.
  const { opened } = tokenState;
  if (opened.kind === 'malformed') return INCONSISTENT_STATUS;
  if (opened.kind === 'bound' && !sameBinding(opened.binding, row)) return INCONSISTENT_STATUS;
  return {
    kind: 'paired',
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    terminal_id: row.terminal_id,
    terminal_label: row.terminal_label,
    paired_at: row.paired_at,
    // RT-1316: the store's display name for the Ready card. The other receipt
    // fields (address, tax registration id) stay off this renderer surface.
    branch_name: row.branch_name ?? null,
  };
}

const DEVICE_REVOKED_STATUS: PairingStatus = { kind: 'invalid', reason: 'device_revoked' };

/** RT-306 — getStatus re-reads at most this often while the row keeps changing. */
const STATUS_READ_ATTEMPTS = 3;

function sameStoredPairing(a: PairingBinding | null, b: PairingBinding | null): boolean {
  return a === null || b === null ? a === b : sameBinding(a, b);
}
const INCONSISTENT_STATUS: PairingStatus = { kind: 'invalid', reason: 'inconsistent' };
/** RT-1348 — paired against another Backend-Core than this process is configured for. */
const OTHER_SERVER_STATUS: PairingStatus = { kind: 'invalid', reason: 'other_server' };

export function createPairingStore(
  options: CreatePairingStoreOptions,
): PairingStore & DeviceRevocationStore & ApiOriginBinding {
  const { secretStore, db, deviceTokenKey, logger } = options;
  const apiOrigin =
    options.apiBaseUrl === undefined ? undefined : normalizeApiOrigin(options.apiBaseUrl);
  const now = options.now ?? ((): Date => new Date());
  /** RT-1348 — the mismatch is logged once per process, not on every status read. */
  let otherServerLogged = false;

  /** RT-1348 — is this stored row bound to another backend than this process uses? */
  function otherServer(row: StoredAssignmentRow | null): boolean {
    return apiOrigin !== undefined && row !== null && isOtherServer(row.api_origin, apiOrigin);
  }

  function logOtherServerOnce(): void {
    if (otherServerLogged) return;
    otherServerLogged = true;
    // Event name only: no origin, URL or identifier reaches the log (OBS-1 allowlist).
    logger?.warn(
      { event: 'pairing.api_origin.mismatch' },
      'terminal is paired with another server; the device token is not sent',
    );
  }
  /**
   * RT-215 — set by markDeviceRevoked() BEFORE the row write, cleared by a
   * re-pair (persist) or clear(). Makes the revocation take effect in this
   * process even if the durable write fails.
   */
  let revokedInMemory = false;
  /** RT-215 — bumped on every persist/clear/revoke; part of the pairing epoch. */
  let generation = 0;

  function rowRevoked(row: StoredAssignmentRow): boolean {
    return revokedInMemory || typeof row.device_revoked_at === 'number';
  }

  /** Revoked, or bound to another backend: no usable pairing in this process. */
  function notUsable(row: StoredAssignmentRow): boolean {
    return rowRevoked(row) || otherServer(row);
  }

  function storedBinding(): PairingBinding | null {
    const row = db.readAssignment();
    return row === null ? null : bindingOf(row);
  }

  /** SYNC: is the CURRENT row revoked (in-memory latch or durable marker)? */
  function isRevokedNow(): boolean {
    const row = db.readAssignment();
    return row !== null && rowRevoked(row);
  }

  /**
   * Read the token defensively. Returns:
   *   - `{ kind: 'present', opened }` if a non-empty value is held (RT-306:
   *     opened, so its binding can be compared with the row),
   *   - `{ kind: 'absent' }` if no entry exists,
   *   - `{ kind: 'decrypt_failed' }` if get() rejects (DPAPI failure).
   *
   * The decrypt-failed branch is the SAFE-LANDING for a corrupt-keystore
   * installation; it MUST NOT throw out of getStatus() — the renderer
   * needs to land on /pairing with a banner instead of crashing the boot.
   */
  async function readTokenState(): Promise<TokenState> {
    try {
      const value = await secretStore.get(deviceTokenKey);
      if (value === null || value.length === 0) return { kind: 'absent' };
      return { kind: 'present', opened: openDeviceToken(value) };
    } catch {
      // We do NOT include the underlying error message in the result.
      // The error MAY contain ciphertext bytes or path data; treating
      // any get() rejection as decrypt_failed is the conservative,
      // logger-safe option (Constitution VII).
      return { kind: 'decrypt_failed' };
    }
  }

  return {
    async getStatus(): Promise<PairingStatus> {
      // RT-1348: a pairing made against another backend is reported before
      // anything else, so nothing downstream (not even a revoked marker left by
      // the other backend) reads it as this backend's pairing. Local only: the
      // token is never read, let alone sent.
      if (otherServer(db.readAssignment())) {
        logOtherServerOnce();
        return OTHER_SERVER_STATUS;
      }

      // RT-215 (review F7): the pairing row is the source of truth for
      // revocation, and it is reported FIRST — whatever state the token half
      // is in, even an undecryptable one, the terminal must re-pair.
      if (isRevokedNow()) return DEVICE_REVOKED_STATUS;

      // RT-306 (Codex P2 on #582): an asynchronous SecretStore can resolve a
      // token read after a re-pair has replaced the row, and that stale token
      // would look like a token/row mismatch. Read again while the row changed
      // under the read; a stable row with a mismatched token is the real thing.
      let status: PairingStatus = DEVICE_REVOKED_STATUS;
      for (let attempt = 0; attempt < STATUS_READ_ATTEMPTS; attempt += 1) {
        const before = storedBinding();
        const tokenState = await readTokenState();
        // Codex P1 4186568808: the revocation may have been latched while the
        // token read was pending. Re-read the row after the await and check
        // again, so `paired` is never reported for a revoked device.
        if (isRevokedNow()) return DEVICE_REVOKED_STATUS;
        const row = db.readAssignment();
        status = statusFrom(tokenState, row);
        if (sameStoredPairing(before, row === null ? null : bindingOf(row))) return status;
      }
      return status;
    },

    getStoredPairingEpoch(): number | null {
      return db.readAssignment()?.paired_at ?? null;
    },

    getStoredPairingBinding(): PairingBinding | null {
      return storedBinding();
    },

    getCurrentTerminalId(): string | null {
      // Sync plaintext read — see the interface doc for why this does NOT
      // go through the async token path. No safeStorage, no await.
      return db.readAssignment()?.terminal_id ?? null;
    },

    async persist(input: PersistInput): Promise<void> {
      // Atomicity contract:
      //   1. Write the SecretStore (token) FIRST so a SQL failure can be
      //      compensated by deleting the token.
      //   2. Open a SQL transaction; write the row; commit.
      //   3. If the SQL transaction throws, compensate by deleting the
      //      token from the SecretStore. Both halves are then back to
      //      their pre-call state.
      //
      // Doing it in this order means a hard process crash between (1)
      // and (2) leaves an orphaned token, which getStatus() reports as
      // `invalid/missing_token`; the operator re-pairs and is back to
      // a consistent state. The reverse order would leave an orphaned
      // row instead — same recovery surface, different reason.
      //
      // RT-306: on a RE-pair the same crash leaves the new token beside the
      // old row. The token is sealed with the identity of the pairing it was
      // issued for, so getStatus() reports that as `invalid/inconsistent` and
      // no reader hands it out.
      await secretStore.set(deviceTokenKey, sealDeviceToken(input.device_token, input));
      try {
        // RT-215: a re-pair replaces the whole row (INSERT OR REPLACE), so
        // `device_revoked_at` returns to NULL with the new pairing.
        db.transaction(() => {
          db.writeAssignment({
            tenant_id: input.tenant_id,
            branch_id: input.branch_id,
            terminal_id: input.terminal_id,
            terminal_label: input.terminal_label,
            paired_at: input.paired_at,
            branch_name: input.branch_name,
            branch_address: input.branch_address,
            tenant_tax_registration_id: input.tenant_tax_registration_id,
            // RT-1348: the pairing was just made against THIS process's backend.
            api_origin: apiOrigin ?? null,
          });
        });
      } catch (err) {
        // Compensation. We deliberately swallow any error from delete()
        // because the original SQL failure is the load-bearing one to
        // surface; a stacked compensation failure would obscure it.
        await secretStore.delete(deviceTokenKey).catch(() => {
          /* noop — original SQL error is the one the caller cares about */
        });
        throw err;
      }
      revokedInMemory = false;
      generation += 1;
    },

    markDeviceRevoked(): RevokedTerminalScope | null {
      const row = db.readAssignment();
      if (row === null) return null;
      // RT-1348: a revocation is a statement about the backend the pairing was
      // made on; another backend's answer never records one.
      if (otherServer(row)) return null;
      // In memory FIRST: the token stops being sendable at once, even if the
      // durable write below throws (the caller logs that failure).
      revokedInMemory = true;
      generation += 1;
      db.markDeviceRevoked(Math.floor(now().getTime() / 1000));
      return { tenant_id: row.tenant_id, branch_id: row.branch_id, terminal_id: row.terminal_id };
    },

    clearDeviceRevoked(): RevokedTerminalScope | null {
      const row = db.readAssignment();
      if (row === null || !rowRevoked(row)) return null;
      // Durable first: if this throws, the in-memory latch stays set.
      db.clearDeviceRevoked();
      revokedInMemory = false;
      generation += 1;
      return { tenant_id: row.tenant_id, branch_id: row.branch_id, terminal_id: row.terminal_id };
    },

    isDeviceRevoked(): boolean {
      return isRevokedNow();
    },

    isOtherServer: (): boolean => otherServer(db.readAssignment()),

    adoptApiOrigin: (): void => {
      // Only a legacy row (no origin) adopts; the SQL repeats the NULL guard so a
      // re-pair that lands between the read and the write is never overwritten.
      if (apiOrigin === undefined || apiOrigin === null) return;
      const row = db.readAssignment();
      if (row === null || typeof row.api_origin === 'string') return;
      db.adoptApiOrigin?.(apiOrigin);
      logger?.info(
        { event: 'pairing.api_origin.adopted' },
        'legacy pairing recorded the backend origin it was accepted on',
      );
    },

    getPairingEpoch(): string | null {
      const row = db.readAssignment();
      if (row === null || notUsable(row)) return null;
      return `${String(generation)}|${row.terminal_id}|${String(row.paired_at)}`;
    },

    async clear(): Promise<void> {
      // Both deletes are idempotent. The order does not matter for
      // correctness — clear() is the only path that wipes state and
      // there is no in-flight reader to race with.
      //
      // RT-215 (supersedes the T072 / US7 "clear() on 401" seam): a
      // confirmed device 401 does NOT clear pairing state. It calls
      // markDeviceRevoked(), which keeps the token sealed (never sent again;
      // recovery is a re-pair with a new code) and keeps the row for the
      // recovery screen. clear() owns no logger call by design (FR-8 / T071).
      db.deleteAssignment();
      revokedInMemory = false;
      generation += 1;
      await secretStore.delete(deviceTokenKey);
    },
  };
}

/**
 * Adapt a `DatabaseHandle` (better-sqlite3) to `PairingStoreDb`. Used at
 * the production wire-in site (`src/main/index.ts`); tests pass their
 * own adapter (sql.js-backed in store.test.ts).
 *
 * Statements are prepared LAZILY (on first use), mirroring the
 * `bindMigrationsDb` pattern: eager preparation would crash on a fresh
 * DB before the migration runner had a chance to apply
 * `0003_terminal_assignment`.
 */
export function bindPairingStoreDb(handle: DatabaseHandle): PairingStoreDb {
  type SelectStmt = { get(): StoredAssignmentRow | undefined };
  type RunStmt = { run(...params: unknown[]): unknown };

  let selectStmt: SelectStmt | null = null;
  let insertStmt: RunStmt | null = null;
  let deleteStmt: RunStmt | null = null;
  let revokeStmt: RunStmt | null = null;
  let unrevokeStmt: RunStmt | null = null;
  let adoptStmt: RunStmt | null = null;

  return {
    readAssignment(): StoredAssignmentRow | null {
      // SELECT projects 8 assignment columns (5 baseline from 0003 + 3
      // added by migration 0027) plus `device_revoked_at`. The 0027
      // columns are NULLABLE at the SQL layer; better-sqlite3 returns
      // SQL NULL as JS `null` directly, which matches the `string | null`
      // shape on TerminalAssignmentRow. RT-215: + `device_revoked_at`
      // (migration 0042). RT-1183: the three unused printer_* columns
      // are not selected.
      selectStmt ??= handle.prepare(
        `SELECT tenant_id, branch_id, terminal_id, terminal_label, paired_at,
                branch_name, branch_address, tenant_tax_registration_id,
                device_revoked_at, api_origin
         FROM terminal_assignment WHERE id = 1`,
      ) as SelectStmt;
      const row = selectStmt.get();
      return row === undefined ? null : row;
    },
    writeAssignment(row: TerminalAssignmentRow): void {
      // INSERT OR REPLACE writes 9 columns. RT-1183: the three unused
      // printer_* columns (migration 0027) are not written, so a re-pair
      // leaves them NULL (the row is replaced as a whole). RT-1348: + `api_origin`
      // (migration 0061), the backend this pairing was made against.
      insertStmt ??= handle.prepare(
        `INSERT OR REPLACE INTO terminal_assignment
           (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
            branch_name, branch_address, tenant_tax_registration_id, api_origin)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ) as RunStmt;
      insertStmt.run(
        row.tenant_id,
        row.branch_id,
        row.terminal_id,
        row.terminal_label,
        row.paired_at,
        row.branch_name,
        row.branch_address,
        row.tenant_tax_registration_id,
        row.api_origin ?? null,
      );
    },
    deleteAssignment(): void {
      deleteStmt ??= handle.prepare('DELETE FROM terminal_assignment WHERE id = 1') as RunStmt;
      deleteStmt.run();
    },
    markDeviceRevoked(atEpochSeconds: number): void {
      // Keeps the FIRST confirmation time; a re-pair's INSERT OR REPLACE
      // resets the column to NULL.
      revokeStmt ??= handle.prepare(
        `UPDATE terminal_assignment SET device_revoked_at = ?
         WHERE id = 1 AND device_revoked_at IS NULL`,
      ) as RunStmt;
      revokeStmt.run(atEpochSeconds);
    },
    clearDeviceRevoked(): void {
      // RT-215 10897-A — a row update; no schema change (migration 0042's column).
      unrevokeStmt ??= handle.prepare(
        'UPDATE terminal_assignment SET device_revoked_at = NULL WHERE id = 1',
      ) as RunStmt;
      unrevokeStmt.run();
    },
    adoptApiOrigin(origin: string): void {
      // RT-1348 — only while the origin is still NULL; never replaces one.
      adoptStmt ??= handle.prepare(
        'UPDATE terminal_assignment SET api_origin = ? WHERE id = 1 AND api_origin IS NULL',
      ) as RunStmt;
      adoptStmt.run(origin);
    },
    transaction<T>(fn: () => T): T {
      // better-sqlite3's transaction() returns a wrapped callable.
      const wrapped = handle.transaction(fn as never) as unknown as () => T;
      return wrapped();
    },
  };
}
