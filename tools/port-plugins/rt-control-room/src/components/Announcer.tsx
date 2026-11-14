import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n/LangContext";
import type { Lang } from "../i18n/strings";
import type { BoardEvent } from "../state/diff";

/** At most one spoken update per this many ms (spec: a quiet region, not a ticker). */
export const ANNOUNCE_GAP_MS = 15_000;

/**
 * Only a new live alarm is read aloud: a new Sentry issue, or a Datadog monitor
 * that went INTO Alert, Warn or No Data. Never a monitor back to OK, a merge, CI
 * run, Jira change or deployment, and never a replay.
 */
const spoken = (e: BoardEvent): boolean =>
  !e.replay && (e.kind === "alarm" || (e.kind === "monitor" && e.alarming === true));

/**
 * The text of the quiet status region. A burst waits for the next window and
 * is read as one update (the newest alarm, with the count); nothing that was
 * on screen when the panel first showed is read aloud.
 */
export function useAlarmAnnouncement(events: BoardEvent[], lang: Lang, t: (key: "announceMany", vars: { n: number; text: string }) => string): string {
  const [message, setMessage] = useState("");
  const seen = useRef<Set<string> | null>(null);
  const queue = useRef<BoardEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ lang, t });
  latest.current = { lang, t };

  const publish = useRef<() => void>(() => {});
  publish.current = () => {
    const batch = queue.current;
    if (batch.length === 0) return;
    queue.current = [];
    const text = batch[batch.length - 1].text[latest.current.lang];
    setMessage(batch.length === 1 ? text : latest.current.t("announceMany", { n: batch.length, text }));
    // Cool down: whatever arrives meanwhile waits for the end of the window.
    timer.current = setTimeout(() => {
      timer.current = null;
      publish.current();
    }, ANNOUNCE_GAP_MS);
  };

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(events.map((e) => e.id));
      return;
    }
    // Newest first in `events`; the queue keeps arrival order (oldest first).
    const fresh = events.filter((e) => !seen.current?.has(e.id));
    fresh.forEach((e) => seen.current?.add(e.id));
    const alarms = fresh.filter(spoken).reverse();
    if (alarms.length === 0) return;
    queue.current.push(...alarms);
    if (timer.current === null) publish.current();
  }, [events]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return message;
}

/** The one quiet `role="status"` region of the board: visually hidden, polite, announces new alarms only. */
export function AlarmAnnouncer({ events }: { events: BoardEvent[] }) {
  const { lang, t } = useLang();
  const message = useAlarmAnnouncement(events, lang, (key, vars) => t(key, vars));
  return (
    <div role="status" className="sr" data-announcer>
      {message}
    </div>
  );
}
