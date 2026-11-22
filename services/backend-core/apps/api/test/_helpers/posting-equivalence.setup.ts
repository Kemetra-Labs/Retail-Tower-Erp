/**
 * RT-1463 — the before/after guard for the posting read-port refactor (owner request, RT-1463 comments 18315, 18321).
 *
 * The refactor splits SQL joins of the ERP posting reads into a sales read and an ERP read merged in TypeScript. A
 * wrong merge would post wrong amounts to ERPNext with no error. So every spec that calls one of the guarded reads on
 * a REAL database client also runs its frozen pre-refactor copy (`test/catalog/erpnext-posting/__support__/legacy/`)
 * on the same client in the same transaction, and fails when the two differ: the result (deep and strict, so order,
 * nulls and duplicates count) or the thrown error (class name and message). Guarded reads (all read-only, so running
 * them twice changes nothing):
 *   - `buildWorkItem` (posting-work-item.projection.ts): the work item sent to ERPNext;
 *   - `allSaleLinesMapped` (erpnext-reconciliation/sale-lines-mapped.ts): the repair eligibility check.
 * The two statements that write or need one snapshot are pinned by text instead (`posting-sql-frozen.unit.spec.ts`).
 *
 * Unit specs that pass a hand-written fake client (canned rows per call) are left alone: running the legacy copy would
 * consume their canned results. A client counts as real when it is a `pg` client (it has `connectionParameters`).
 *
 * `globalThis.__rt1463PostingCompared` counts the comparisons made in the current spec file (see
 * `posting-equivalence.assert.ts`). Delete this file, its `setupFilesAfterEnv` entry and the legacy copies once
 * RT-1463 is closed.
 */
type MockOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

/** What a developer whose PR deliberately changes one of the guarded reads must do (shown on every mismatch). */
const MOCK_HOW_TO_FIX =
  "RT-1463 posting equivalence guard: the live result differs from the frozen pre-refactor copy. " +
  "If RT-1463's refactor caused this, the refactor changed behaviour: fix the refactor. " +
  "If your PR deliberately changes this read's output, make the SAME change in its frozen copy under " +
  "apps/api/test/catalog/erpnext-posting/__support__/legacy/ in the same PR (see the README there). " +
  "The guard is removed when RT-1463 closes.";
(globalThis as { __rt1463HowToFix?: string }).__rt1463HowToFix = MOCK_HOW_TO_FIX;

(globalThis as { __rt1463PostingCompared?: number }).__rt1463PostingCompared = 0;

/** Builds a wrapper that runs `live` and `legacy` on the same real client and requires the same outcome. */
function mockCompared<A extends unknown[], R>(
  name: string,
  live: (...args: A) => Promise<R>,
  legacy: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const settle = async (run: () => Promise<R>): Promise<MockOutcome> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const describeError = (error: unknown): { name: string; message: string } =>
    error instanceof Error ? { name: error.constructor.name, message: error.message } : { name: typeof error, message: String(error) };
  return async (...args: A): Promise<R> => {
    const client = args[0];
    if (!(typeof client === "object" && client !== null && "connectionParameters" in client)) return live(...args);
    const now = await settle(() => live(...args));
    const before = await settle(() => legacy(...args));
    const g = globalThis as { __rt1463PostingCompared?: number };
    g.__rt1463PostingCompared = (g.__rt1463PostingCompared ?? 0) + 1;
    if (now.ok && before.ok) {
      try {
        expect(now.value).toStrictEqual(before.value);
      } catch (mismatch) {
        throw new Error(`${MOCK_HOW_TO_FIX}\n\nRead: ${name}\n${(mismatch as Error).message}`);
      }
      return now.value as R;
    }
    if (!now.ok && !before.ok) {
      try {
        expect(describeError(now.error)).toEqual(describeError(before.error));
      } catch (mismatch) {
        throw new Error(`${MOCK_HOW_TO_FIX}\n\nRead: ${name}\n${(mismatch as Error).message}`);
      }
      throw now.error;
    }
    throw new Error(
      `${MOCK_HOW_TO_FIX}\n\nRead: ${name} ${now.ok ? "returned" : "threw"} where the frozen copy ` +
        `${before.ok ? "returned" : "threw"}: ` +
        JSON.stringify({
          live: now.ok ? now.value : describeError(now.error),
          legacy: before.ok ? before.value : describeError(before.error),
        }),
    );
  };
}
(globalThis as { __rt1463MockCompared?: typeof mockCompared }).__rt1463MockCompared = mockCompared;

jest.mock("../../src/catalog/erpnext-posting/posting-work-item.projection", () => {
  type P = typeof import("../../src/catalog/erpnext-posting/posting-work-item.projection");
  const mockLive: P = jest.requireActual("../../src/catalog/erpnext-posting/posting-work-item.projection");
  const mockLegacy: P = jest.requireActual("../catalog/erpnext-posting/__support__/legacy/posting-work-item.projection");
  const mockWrap = (globalThis as { __rt1463MockCompared?: typeof mockCompared }).__rt1463MockCompared!;
  return { ...mockLive, buildWorkItem: mockWrap("buildWorkItem", mockLive.buildWorkItem, mockLegacy.buildWorkItem) };
});

jest.mock("../../src/catalog/erpnext-reconciliation/sale-lines-mapped", () => {
  type M = typeof import("../../src/catalog/erpnext-reconciliation/sale-lines-mapped");
  const mockLive: M = jest.requireActual("../../src/catalog/erpnext-reconciliation/sale-lines-mapped");
  const mockLegacy: M = jest.requireActual("../catalog/erpnext-posting/__support__/legacy/sale-lines-mapped");
  const mockWrap = (globalThis as { __rt1463MockCompared?: typeof mockCompared }).__rt1463MockCompared!;
  return { ...mockLive, allSaleLinesMapped: mockWrap("allSaleLinesMapped", mockLive.allSaleLinesMapped, mockLegacy.allSaleLinesMapped) };
});
