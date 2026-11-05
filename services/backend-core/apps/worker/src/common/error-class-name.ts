/**
 * The error's class name for logs, never its message: a pg or Redis message
 * can carry row values or a connection string (§VII / §XIV).
 */
export function errorClassName(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  return err.name || "Error";
}
