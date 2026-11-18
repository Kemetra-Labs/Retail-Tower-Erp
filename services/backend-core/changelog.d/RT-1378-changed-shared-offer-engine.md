### Changed
- RT-1378 `[GATED: deps/lockfile, tools/project-graph]`, owner decision 2026-11-13: the Offer Engine money evaluator is one
  shared package, `@data-pulse-2/offer-engine` (`packages/offer-engine`), that Backend-Core and the POS till both import. The
  two in-product evaluator copies (`offers/evaluator/offer-evaluator.ts`, `offer-decimal.ts`, `offer-return-settlement.ts`
  here; `src/shared/offers/*` in the POS) are deleted, and the golden-vector file has one copy. No behaviour change: the two
  copies were checked equal on 20000 random carts and 5099 random return settlements before the move; only the text of three
  internal error messages now follows the POS wording.
