import type { AvailabilityFreshness, AvailabilityRowState } from '../../shared/availability/types';
import { formatHumanDateTime } from '../ui/format/human-format';

/**
 * RT-1578 (RT-1511 S3, spec 013) — the Arabic copy and tones of the availability badges and status line,
 * exactly as the owner approved them (RT-1578 comment 18614, 2026-11-24). The text carries the meaning,
 * never colour alone. Display only: nothing here can gate a sale (FR-5).
 */

type AvailabilityTone = 'neutral' | 'warning' | 'warning-strong';

export interface AvailabilityBadgeView {
  readonly text: string;
  readonly tone: AvailabilityTone;
}

const BADGES: Readonly<Record<AvailabilityRowState, AvailabilityBadgeView>> = {
  in_stock: { text: 'متوفر', tone: 'neutral' },
  low: { text: 'كمية قليلة', tone: 'warning' },
  out: { text: 'غير متوفر', tone: 'warning-strong' },
  unknown: { text: 'التوفر غير معروف', tone: 'neutral' },
  uncertain: { text: 'التوفر غير مؤكد', tone: 'neutral' },
};

export function availabilityBadge(state: AvailabilityRowState): AvailabilityBadgeView {
  return BADGES[state];
}

export const AVAILABILITY_REFRESH_LABEL = 'تحديث التوفر';
const AVAILABILITY_REFRESHING_COPY = 'جارٍ تحديث التوفر…';

/** Absolute Arabic timestamp, the same format as the catalogue «آخر تحديث» (Western digits, 24-hour). */
function stampOf(iso: string): string {
  return formatHumanDateTime(iso, { withYear: true, month: 'long' }) ?? iso;
}

export interface AvailabilityStatusView {
  readonly text: string;
  readonly tone: 'neutral' | 'warning';
}

/**
 * The status-line text: persistent for the never-downloaded and stale states, a transient one while a
 * refresh runs, and nothing while the data is fresh (or not read yet). A refresh in progress keeps the
 * last badges and only changes this line.
 */
export function availabilityStatus(
  freshness: AvailabilityFreshness | null,
  refreshing: boolean,
): AvailabilityStatusView | null {
  if (refreshing) return { text: AVAILABILITY_REFRESHING_COPY, tone: 'neutral' };
  if (freshness === null || freshness.state === 'fresh') return null;
  if (freshness.state === 'never') return { text: 'لم يُنزّل التوفر بعد', tone: 'warning' };
  const stamp = freshness.as_of === null ? '' : stampOf(freshness.as_of);
  return { text: `بيانات التوفر قديمة · آخر تحديث: ${stamp}`, tone: 'warning' };
}
