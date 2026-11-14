/** What the viewer picked on the map: a station, an alarm (by alarm id) or a server. */
export type Selection = { type: "station" | "alarm" | "host"; id: string } | null;

/** `data-focus` key of the element that opens a selection (stations, pins and servers carry it). */
export const focusKey = (sel: NonNullable<Selection>): string =>
  `${sel.type === "alarm" ? "pin" : sel.type}:${sel.id}`;
