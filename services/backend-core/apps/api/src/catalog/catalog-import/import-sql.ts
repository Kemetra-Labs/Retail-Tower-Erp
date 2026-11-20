/**
 * RT-1507: SQL text shared by the import's repositories. The stale re-check and the preview hash compare the matched
 * product's `updated_at` as text, so every read of it must format it the same way.
 */

/** A `timestamptz` column as a UTC ISO instant with microseconds, the text validate stores and the preview hash reads. */
export function isoOf(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
