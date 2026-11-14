import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Selection } from "./selection";

export type FocusReturnOptions = {
  /** Is this element inside the open detail? Opening from inside a detail keeps the first opener. Default: `[data-detail]`. */
  inDetail?: (el: Element) => boolean;
  /** Where focus goes when the opener is gone or hidden: the active tab button. Never `body`. */
  fallback?: () => HTMLElement | null;
};

export type FocusReturn = {
  /**
   * Remember the element that opens (or changes) the detail. Call it
   * synchronously in the handler, BEFORE the selection state changes. Stores a
   * `data-focus` key, not the node, so a re-rendered replacement is found again.
   * A click on something that cannot take focus leaves `body` active and clears
   * the stored key (no stale restoration).
   */
  capture(): void;
  /** Focus the opener (visible), else the pin with the same alarm id, else the fallback. Clears the key. */
  restore(): void;
};

const escapeAttr = (value: string): string => value.split("\\").join("\\\\").split('"').join('\\"');
const visible = (n: Element): boolean => n.getClientRects().length > 0;

function firstVisible(selector: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  return nodes.find(visible) ?? null;
}

const keyOf = (el: Element | null): string | null =>
  el?.closest?.("[data-focus]")?.getAttribute("data-focus") ?? null;

/** Focus management for the detail panel. The detail panel (Task 10) reuses it through `useSelection`. */
export function useFocusReturn(options: FocusReturnOptions = {}): FocusReturn {
  const opts = useRef(options);
  opts.current = options;
  const trigger = useRef<string | null>(null);

  const capture = useCallback(() => {
    const active = document.activeElement;
    const inDetail = opts.current.inDetail ?? ((el: Element) => el.closest("[data-detail]") !== null);
    if (active && active !== document.body && inDetail(active)) return;
    trigger.current = keyOf(active);
  }, []);

  const restore = useCallback(() => {
    const key = trigger.current;
    trigger.current = null;
    const keys = key === null ? [] : [key];
    // The list button of an alarm may sit in a hidden tab: its pin on the map is always there.
    if (key?.startsWith("alarm:")) keys.push(`pin:${key.slice("alarm:".length)}`);
    let target: HTMLElement | null = null;
    for (const k of keys) {
      target = firstVisible(`[data-focus="${escapeAttr(k)}"]`);
      if (target) break;
    }
    target ??= opts.current.fallback?.() ?? null;
    // Last resort so focus never lands on the page body: the first station on the map.
    target ??= firstVisible('[data-focus^="station:"]');
    target?.focus();
  }, []);

  return { capture, restore };
}

export type UseSelection = {
  selection: Selection;
  /** `byKey` is true when the keyboard did it: the detail takes focus on open, the opener on close. */
  select(sel: Selection, byKey?: boolean): void;
  clear(byKey?: boolean): void;
};

/**
 * Selection state with the focus rules: Escape closes an open detail and
 * returns focus. Own it in `App`; pass `select` to the map and the panels.
 */
export function useSelection(options: FocusReturnOptions = {}): UseSelection {
  const [selection, setSelection] = useState<Selection>(null);
  const focus = useFocusReturn(options);
  const restoreNext = useRef(false);
  const open = useRef(false);
  open.current = selection !== null;

  const select = useCallback(
    (sel: Selection, byKey = false) => {
      if (sel) focus.capture();
      // A keyboard close wins over a mouse click that bubbles up from the same press.
      else restoreNext.current ||= byKey && open.current;
      setSelection(sel);
    },
    [focus],
  );

  // After the detail is gone from the DOM, so a hidden opener is not mistaken for a visible one.
  useLayoutEffect(() => {
    if (selection === null && restoreNext.current) {
      restoreNext.current = false;
      focus.restore();
    }
  }, [selection, focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !open.current) return;
      // Mark the key as used, so a listener that comes after (the Story tour) leaves it alone: one Escape, one thing.
      e.preventDefault();
      select(null, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [select]);

  const clear = useCallback((byKey = false) => select(null, byKey), [select]);
  return { selection, select, clear };
}
