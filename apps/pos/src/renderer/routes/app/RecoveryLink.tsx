import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import type { RecoveryListHeldResponse } from '../../../shared/operator/recovery';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { HOME_COPY } from '../../v5/manager/home/home-copy';
import { ManagerTile } from '../../v5/manager/home/ManagerTile';
import { recoveryTileCount, type TileCount } from '../../v5/manager/home/tile-counts';
import { windowRecoveryBridges } from '../../v5/recovery/RecoveryScreen';
import { RECOVERY_COPY } from '../../v5/recovery/recovery-copy';

export const RECOVERY_PATH = '/app/manager/recovery';
const MANAGER_ROLES: ReadonlySet<string> = new Set(['manager', 'admin']);

function useIsManager(): boolean {
  return useOperatorSessionStore(
    (s) => s.state.kind === 'signedIn' && MANAGER_ROLES.has(s.state.session.role),
  );
}

const inRecoveryMode = (answer: RecoveryListHeldResponse): boolean =>
  answer.kind === 'held' && answer.recovery_mode;

/**
 * One `listHeld` read serves two things: a session main admitted in RECOVERY
 * MODE goes straight to the recovery screen, and (RT-1193) the tile's count.
 * A refusal, a failed read or a missing bridge leaves the count `null`.
 */
function useRecoveryRead(enabled: boolean): TileCount | null {
  const navigate = useNavigate();
  const [count, setCount] = useState<TileCount | null>(null);
  useEffect(() => {
    const bridges = enabled ? windowRecoveryBridges() : null;
    if (bridges === null) return;
    let live = true;
    bridges.recovery.listHeld().then(
      (answer) => {
        if (!live) return;
        if (inRecoveryMode(answer)) void navigate(RECOVERY_PATH, { replace: true });
        setCount(recoveryTileCount(answer.kind === 'held' ? answer : null));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled, navigate]);
  return count;
}

/**
 * RT-441 (RT-116 §5) — the manager dashboard's way into
 * `/app/manager/recovery`. A session main admitted in RECOVERY MODE is sent
 * there at once: it can do nothing else until the stuck payment is resolved.
 * Navigation only: nothing for a cashier; the route and main re-check.
 */
export function RecoveryLink(): JSX.Element | null {
  const isManager = useIsManager();
  const count = useRecoveryRead(isManager);
  if (!isManager) return null;
  return (
    <ManagerTile
      to={RECOVERY_PATH}
      icon="held"
      title={RECOVERY_COPY.link}
      description={HOME_COPY.recovery.description}
      testId="dashboard-recovery-link"
      count={count}
    />
  );
}
