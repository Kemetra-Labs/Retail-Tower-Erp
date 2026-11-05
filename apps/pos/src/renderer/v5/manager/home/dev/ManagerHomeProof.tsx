import { StrictMode, type JSX } from 'react';
import type { Root } from 'react-dom/client';

import type { ListStuckShiftsResponse } from '../../../../../shared/bridge-api';
import { OneFrameProof, readOneFrameProofParams } from '../../../frame/dev/OneFrameProof';
import { makeRecoveryProofBridges } from '../../../recovery/dev/RecoveryProof';

/**
 * RT-1193 — DEV-ONLY manager home harness (`#/dev/manager-home-proof`): the real
 * AppRouter at `/app/dashboard` against in-memory reads, so the tile counts can
 * be captured at 1024 and 1280 without a backend. Layout and presentation only.
 *
 * Query (after the hash): `held` = none | held | stuck (what `listHeld` answers;
 * default none); `shifts` = none | some | pending (what `listStuckShifts` answers;
 * default none). `main.tsx` mounts it only under `import.meta.env.DEV`.
 */
type HeldView = 'none' | 'held' | 'stuck';
type ShiftsView = 'none' | 'some' | 'pending';

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback;
}

function shiftsAnswer(view: ShiftsView): Promise<ListStuckShiftsResponse> {
  if (view === 'pending') return new Promise(() => undefined);
  const count = view === 'some' ? 2 : 0;
  return Promise.resolve({
    kind: 'stuck_shifts',
    shifts: Array.from({ length: count }, (_, i) => ({
      shift_id: `proof-shift-${String(i)}`,
      cashier_display_name: 'أحمد سمير',
      terminal_label: 'POS-01',
      opened_at: '2026-10-15T06:00:00Z',
      duration_minutes: 190,
    })),
  });
}

export function ManagerHomeProof(): JSX.Element {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const held = oneOf<HeldView>(query.get('held'), ['none', 'held', 'stuck'], 'none');
  const shifts = oneOf<ShiftsView>(query.get('shifts'), ['none', 'some', 'pending'], 'none');
  const bridges = makeRecoveryProofBridges({
    view: held === 'none' ? 'empty' : 'typical',
    approver: 'ok',
    approval: 'ok',
  });
  const recovery = {
    ...bridges.recovery,
    // `held` = four held sales and no stuck payment; `stuck` keeps the seeded one.
    listHeld: () =>
      bridges.recovery
        .listHeld()
        .then((answer) =>
          held === 'held' && answer.kind === 'held' ? { ...answer, stuck: null } : answer,
        ),
  };
  return (
    <OneFrameProof
      params={{ ...readOneFrameProofParams(), path: '/app/dashboard', role: 'manager' }}
      extraApi={{
        recovery,
        approval: bridges.approval,
        operator: { listStuckShifts: () => shiftsAnswer(shifts) },
      }}
    />
  );
}

/** `main.tsx` hands over its root, so the DEV branch stays a single call. */
export function mountManagerHomeProof(root: Root): void {
  root.render(
    <StrictMode>
      <ManagerHomeProof />
    </StrictMode>,
  );
}
