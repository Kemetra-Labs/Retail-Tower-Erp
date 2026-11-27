import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * RT-117 / RT-1095 — the keyboard rules every lock screen shares (moved out of
 * `LockScreen.tsx` for RT-309 D9, which adds the authority-conflict variant):
 *
 *  - while locked, no key may reach the sale behind the lock: `inert` stops
 *    focus and clicks, but not document/window key listeners (Dialog Escape,
 *    receipt shortcuts…). Keys aimed outside the lock are swallowed in the
 *    capture phase, before any other listener sees them;
 *  - the PinPad hears the hardware keys on the Dialog panel: the portal host
 *    stops key events at the lock's own `onKeyDown`, so neither the root nor
 *    `window` sees them, and the focusable panel must be the listener.
 *
 * Returns the lock root's ref and the panel ref for the PinPad's `keyTarget`.
 */
export function useLockKeyShield(): {
  rootRef: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLElement | null>;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    panelRef.current = rootRef.current?.querySelector<HTMLElement>('.v5-dialog') ?? null;
  }, []);
  useEffect(() => {
    const swallowOutside = (e: KeyboardEvent): void => {
      const target = e.target as Node | null;
      if (target !== null && rootRef.current?.contains(target) === true) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', swallowOutside, { capture: true });
    return () => {
      window.removeEventListener('keydown', swallowOutside, { capture: true });
    };
  }, []);
  return { rootRef, panelRef };
}
