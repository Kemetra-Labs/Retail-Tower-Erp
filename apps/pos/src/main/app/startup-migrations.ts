import { SchemaAheadError, runMigrations } from '../db/migrate.js';
import type { MigrationFile, MigrationsDb } from '../db/migrate.js';
import { backupsDirFor, writePreMigrationSnapshot } from '../db/pre-migration-snapshot.js';
import { describeSchemaAheadRefusal } from './schema-ahead-refusal.js';
import { classifyStartupFailure } from './startup-failure.js';
import { describeStartupFailureRefusal } from './startup-failure-refusal.js';
import type { StartupRefusal } from './startup-failure-refusal.js';

/**
 * RT-320 — startup migration seam (ADR-0006 rules 2 and 4).
 *
 * Runs the migration runner with the two roll-forward safeguards wired in:
 *   - a DB ahead of this build becomes a typed refusal the composition root
 *     shows to the operator before exiting (fail closed);
 *   - a DB with pending migrations is snapshotted to `<userData>/backups/`
 *     before the first one applies.
 *
 * RT-1324 (RT-1125 R-39): any other failure (a failing migration, a full disk,
 * a failed snapshot) is also returned as a refusal, classed `disk_full` or
 * `database_migration` and naming the backups folder, instead of being
 * rethrown into the fatal-startup path. The composition root shows every
 * refusal the same way (`showRefusalAndExit`). Nothing is restored or reset.
 */

export interface StartupMigrationsLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface StartupMigrationsDeps {
  db: MigrationsDb;
  files: MigrationFile[];
  vacuumInto: (targetPath: string) => void;
  userDataDir: string;
  now: () => Date;
  logger: StartupMigrationsLogger;
}

export type StartupMigrationsResult = { ok: true } | { ok: false; refusal: StartupRefusal };

export function runStartupMigrations(deps: StartupMigrationsDeps): StartupMigrationsResult {
  const { db, files, vacuumInto, userDataDir, now, logger } = deps;
  const backupsDir = backupsDirFor(userDataDir);
  try {
    runMigrations({
      db,
      files,
      onBeforeApply: (pending) => {
        const snapshot = writePreMigrationSnapshot({
          backupsDir,
          // `pending` is name-sorted and never empty here (the runner only calls
          // this hook when something is pending), so its last entry is the
          // upgrade's target.
          targetHead: pending.slice(-1).join(''),
          vacuumInto,
          now,
        });
        logger.info(
          { snapshotPath: snapshot.path, created: snapshot.created, pending },
          'db:pre-migration-snapshot',
        );
      },
    });
  } catch (err) {
    if (err instanceof SchemaAheadError) {
      logger.error({ unknownMigrations: err.unknownMigrations }, 'db:schema_ahead_refused');
      return { ok: false, refusal: describeSchemaAheadRefusal(err.unknownMigrations) };
    }
    const failure = classifyStartupFailure(err, 'database_migration');
    logger.error({ ...failure, err }, 'db:startup_migration_failed');
    return { ok: false, refusal: describeStartupFailureRefusal({ failure, backupsDir }) };
  }
  return { ok: true };
}
