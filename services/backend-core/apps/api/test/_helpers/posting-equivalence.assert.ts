/**
 * RT-1463: proof that the posting equivalence guard (`posting-equivalence.setup.ts`) really compared live and frozen
 * results in a spec file. Call `describePostingGuardCompared()` LAST in a real-database posting spec, so it runs after
 * the spec's own tests. When the spec skipped itself because Docker is unavailable (`MIGRATION_TEST_ALLOW_SKIP=1`,
 * never set in CI) and compared nothing, the check passes vacuously.
 */

/** Comparisons made by the guard in the current spec file so far. */
export function postingGuardComparisons(): number {
  return (globalThis as { __rt1463PostingCompared?: number }).__rt1463PostingCompared ?? 0;
}

export function describePostingGuardCompared(): void {
  describe("RT-1463 posting equivalence guard", () => {
    it("compared at least one real result against the frozen pre-refactor copy", () => {
      const compared = postingGuardComparisons();
      if (compared === 0 && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
      expect(compared).toBeGreaterThan(0);
    });
  });
}
