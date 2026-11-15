### Added
- RT-1421 `[GATED: OpenAPI]`, owner authorization 2026-11-16 (Inventory Gate 6 / RT-292,
  Confluence 78938114 G6-6 and G6-9): `erpnext-connector/posting-feed.yaml` 1.14.0-draft reserves
  the work-item kind `inventory_count` with unreferenced, strict, flat schemas `CountWorkItem`,
  `CountPosting`, `CountPostingLine`, `CountRefusal`, `CountLineOutcome` and `CountPostingOutcome`.
  The wire is unchanged: `PostingWorkItem.kind` keeps `sale_post | reversal`, and Backend-Core must
  not emit the kind until the Connector accepts it (RT-1422, then RT-1423). Typed `oneOf` was
  rejected by the feasibility check (`contracts/check` enum pointer, Connector `wire["sale"]` read);
  the owner-approved flat fallback is used. Wire examples:
  `packages/contracts/fixtures/count-posting-feed/examples.json`.
