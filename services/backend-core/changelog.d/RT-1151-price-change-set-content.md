### Added
- RT-1151 `[GATED]`, owner authorization on RT-1151 (D1, D5(a), 2026-11-19; the #718 review
  redesign approved by the owner the same day): migration `0123_price_change_set_items_lines`
  (RT-282 PR-05), the Price Change Set content tables. `price_change_set_item_lists` and
  `price_change_set_items` keep every authored item list (an empty one too), each sealed to the
  transaction that wrote it. `price_change_set_validations` keeps every validation with its stored
  Impact Preview (summary, target Stores with time zones, hashes, sensitivity), and
  `price_change_set_preview_lines` / `price_change_set_preview_memberships` its per-Store rows.
  `price_change_set_lines` holds the materialized lines, immutable except the publish record
  (`new_event_id`, `result_ids`, set once; spec 042 §10). A `change_sets` trigger lets a set leave
  draft only with the validation it carries, and makes every return to draft a new version. All
  FORCE RLS, with `docs/operations/sql/price-change-set-content-domain-grants.sql`. No runtime
  uses the tables until RT-1484.
