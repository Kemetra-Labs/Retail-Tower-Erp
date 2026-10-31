/**
 * RT-1012 (D-V9): the band facts of the store list. `GET /api/v1/stores`
 * returns the tenant's COMPLETE roster (no cursor, limit or cap), so counting
 * it is a whole-set figure, not "loaded so far". A store with no `is_active`
 * flag reads as active, exactly as `StoreStateBadge` shows it, so the three
 * numbers and the badges on the rows always agree.
 */
export interface StoreCounts {
  total: number;
  active: number;
  suspended: number;
}

export function storeCounts(rows: readonly { is_active?: boolean }[]): StoreCounts {
  const suspended = rows.filter((s) => s.is_active === false).length;
  return { total: rows.length, active: rows.length - suspended, suspended };
}
