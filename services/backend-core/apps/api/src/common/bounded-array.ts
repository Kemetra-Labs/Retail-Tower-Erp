/**
 * bounded-array.ts — RT-1051: a request array whose length is checked before
 * any of its elements (zod GHSA-mrhx-c7xc-m3w5).
 *
 * zod 3 `z.array(item).max(n)` records the `too_big` issue and then still
 * validates every element, so an oversized array of failing elements builds
 * one issue per element and can exhaust memory. Here the length is checked
 * first over `z.unknown()` elements, and a too-long array is a FATAL issue:
 * the parse aborts, so neither `array` nor any object-level refinement of the
 * parent ever sees the unvalidated elements (a non-fatal issue would leave the
 * parent dirty and still run its `superRefine` on them). Mirror `max` as the
 * contract's `maxItems`.
 */
import { z, type ZodTypeAny } from "zod";

export function boundedArray<T extends ZodTypeAny>(max: number, array: T) {
  return z
    .array(z.unknown())
    .superRefine((items, ctx) => {
      if (items.length > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: max,
          type: "array",
          inclusive: true,
          exact: false,
          fatal: true,
          message: `Array must contain at most ${max} element(s)`,
        });
      }
    })
    .pipe(array);
}
