import { useEffect, useState, type RefObject } from "react";

/** Below this tile width the diagram text is too small to read (spec section 10): the table takes its place. */
export const NARROW_PX = 900;

/**
 * True when the element is narrower than `limit` px. It watches the element's
 * own width (ResizeObserver) so a narrow Port tile in a wide window counts;
 * without it, the window media query. Without either (jsdom) it reports false:
 * "wide", so the diagram stays the default and nothing is hidden by accident.
 */
export function useNarrow(ref: RefObject<Element | null>, limit: number = NARROW_PX): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && typeof ResizeObserver === "function") {
      const observer = new ResizeObserver((entries) => {
        const width = entries[entries.length - 1]?.contentRect.width;
        // A zero width means "not laid out yet" (a hidden tab), not "narrow".
        if (typeof width === "number" && width > 0) setNarrow(width < limit);
      });
      observer.observe(el);
      return () => observer.disconnect();
    }
    if (typeof window.matchMedia === "function") {
      const query = window.matchMedia(`(max-width: ${limit - 1}px)`);
      const update = () => setNarrow(query.matches);
      update();
      query.addEventListener?.("change", update);
      return () => query.removeEventListener?.("change", update);
    }
    return undefined;
  }, [ref, limit]);
  return narrow;
}
