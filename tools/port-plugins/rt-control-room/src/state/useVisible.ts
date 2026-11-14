import { useEffect, useState } from "react";

/**
 * True while the document is visible AND the tile is on screen. Polling and
 * animation stop when this is false. Inside Port's iframe the implicit
 * IntersectionObserver root is the top-level viewport, so observing the
 * document element catches a tile scrolled out of view. Without
 * IntersectionObserver the tile counts as on screen.
 */
export function useVisible(): boolean {
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [inView, setInView] = useState(true);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setInView(latest.isIntersecting);
    });
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);

  return pageVisible && inView;
}
