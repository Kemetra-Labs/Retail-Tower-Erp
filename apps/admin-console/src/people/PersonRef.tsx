/**
 * RT-1070: a user reference with its display name beside the id, never instead
 * of it. `<PeopleNames ids>` resolves one screen's ids in batches and shares the
 * names with every `<PersonRef>` below it; without a provider, or without a
 * resolved name, a `<PersonRef>` renders the id exactly as before (the RT-967
 * fallback). The id stays LTR-isolated machine data (UX-11).
 */
import { createContext, useContext } from "react";
import "./people.css";
import { usePeopleNames } from "./usePeopleNames";

const NamesContext = createContext<ReadonlyMap<string, string>>(new Map());

export function PeopleNames({
  ids,
  children,
}: Readonly<{
  ids: readonly (string | null | undefined)[];
  children: React.ReactNode;
}>): React.JSX.Element {
  const names = usePeopleNames(ids);
  return <NamesContext.Provider value={names}>{children}</NamesContext.Provider>;
}

export function usePersonName(userId: string | null | undefined): string | null {
  const names = useContext(NamesContext);
  return userId ? (names.get(userId.trim().toLowerCase()) ?? null) : null;
}

export function PersonRef({
  userId,
  display,
}: Readonly<{ userId: string; display?: string }>): React.JSX.Element {
  const name = usePersonName(userId);
  const id = <bdi dir="ltr">{display ?? userId}</bdi>;
  if (!name) return id;
  return (
    <span className="person-ref">
      <bdi className="person-ref__name">{name}</bdi>
      <span className="person-ref__id">{id}</span>
    </span>
  );
}
