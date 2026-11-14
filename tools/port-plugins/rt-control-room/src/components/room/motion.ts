import type { BoardEvent } from "../../state/diff";
import { browserScheduler, type Handle, type Scheduler } from "./gestures";

/** At most this many replayed events animate (the newest ones); older ones are skipped silently. */
export const REPLAY_CAP = 12;
/** Pause between two gestures, so nothing on the board changes faster than every 500 ms. */
export const GAP_MS = 700;
const START_DELAY_MS = 300;

export type PlayItem = { event: BoardEvent; replay: boolean };
/**
 * Starts the gesture of one item. Returns null when the item cannot play (an
 * unlocated event, a vanished alarm): it is skipped at once. `end` is called
 * when the gesture finishes; it is never called after cancel().
 */
export type Player = (item: PlayItem, end: () => void) => Handle | null;

/**
 * Plays events one at a time, in the order given, with a pause between them.
 * Pause (`setStill(true)`) cancels the gesture in flight: that event is
 * consumed, and Resume continues with the next one. Counts the replayed
 * events and calls `onReplayDone` once, after the last was played, skipped
 * or cancelled.
 */
export class MotionRunner {
  private queue: PlayItem[] = [];
  private running: { handle: Handle; item: PlayItem } | null = null;
  private timer: number | null = null;
  private still = true;
  private replayLeft = 0;
  private replayOpen = false;

  constructor(
    private readonly play: Player,
    private readonly onReplayDone: () => void,
    private readonly sched: Scheduler = browserScheduler,
  ) {}

  /** The 24 h replay: oldest first. An empty list (or reduced motion) finishes it at once. */
  startReplay(events: BoardEvent[]): void {
    const items = events.slice(-REPLAY_CAP).map((event) => ({ event, replay: true }));
    this.replayOpen = true;
    this.replayLeft += items.length;
    this.queue.push(...items);
    if (this.replayLeft === 0) this.fireDone();
    else this.kick(START_DELAY_MS);
  }

  /** Changes seen between two polls: oldest first. */
  enqueueLive(events: BoardEvent[]): void {
    this.queue.push(...events.slice(-REPLAY_CAP).map((event) => ({ event, replay: false })));
    this.kick(START_DELAY_MS);
  }

  setStill(still: boolean): void {
    if (this.still === still) return;
    this.still = still;
    if (still) {
      this.clearTimer();
      const run = this.running;
      this.running = null;
      if (run) {
        run.handle.cancel();
        this.account(run.item);
      }
    } else {
      this.kick(START_DELAY_MS);
    }
  }

  private fireDone(): void {
    if (!this.replayOpen) return;
    this.replayOpen = false;
    this.onReplayDone();
  }

  private account(item: PlayItem): void {
    if (!item.replay) return;
    this.replayLeft -= 1;
    if (this.replayLeft <= 0) this.fireDone();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.sched.clearTimeout(this.timer);
    this.timer = null;
  }

  private kick(delay: number): void {
    if (this.still || this.running || this.timer !== null || this.queue.length === 0) return;
    this.timer = this.sched.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delay);
  }

  private pump(): void {
    while (!this.still && !this.running) {
      const item = this.queue.shift();
      if (!item) return;
      let ended = false;
      const handle = this.play(item, () => {
        ended = true;
        if (this.running?.item === item) this.running = null;
        this.account(item);
        this.kick(GAP_MS);
      });
      if (handle === null) {
        // Cannot play: skipped without a pause.
        this.account(item);
        continue;
      }
      if (!ended) this.running = { handle, item };
      return;
    }
  }
}
