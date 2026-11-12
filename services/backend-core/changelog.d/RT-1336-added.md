### Added
- RT-1336 `[GATED: migration]`, owner authorization relayed from the RT-286 coordinating
  session (2026-11-11): the Offer Engine V1 schema (RT-286 spec 048 slice S3), persisting
  what the RT-1335 contracts expose. `0100_sale_lines_promotion_key_idx` builds the
  `sale_lines (id, sale_id, tenant_id, store_id)` unique key CONCURRENTLY (one statement).
  `0101_offer_engine` adds ten FORCE ROW LEVEL SECURITY tables with tenant policies and no
  DELETE policy: `offers` (identity, the JSONB draft with a never-reused draft revision, end
  and archive recorded once), `offer_versions` with `offer_version_stores` and
  `offer_version_rules` (numbered per offer, immutable once published for every role, the
  scope and rules written in the version's own transaction and checked whole at COMMIT;
  include / exclude rules by product, category or brand with same-tenant composite FKs),
  `offer_pauses` (whole-offer and per-store, resumed once), `offer_pack_revisions`
  (tenant-wide, gapless, append-only) and `offer_pack_store_revisions` (per-store applied
  revision, only forward), `offer_pack_eligible_products` (the materialised eligible sets as
  per-store revision ranges, history frozen, and an EXCLUDE constraint for the OD-7 Pack
  invariant: a product in at most one offer per store in any revision),
  `sale_line_promotions` (append-only, composite FK to the sale line, line arithmetic
  checked) and `sale_return_promotion_clawbacks` (append-only, one per return and offer).
  Adds `tenant_product_categories (id, tenant_id)` as a composite FK target, the
  `offer-engine-domain-grants.sql` deploy script and its grant fragment, and a down migration
  that refuses while any offer or Pack revision exists. No runtime or contract change (S4 is
  RT-1337).
