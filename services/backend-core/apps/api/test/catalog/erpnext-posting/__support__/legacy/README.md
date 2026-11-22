# RT-1463 frozen references (temporary)

These files are frozen copies of code as it was before the RT-1463 catalog split refactor. The guard in
`apps/api/test/_helpers/posting-equivalence.setup.ts` runs each copy next to the live code, on the same real Postgres
client, in every api spec that calls the guarded read. Any difference in the result or the thrown error fails the spec.
`posting-sql-frozen.unit.spec.ts` and `erp-catalog-sql-frozen.unit.spec.ts` pin the exact text of the statements
that must stay one statement.

## If your PR fails this guard

- **You are working on RT-1463** and the refactor changed behaviour: fix the refactor, not the copy.
- **Your PR deliberately changes what one of these reads returns** (a new posting field, a new hold, a different sale
  history value): make the same change in the matching frozen copy here, in the same PR. For a pinned statement,
  update the frozen text in `frozen-sql.ts` or `frozen-catalog-sql.ts` to the new SQL. Say so in the PR
  description and in a comment on RT-1463, so the RT-1463 PR in flight can rebase onto it.

| Frozen copy | Live code | Guarded by |
|---|---|---|
| `posting-work-item.projection.ts`, `return-promotion-shares.ts` | `buildWorkItem` | equivalence guard |
| `sale-lines-mapped.ts` | `allSaleLinesMapped` | equivalence guard |
| `frozen-sql.ts` | the feed page query, the operator resolution freeze | `posting-sql-frozen.unit.spec.ts` |

Later RT-1463 PRs add copies for sale history, capture tracking and the catalog-fragment statements; each adds its row.

## When this goes away

The last RT-1463 PR deletes this directory, the setup entry in `jest.config.cjs` and the frozen-SQL specs.
