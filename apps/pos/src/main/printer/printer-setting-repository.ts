/**
 * RT-886 (RT-839 S1) — the terminal's receipt printer choice (migration 0057).
 *
 * One row at most. No row means no printer was chosen yet. The row is written
 * with an UPSERT on its fixed key, so a save replaces the choice in place, and
 * it lives outside the pairing row, so a re-pair keeps it.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { PrinterChoice } from '../../shared/printer/types.js';

export interface PrinterSettingRepository {
  /** The current choice, or null when none was ever saved. */
  get(): PrinterChoice | null;
  /** Save the choice (replaces any earlier one). */
  set(choice: PrinterChoice, meta: { updatedAt: string; operatorId: string }): void;
}

interface Row {
  printer_source: string;
  printer_name: string | null;
}

type Get<T> = { get(...params: unknown[]): T | undefined };
type Run = { run(...params: unknown[]): unknown };

/** A stored row as a choice. A row that does not hold a valid choice reads as none. */
export function rowToChoice(row: Row | undefined): PrinterChoice | null {
  if (row === undefined) return null;
  if (row.printer_source === 'os_default') return { source: 'os_default' };
  if (row.printer_source === 'chosen' && typeof row.printer_name === 'string') {
    return { source: 'chosen', printer_name: row.printer_name };
  }
  return null;
}

export function bindPrinterSettingRepository(db: DatabaseHandle): PrinterSettingRepository {
  const readStmt = db.prepare(
    `SELECT printer_source, printer_name FROM terminal_printer_setting WHERE id = 1`,
  ) as Get<Row>;
  const upsertStmt = db.prepare(
    `INSERT INTO terminal_printer_setting
       (id, printer_source, printer_name, updated_at, updated_by_operator_id)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       printer_source = excluded.printer_source,
       printer_name = excluded.printer_name,
       updated_at = excluded.updated_at,
       updated_by_operator_id = excluded.updated_by_operator_id`,
  ) as Run;

  return {
    get(): PrinterChoice | null {
      return rowToChoice(readStmt.get());
    },
    set(choice, meta): void {
      upsertStmt.run(
        choice.source,
        choice.source === 'chosen' ? choice.printer_name : null,
        meta.updatedAt,
        meta.operatorId,
      );
    },
  };
}
