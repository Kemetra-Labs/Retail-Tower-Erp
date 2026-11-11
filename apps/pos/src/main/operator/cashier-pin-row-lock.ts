/**
 * RT-1326 (RT-1125 R-17) — one writer at a time per cashier PIN row.
 *
 * A PIN attempt reads `cashier_pin_records`, awaits Argon2, then writes the
 * failure count it computed from that read. Run concurrently, every attempt
 * would read the same count, and a write could undo another's. Every
 * read-modify-write of a row goes through this lock: cashier sign-in, the
 * same-operator unlock, the manager PIN reset and the manager unlock.
 *
 * Main-process only and in memory: the till has one main process and one
 * SQLite connection, so a process-wide queue per row is the whole guard.
 */
import type { PinScope } from './pin-lockout.js';

const queues = new Map<string, Promise<void>>();

function keyOf(scope: PinScope): string {
  return JSON.stringify([
    scope.tenant_id,
    scope.branch_id,
    scope.terminal_id,
    scope.cashier_clerk_user_id,
  ]);
}

/** Runs `task` after every earlier task on the same row has settled. */
export function withCashierPinRowLock<T>(scope: PinScope, task: () => Promise<T>): Promise<T> {
  const key = keyOf(scope);
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
