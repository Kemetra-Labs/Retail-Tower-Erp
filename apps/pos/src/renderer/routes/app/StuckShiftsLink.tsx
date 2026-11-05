import type { JSX } from 'react';

import type { OperatorBridgeAPI } from '../../../shared/bridge-api';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { HOME_COPY } from '../../v5/manager/home/home-copy';
import { ManagerTile } from '../../v5/manager/home/ManagerTile';
import {
  stuckShiftsTileCount,
  useTileCount,
  type TileCountRead,
} from '../../v5/manager/home/tile-counts';

export const STUCK_SHIFTS_PATH = '/app/manager/stuck-shifts';
const MANAGER_ROLES: ReadonlySet<string> = new Set(['manager', 'admin']);

/** RT-1193: the count reads `operator.listStuckShifts()` and nothing else. */
const readStuckShifts: TileCountRead = () => {
  const operator = (window as unknown as { api?: { operator?: Partial<OperatorBridgeAPI> } }).api
    ?.operator;
  return typeof operator?.listStuckShifts === 'function'
    ? operator.listStuckShifts().then(stuckShiftsTileCount)
    : null;
};

/**
 * RT-499 (D-10-2) — the manager home's way into `/app/manager/stuck-shifts`,
 * which nothing linked to before. Navigation only: it renders nothing for a
 * cashier or a signed-out terminal; the route guard and main re-check the role.
 */
export function StuckShiftsLink(): JSX.Element | null {
  const isManager = useOperatorSessionStore(
    (s) => s.state.kind === 'signedIn' && MANAGER_ROLES.has(s.state.session.role),
  );
  const count = useTileCount(isManager, readStuckShifts);
  if (!isManager) return null;
  return (
    <ManagerTile
      to={STUCK_SHIFTS_PATH}
      icon="stuckShift"
      title={HOME_COPY.stuckShifts.title}
      description={HOME_COPY.stuckShifts.description}
      testId="dashboard-stuck-shifts-link"
      count={count}
    />
  );
}
