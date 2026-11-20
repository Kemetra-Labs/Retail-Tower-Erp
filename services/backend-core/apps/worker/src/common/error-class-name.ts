/**
 * The error's class name for logs, never its message: a pg or Redis message
 * can carry row values or a connection string (§VII / §XIV).
 */
export function errorClassName(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  return err.name || "Error";
}

/** Short identifier-like codes only: a SQLSTATE (`40P01`) or a Node code (`ECONNRESET`). */
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/**
 * Loggable error fields: the class name plus, when present, the error's code.
 * pg's `DatabaseError` names every failure "error", so the SQLSTATE in
 * `err.code` is what makes a failure diagnosable. A code carries no row values;
 * anything that is not a short identifier-like string is dropped.
 */
export function errorFields(err: unknown): { errorName: string; errorCode?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code)
    ? { errorName: errorClassName(err), errorCode: code }
    : { errorName: errorClassName(err) };
}
