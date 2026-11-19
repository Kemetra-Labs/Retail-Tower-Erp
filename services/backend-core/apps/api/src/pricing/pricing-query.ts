/**
 * RT-1484 — query-parameter rules shared by the pricing read surfaces (`price-structure.yaml`,
 * `price-inquiry.yaml`): an RFC 3339 instant with an offset, and an `as_of_revision`.
 */
import { z } from "zod";

const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;

/** RFC 3339 with an offset, and a real calendar instant (Postgres refuses "02-31", JS rolls it over). */
export function isRfc3339Instant(value: string): boolean {
  const m = AT_PATTERN.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number, number, number, number, number, number,
  ];
  const offsetOk = m[8] === "Z" || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetOk
  );
}

export const AtSchema = z.string().refine(isRfc3339Instant, "must be an RFC 3339 date-time with an offset");

// int64 >= 1, kept within the JS safe range so the response can carry it as a number.
export const AsOfRevisionSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/, "must be a positive integer")
  .transform((v) => Number(v));
