import { afterEach, describe, expect, it, vi } from 'vitest';

import { installViewport, resizeTo, viewportSubscribed } from './__helpers__/viewport-bands';

/**
 * RT-1501 — the matchMedia stand-in only notifies listeners that are already
 * subscribed, like a real MediaQueryList. The tier hook subscribes in an
 * effect, which React can flush a tick after the route's DOM appears when the
 * route mounts from an awaited read (outside `act`). A `resizeTo` in that gap
 * reaches nobody and the hook never updates. `viewportSubscribed` is how a
 * test waits for the subscription instead of racing it.
 */

/** The four queries `useViewportTier` subscribes to, in one effect. */
const TIER_QUERIES = [
  '(min-width: 1280px)',
  '(min-width: 1024px)',
  '(min-height: 768px)',
  '(min-height: 600px)',
] as const;

function subscribeAll(onChange: () => void): void {
  for (const query of TIER_QUERIES) {
    window.matchMedia(query).addEventListener('change', onChange);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viewportSubscribed', () => {
  it('resolves only once the tier queries have a listener', async () => {
    installViewport(1280, 800);
    let resolved = false;
    const waiting = viewportSubscribed().then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);

    subscribeAll(() => {});
    await waiting;
    expect(resolved).toBe(true);
  });

  it('lets a resize after a late subscription reach the listener', async () => {
    installViewport(1280, 800);
    const onChange = vi.fn();
    setTimeout(() => {
      subscribeAll(onChange);
    }, 25);

    await viewportSubscribed();
    resizeTo(1280, 599);

    // 800 -> 599 flips both height queries (768 and 600), so the shared listener fires for each.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('rejects with a clear message when nothing ever subscribes', async () => {
    installViewport(1280, 800);

    await expect(viewportSubscribed(20)).rejects.toThrow(/no viewport subscriber/i);
  });

  it('does not count a subscription to only some of the queries', async () => {
    installViewport(1280, 800);
    window.matchMedia('(min-height: 600px)').addEventListener('change', () => {});

    await expect(viewportSubscribed(20)).rejects.toThrow(/no viewport subscriber/i);
  });

  it('does not count a listener that has already unsubscribed', async () => {
    installViewport(1280, 800);
    const onChange = () => {};
    subscribeAll(onChange);
    for (const query of TIER_QUERIES) {
      window.matchMedia(query).removeEventListener('change', onChange);
    }

    await expect(viewportSubscribed(20)).rejects.toThrow(/no viewport subscriber/i);
  });
});
