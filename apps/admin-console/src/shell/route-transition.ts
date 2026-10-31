/**
 * RT-978: route transitions seen at the router root, for the page header's
 * focus rule (RT-963). The root records every path change, including routes
 * that render no `PageHeader` (sign-in, gates), so the header can tell
 * «the path changed since the last route» (move focus to the title) from
 * «the same path remounted by a scope change» (leave focus alone).
 *
 * A module, not React state: the page header consumes it from an effect, and
 * the root records it from a layout effect, which React runs for the whole tree
 * before any passive effect of the same commit.
 */

/** The path of the latest route; null before the first one. */
let lastPath: string | null = null;
/** True from a path change until the next page header consumes it. */
let focusPending = false;

/** Records the route now shown. A path different from the last one is a navigation. */
export function recordRoute(path: string): void {
  if (lastPath !== null && path !== lastPath) focusPending = true;
  lastPath = path;
}

/**
 * True once per navigation: the first page header shown after a path change
 * takes it and moves focus to its title. False on the first load and on a
 * remount under the same path.
 */
export function takeNavigationFocus(): boolean {
  const pending = focusPending;
  focusPending = false;
  return pending;
}

/** Forgets every route; the root calls it when it unmounts. */
export function resetRouteTransitions(): void {
  lastPath = null;
  focusPending = false;
}
