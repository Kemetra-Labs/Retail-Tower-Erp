import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';

import type { ResolveConflictRequest, ResolveConflictResponse } from '../../shared/bridge-api';
import type { RefusalCategory } from '../../shared/audit/event-shape';
import { PinPad } from '../ui/operator/PinPad';
import { SIGN_IN_REFUSAL_COPY } from '../ui/operator/messages';
import { LockPinFeedback, LockShell } from './lock-parts';
import { LOCK_PIN_FORMAT_ERROR, LOCK_PIN_HINT, LOCK_TITLE, PIN_FORMAT } from './LockScreen';
import { useLockKeyShield } from './use-lock-key-shield';
import '../v5/entry/entry.css';
import '../v5/sale/live-sale.css';
import './lock-screen.css';

/**
 * RT-309 D9 (RT-113 10763 D9; owner approval RT-309 c19114) — the
 * authority-conflict variant of the lock screen.
 *
 * The offline reconcile found this cashier admitted on another till, so main
 * locked the session (`lock_cause: 'authority_conflict'`). Like every lock it
 * shows nothing of the sale (L3, RT-161): no lines, no count, no amount, no
 * summary, no name. It offers the same cashier exactly two actions, each after
 * the PIN: «استلام هنا» (the PinPad's commit, and a physical Enter) and
 * «إنهاء هنا». There is no «دخول موظف آخر» and no plain unlock. Esc clears the
 * entry and never dismisses the lock. A PIN that is not 4–6 digits never
 * reaches main (RT-24 I-4).
 *
 * Copy: the message, the two actions and the takeover rate-limit line are the
 * owner-approved D9 copy (c19114), byte for byte. Every other line is existing
 * copy with the same meaning here: the lock title, PIN hint and PIN format line
 * (`LockScreen.tsx`), and the sign-in refusal family (`messages.ts`, the same
 * family the cashier takeover prompt shows). See the D9 visual acceptance spec.
 */

/** Owner-approved D9 copy (RT-309 c19114). Do not edit without a new owner decision. */
const CONFLICT_LOCK_COPY = Object.freeze({
  message: 'أنت مسجّل الدخول على جهاز آخر. البيع الحالي محفوظ.',
  takeOverHere: 'استلام هنا',
  endHere: 'إنهاء هنا',
  takeoverRateLimited: 'حاولت كثيراً، انتظر قليلاً ثم أعد المحاولة',
});

interface ConflictLockScreenProps {
  /** Absent on a bridge without it: every action then fails closed (generic refusal). */
  resolve: ((req: ResolveConflictRequest) => Promise<ResolveConflictResponse>) | undefined;
  /** The session was taken over here and unlocked. */
  onResolved: () => void;
}

/** Existing refusal copy for each category this screen can receive. */
function refusalMessage(category: RefusalCategory): string {
  switch (category) {
    case 'invalid_input':
    case 'rate_limited':
    case 'no_connection':
    case 'clock_skew':
      return SIGN_IN_REFUSAL_COPY[category];
    default:
      return SIGN_IN_REFUSAL_COPY.state_invalid;
  }
}

function responseMessage(res: ResolveConflictResponse): string | null {
  if (res.kind === 'resolved') return null;
  if (res.kind === 'takeover_rate_limited') return CONFLICT_LOCK_COPY.takeoverRateLimited;
  return refusalMessage(res.category);
}

export function ConflictLockScreen({
  resolve,
  onResolved,
}: Readonly<ConflictLockScreenProps>): JSX.Element {
  const descId = useId();
  const errId = useId();
  const dotsRef = useRef<HTMLDivElement>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { rootRef, panelRef } = useLockKeyShield();

  useEffect(() => {
    dotsRef.current?.focus();
  }, []);

  const cancelEntry = (): void => {
    setPin('');
    setError(null);
    dotsRef.current?.focus();
  };
  const onLockKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    cancelEntry();
  };

  const act = async (action: ResolveConflictRequest['action']): Promise<void> => {
    if (busy) return;
    if (!PIN_FORMAT.test(pin)) {
      setPin('');
      setError(LOCK_PIN_FORMAT_ERROR);
      dotsRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res =
        resolve === undefined
          ? ({ kind: 'refused', category: 'state_invalid' } as const)
          : await resolve({ action, pin });
      if (res.kind === 'resolved' && action === 'take_over_here') onResolved();
      setError(responseMessage(res));
    } catch {
      setError(refusalMessage('state_invalid'));
    } finally {
      // Never keep a secret in component state after an attempt.
      setPin('');
      setBusy(false);
      dotsRef.current?.focus();
    }
  };

  return (
    <LockShell
      rootRef={rootRef}
      onKeyDown={onLockKeyDown}
      title={LOCK_TITLE}
      describedBy={descId}
      onCancel={cancelEntry}
      initialFocusRef={dotsRef}
      lockCause="authority_conflict"
    >
      <p id={descId} className="session-lock__prompt">
        {CONFLICT_LOCK_COPY.message}
      </p>
      <div className="session-lock__form">
        <PinPad
          value={pin}
          onChange={setPin}
          onSubmit={() => {
            void act('take_over_here');
          }}
          disabled={busy}
          error={error !== null}
          {...(error !== null ? { describedBy: errId } : {})}
          submitLabel={CONFLICT_LOCK_COPY.takeOverHere}
          keyTarget={panelRef}
          dotsRef={dotsRef}
          feedback={<LockPinFeedback error={error} errId={errId} hint={LOCK_PIN_HINT} />}
        />
        <div>
          <button
            type="button"
            className="v5-live-btn v5-btn"
            disabled={busy}
            aria-busy={busy ? 'true' : undefined}
            onClick={() => {
              void act('end_here');
            }}
          >
            {CONFLICT_LOCK_COPY.endHere}
          </button>
        </div>
      </div>
    </LockShell>
  );
}
