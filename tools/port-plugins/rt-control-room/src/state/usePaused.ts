import { useCallback, useState } from "react";

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The Pause motion flag. It starts paused when the viewer asked the system for
 * reduced motion (like the approved mockup); the header button toggles it, and
 * the traces and the diagram read it.
 */
export function usePaused(): [paused: boolean, toggle: () => void] {
  const [paused, setPaused] = useState<boolean>(prefersReducedMotion);
  const toggle = useCallback(() => setPaused((p) => !p), []);
  return [paused, toggle];
}
