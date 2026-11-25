### Added
- RT-1600 `[GATED: migration, contract]` (Implementation, owner-authorized): the W9 slice A runtime of the store
  redistribution proposals, serving every operation of `inventory/redistribution-proposals.yaml` (RT-1599) under
  `/api/inventory/v1/redistribution-proposals`. A compute reads the RT-1597 W3 ports and each store's device
  freshness, runs the RT-1598 engine and its independent validator, and stores a proposal (24-hour expiry, read on
  demand) with its read times, exclusions and warnings; every compute supersedes the tenant's live proposal. Shadow
  review records "would accept" / "would reject" per line; a live accept re-checks every line in one transaction,
  drops or reduces it with a reason and creates W3 draft Transfers only (never approves, reserves or posts). Migration
  `0134_redistribution_proposals` (two tables, RLS ENABLE + FORCE, composite tenant keys) with its deploy step
  `docs/operations/sql/redistribution-proposals-domain-grants.sql`. Dark by default: owner and tenant_admin of a tenant
  on `REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST` or `REDISTRIBUTION_LIVE_TENANT_ALLOWLIST` only (accept also needs W3
  shipment transfers on); every other caller gets the non-disclosing 404.
