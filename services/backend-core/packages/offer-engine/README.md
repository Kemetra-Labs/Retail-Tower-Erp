# @data-pulse-2/offer-engine

The one Offer Engine money evaluator (spec 048 §6 and §9, Jira RT-1378). Backend-Core (preview simulation, capture's
server-side re-evaluation, return settlement) and the POS till both import it, so a discount rule is changed in one place.

- `evaluateOffer`: the buy X get Y percent off the cheapest evaluation.
- `settleOfferReturn`: the multi-return clawback arithmetic.
- `offer-decimal`: exact-decimal helpers (`bigint`, no float).

## Rules

- **Pure.** No I/O, no clock, no database, no Electron, no UI, no runtime dependency. Anything that needs one belongs in a product.
- **Not a general shared library.** This is the one exception to "no shared runtime package across products"
  (`ARCHITECTURE.md`, Release model). Product-specific offer code stays in its product: the POS cart and receipt types, and
  Backend-Core's `offer-return-allocation.ts` and `offer-return-history.ts`.
- **One copy of the golden vectors**: `../contracts/fixtures/offers/golden-vectors.json`. Backend-Core's specs
  (`apps/api/test/offers/`) and the POS test `src/main/offers/__tests__/offer-engine.golden.test.ts` run them through this package.
- **Tests live in the consumers**, so no CI lane needs a new step: Backend-Core's api Jest runs the package from source
  (`moduleNameMapper` in `apps/api/jest.config.cjs`), including `offer-engine-decimal.unit.spec.ts` and
  `offer-engine-return-settlement.unit.spec.ts`.

## Build

CommonJS, compiled with `tsc` to `dist/` (like the other workspace packages). Its `tsconfig.json` extends
`services/backend-core/tsconfig.base.json`, and a change to that file selects the POS jobs (`graph.yaml` tier `offer-engine`).

- Backend-Core: `pnpm -r run build` (the Dockerfile and CI already do this).
- POS (npm): `npm run build:offer-engine`, run for you by `pretest`, `pretypecheck`, `prelint` and `prebuild:main`
  (`npm ci --ignore-scripts` skips lifecycle scripts, so the build is not a `postinstall`). The POS depends on it with a
  `file:` link, so a fresh checkout needs `npm install` in `apps/pos` once.
