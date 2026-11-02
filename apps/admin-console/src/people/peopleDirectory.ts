/**
 * RT-1070 people directory, pure part: which ids a screen asks for. The server
 * answers 1 to 200 canonical UUIDs per call, once each, so ids are trimmed,
 * lower-cased (the contract compares lower-cased), de-duplicated, kept only if
 * they are UUIDs (a malformed element would fail the whole call with a 400) and
 * split into batches of at most `MAX_PEOPLE_IDS`.
 */
export const MAX_PEOPLE_IDS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizePeopleIds(ids: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw?.trim().toLowerCase();
    if (id && UUID.test(id)) seen.add(id);
  }
  return [...seen].sort();
}

export function chunkPeopleIds(ids: readonly string[], size = MAX_PEOPLE_IDS): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** A name worth showing: non-blank text; anything else falls back to the id. */
export function usableName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}
