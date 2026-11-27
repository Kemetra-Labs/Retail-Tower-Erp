import type { JSX, KeyboardEvent, ReactNode, RefObject } from 'react';

import { Icon } from '../icons/Icon';
import { BrandSlot, PoweredBy } from '../branding/BrandSlot';
import { useBranding } from '../branding/branding-store';
import { Dialog, DialogHost } from '../v5/foundation/Dialog';
import { EntryBand } from '../v5/entry/EntryBand';

/**
 * RT-309 D9 — the parts every lock screen draws the same way, shared by the
 * inactivity lock (`LockScreen.tsx`) and the authority-conflict lock
 * (`ConflictLockScreen.tsx`): the opaque lock root with the Ink band, the one
 * V5 Dialog in its own host, the tenant logo and the lock head (RT-593,
 * RT-475, RT-1095), and the PinPad's reserved feedback slot (the hint, or the
 * refusal in its place).
 */

/** Never dismissible: `onCancel` (Esc) only clears the entry in progress. */
export function LockShell({
  rootRef,
  onKeyDown,
  title,
  titleId,
  describedBy,
  onCancel,
  initialFocusRef,
  lockCause,
  children,
}: Readonly<{
  rootRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  title: string;
  titleId?: string;
  describedBy: string;
  onCancel: () => void;
  initialFocusRef: RefObject<HTMLElement | null>;
  lockCause?: string;
  children: ReactNode;
}>): JSX.Element {
  // RT-475 (RT-832 lock): the tenant logo above the lock head, from the local cache.
  const branding = useBranding();
  return (
    <div
      ref={rootRef}
      className="session-lock"
      data-entry-surface=""
      data-lock-cause={lockCause}
      onKeyDown={onKeyDown}
    >
      <EntryBand />
      <DialogHost>
        <Dialog
          label={title}
          describedBy={describedBy}
          onCancel={onCancel}
          initialFocusRef={initialFocusRef}
          restoreFocus={false}
        >
          <BrandSlot slot="lock" snapshot={branding} />
          <div className="session-lock__head">
            <span className="session-lock__mark" aria-hidden="true">
              <Icon name="lock" size="lg" />
            </span>
            <h2 id={titleId} className="v5-live-dialog-title session-lock__title">
              {title}
            </h2>
          </div>
          {children}
          <PoweredBy snapshot={branding} className="session-lock__powered-by" />
        </Dialog>
      </DialogHost>
    </div>
  );
}

export function LockPinFeedback({
  error,
  errId,
  hint,
}: Readonly<{ error: string | null; errId: string; hint: string }>): JSX.Element {
  return error !== null ? (
    <p id={errId} role="alert" className="session-lock__error">
      <Icon name="status.danger" />
      <span>{error}</span>
    </p>
  ) : (
    <p className="v5-entry__status">{hint}</p>
  );
}
