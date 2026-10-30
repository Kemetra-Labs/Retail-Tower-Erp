/**
 * Report a caught render error to Sentry (RT-633). A no-op until the SDK is
 * initialised, so it is safe while the Console is inert. The `beforeSend`
 * scrubber still decides what leaves the browser.
 *
 * RT-958: each error object is reported once. A fallback's effect runs twice
 * under StrictMode and again whenever the fallback remounts (a scope change
 * remounts the shell outlet); those repeats return the first reference instead
 * of sending a duplicate event.
 */
import { captureException, getClient } from "@sentry/react";

const reported = new WeakMap<object, string | undefined>();

/**
 * Returns the Sentry event id to show as the error reference, or undefined when
 * no event can have left: `captureException` mints an id even without a client.
 */
export function reportError(error: unknown): string | undefined {
  const key = typeof error === "object" && error !== null ? error : null;
  if (key !== null && reported.has(key)) return reported.get(key);
  let reference: string | undefined;
  try {
    const eventId = captureException(error);
    reference = getClient() === undefined ? undefined : eventId;
  } catch {
    // Telemetry never breaks the fallback screen.
  }
  if (key !== null) reported.set(key, reference);
  return reference;
}
