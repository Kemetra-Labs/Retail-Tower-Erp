/**
 * RT-1207: the one home for the argument guards the IPC handlers share.
 *
 * Each helper below is the exact body that was copy-pasted into the handler
 * modules; nothing here is a new rule. Variants that differ in behaviour keep
 * separate names (`isPlainObject` rejects arrays, `isObjectLike` accepts them,
 * `UUID_LOWER_RE` is case-sensitive, `UUID_ANYCASE_RE` is not). A handler picks
 * the variant it already had, so accept/reject behaviour per channel is unchanged.
 */
import type { Logger } from 'pino';

/** A non-null object that is not an array. Class instances, Dates, Maps and the like still pass. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-null object, arrays included. The looser variant some handlers rely on. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** A plain object (arrays rejected) whose own keys are all in `keys`: nothing smuggled in. */
export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

/** Canonical lower-case UUID shape (no version or variant check). */
export const UUID_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** UUID shape accepting either case (no version or variant check). */
export const UUID_ANYCASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name of a thrown value for a log line; never the message or stack. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The failure path every handler module repeated: log the operation and the error
 * *name* only under `event`, then answer the module's generic refusal.
 * `refusal` is called per failure so each reply is a fresh value unless the module
 * hands back a shared constant.
 */
export function createIpcRunner<R>(
  logger: Pick<Logger, 'warn'>,
  event: string,
  refusal: () => R,
): {
  readonly unavailable: (op: string, error: unknown) => R;
  readonly runIpc: <T>(op: string, fn: () => T | Promise<T>) => Promise<T | R>;
} {
  const unavailable = (op: string, error: unknown): R => {
    logger.warn({ op, error: errorName(error) }, event);
    return refusal();
  };
  const runIpc = async <T>(op: string, fn: () => T | Promise<T>): Promise<T | R> => {
    try {
      return await fn();
    } catch (error) {
      return unavailable(op, error);
    }
  };
  return { unavailable, runIpc };
}
