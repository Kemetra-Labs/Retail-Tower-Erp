/**
 * RT-962: a routed screen loaded on demand. Each page has its own Suspense
 * boundary with the shared loading state, so a not-yet-loaded route shows
 * «Loading…» inside the shell, then the page. A chunk that fails to load first
 * reloads the page once (RT-1247: a deploy replaced it), then throws to the
 * route's error element (ShellRouteErrorFallback / RouteErrorFallback).
 */
import { ListState } from "@/components/ListState";
import { type ComponentType, Suspense, lazy } from "react";
import { reloadOnceOnChunkError } from "./chunkReload";

// biome-ignore lint/suspicious/noExplicitAny: a page's props are whatever its module exports.
type Page = ComponentType<any>;

export function lazyPage<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  recover: (error: unknown) => Promise<M> = reloadOnceOnChunkError,
): M[K] {
  const Lazy = lazy(() =>
    load()
      .catch(recover)
      .then((module) => ({ default: module[name] as Page })),
  );
  function LazyPage(props: object): React.JSX.Element {
    return (
      <Suspense fallback={<ListState state="loading" />}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return LazyPage as M[K];
}
