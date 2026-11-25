/**
 * RT-1598 — collects reviewer warnings deterministically: row-level notes are counted per (code, store), so a
 * 20,000-row tenant gives a short list, and the list is sorted whatever the input order.
 */
import { compareIds } from '../quantity';
import type { RedistributionWarningCodeV1, RedistributionWarningV1 } from '../types';

export class WarningTally {
  private readonly notes = new Map<string, RedistributionWarningV1>();
  private readonly counts = new Map<string, { code: RedistributionWarningCodeV1; storeId: string; count: number }>();

  /** A one-off note, kept once per (code, store, product). */
  note(w: RedistributionWarningV1): void {
    this.notes.set(`${w.code}\u0000${w.storeId ?? ''}\u0000${w.productId ?? ''}`, w);
  }

  /** One more row of `code` at `storeId`. */
  count(code: RedistributionWarningCodeV1, storeId: string): void {
    const key = `${code}\u0000${storeId}`;
    const entry = this.counts.get(key) ?? { code, storeId, count: 0 };
    entry.count += 1;
    this.counts.set(key, entry);
  }

  list(): RedistributionWarningV1[] {
    const all: RedistributionWarningV1[] = [...this.notes.values(), ...[...this.counts.values()].map((c) => ({ ...c }))];
    return all.sort(
      (a, b) =>
        compareIds(a.code, b.code) ||
        compareIds(a.storeId ?? '', b.storeId ?? '') ||
        compareIds(a.productId ?? '', b.productId ?? ''),
    );
  }
}
