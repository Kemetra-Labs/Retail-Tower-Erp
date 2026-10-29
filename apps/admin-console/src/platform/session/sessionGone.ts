/**
 * RT-930 (RT-777 as-built P1-2): why the operator just landed on the directory.
 * A renew or end answered 409 `support_session_absent` means the session was
 * already ended or replaced elsewhere. The bar unmounts with its live region
 * on the way out, so the reason is handed to the directory here.
 *
 * Kept in memory on purpose: it outlives the navigation and the context
 * re-read, and nothing else. A reload or a normal visit starts with no reason,
 * and sign-out clears it (useSignOut). The directory clears it on dismiss and
 * when another session starts, and never shows it to another user.
 */
export interface SessionGone {
  action: "renew" | "end";
  /** The operator who lost the session. */
  userId: string;
  /** The lost session; a different session in the context means the operator moved on. */
  sessionId: string;
  tenantId: string;
  /** The tenant's name when the context still carried it at the time. */
  tenantName?: string;
}

let state: SessionGone | null = null;
const listeners = new Set<() => void>();

function publish(next: SessionGone | null): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getSessionGone(): SessionGone | null {
  return state;
}

export function subscribeSessionGone(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSessionGone(reason: SessionGone): void {
  publish(reason);
}

export function clearSessionGone(): void {
  if (state !== null) publish(null);
}

/** Test seam: forget any reason. */
export function resetSessionGone(): void {
  publish(null);
}
