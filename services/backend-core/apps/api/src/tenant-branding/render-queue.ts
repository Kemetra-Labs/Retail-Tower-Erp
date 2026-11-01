/**
 * A per-process bound on the logo renderers (RT-473 S2 SVG child, RT-1041
 * logo worker): one job runs at a time and at most `maxPending` run or wait.
 * One more is refused at once with `RenderQueueFullError`, a capacity refusal
 * (not a validation one) that the controller answers with the contract's
 * retryable `429 rate_limited`. So the wait any other tenant sees is bounded,
 * and so is the memory of the jobs in flight.
 */

/** The renderer is at capacity: retry later. Not a refusal of the file. */
export class RenderQueueFullError extends Error {
  constructor() {
    super("render queue full");
    this.name = "RenderQueueFullError";
  }
}

export interface RenderQueue {
  /** Runs `work` after every earlier job has settled (one at a time); refuses past the pending cap. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function renderQueue(maxPending: number): RenderQueue {
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (pending >= maxPending) return Promise.reject(new RenderQueueFullError());
      pending += 1;
      const run = queue.then(work, work).finally(() => {
        pending -= 1;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
