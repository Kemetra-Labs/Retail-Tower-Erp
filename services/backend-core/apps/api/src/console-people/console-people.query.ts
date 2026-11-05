/**
 * RT-1063 — request schema of the console people-name read
 * (`console-people.openapi.yaml`, RT-968).
 *
 * `ids` is REQUIRED: a comma-separated list of 1 to 200 `users.id` values.
 * The bounds are checked in this order, each before the next step parses
 * anything (the RT-1051 rule: bound the array, then validate its elements):
 *
 *   1. `ids` is one string (absent, or given more than once, is a 400);
 *   2. its raw length is at most 7,399 characters (200 UUIDs, 199 commas);
 *   3. it is not empty and splits into at most 200 elements;
 *   4. every element is a canonical 8-4-4-4-12 UUID, any case.
 *
 * Each refusal adds ONE issue and stops, so an oversized or hostile value
 * never builds one issue per element, and no issue echoes an id. Any other
 * query key is a 400 (`.strict()`). Every refusal is a 400
 * `validation_error`, raised after the guards and before any read.
 *
 * The parsed ids are lower-cased and de-duplicated (a repeated id is
 * answered once).
 */
import { z } from "zod";
import { UUID_RE_I } from "../common/ids";

/** At most this many ids per request (contract `maxItems`). */
export const PEOPLE_IDS_MAX = 200;

/** The longest raw `ids` value: 200 canonical UUIDs and 199 commas. */
export const PEOPLE_IDS_MAX_LENGTH = PEOPLE_IDS_MAX * 36 + (PEOPLE_IDS_MAX - 1);


function refuse(ctx: z.RefinementCtx, message: string): typeof z.NEVER {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, fatal: true });
  return z.NEVER;
}

/** `ids` → its distinct ids, lower-cased, in request order. */
export const PeopleIdsSchema = z.unknown().transform((value, ctx): string[] => {
  if (typeof value !== "string") return refuse(ctx, "ids must be given once, as a comma-separated list");
  if (value.length > PEOPLE_IDS_MAX_LENGTH) {
    return refuse(ctx, `ids must be at most ${PEOPLE_IDS_MAX_LENGTH} characters`);
  }
  if (value.length === 0) return refuse(ctx, "ids must name at least one id");
  const parts = value.split(",");
  if (parts.length > PEOPLE_IDS_MAX) return refuse(ctx, `ids must name at most ${PEOPLE_IDS_MAX} ids`);
  if (!parts.every((p) => UUID_RE_I.test(p))) return refuse(ctx, "every id must be a UUID");
  return [...new Set(parts.map((p) => p.toLowerCase()))];
});

export const ListPeopleNamesQuerySchema = z.object({ ids: PeopleIdsSchema }).strict();

export type ListPeopleNamesQuery = z.infer<typeof ListPeopleNamesQuerySchema>;
